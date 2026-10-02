import { eventStreamFor } from '@dorkar/contracts';
import type { Redis } from 'ioredis';
import { sql, type Kysely } from 'kysely';
import type pg from 'pg';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { KernelTables } from './db/database';
import type { Logger } from './logger';

/**
 * Prometheus metrics for one service process (one registry per process; every series carries
 * the `service` label). Served by `GET /metrics` when `METRICS_TOKEN` is set.
 *
 * Label values are always bounded: route *templates* (never raw URLs), event types and job names
 * defined in code, a fixed set of outcomes. Never put ids, users or free text in a label.
 *
 * State that lives elsewhere (outbox backlog, consumer-group lag, pool usage) is read at scrape
 * time, behind a short cache so frequent or concurrent scrapes cannot load Postgres or Redis.
 */
export interface MetricsOptions {
  service: string;
  /** Node process metrics (CPU, memory, event-loop lag, GC). Default true. */
  defaultMetrics?: boolean;
  /** How long scrape-time readings (outbox, consumer lag) are reused. Default 5 s. */
  cacheMs?: number;
  logger?: Logger;
}

export type EventOutcome = 'processed' | 'duplicate' | 'failed' | 'dead_lettered';
export type JobOutcome = 'succeeded' | 'failed' | 'skipped';

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const SAFE_LABEL = /^[A-Za-z0-9_.:/*-]{1,96}$/;
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Clamps a code-defined label value (type, job, scope) so a bug cannot explode cardinality. */
export const boundedLabel = (v: string | undefined): string =>
  v && SAFE_LABEL.test(v) ? v : 'other';

/** Reuses a reading for `ttlMs`; concurrent scrapes share one in-flight load; errors keep the last value. */
function cached<T>(ttlMs: number, load: () => Promise<T>, onError: (err: unknown) => void) {
  let value: T | undefined;
  let at = 0;
  let inflight: Promise<T | undefined> | null = null;
  return (): Promise<T | undefined> => {
    if (Date.now() - at < ttlMs) return Promise.resolve(value);
    inflight ??= load()
      .then((v) => {
        value = v;
        return v;
      })
      .catch((err: unknown) => {
        onError(err);
        return value;
      })
      .finally(() => {
        at = Date.now();
        inflight = null;
      });
    return inflight;
  };
}

interface OutboxReading {
  unpublished: number;
  oldestAgeSeconds: number;
}
interface GroupReading {
  stream: string;
  lag: number | null;
  pending: number;
  deadLettered: number;
}

export class Metrics {
  readonly registry = new Registry();
  readonly service: string;

  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  readonly eventsPublished: Counter;
  readonly outboxPublishFailures: Counter;
  readonly eventsHandled: Counter<'type' | 'outcome'>;
  readonly eventHandleDuration: Histogram<'type'>;
  readonly jobRuns: Counter<'job' | 'outcome'>;
  readonly jobDuration: Histogram<'job'>;
  readonly rateLimitRejections: Counter<'route'>;
  readonly idempotencyReplays: Counter<'scope'>;

  private readonly cacheMs: number;
  private readonly logger: Logger | undefined;
  private readonly pools: pg.Pool[] = [];
  private outboxReaders: Array<() => Promise<OutboxReading | undefined>> = [];
  private groupReaders: Array<() => Promise<GroupReading | undefined>> = [];
  private poolGaugesRegistered = false;
  private outboxGaugesRegistered = false;
  private groupGaugesRegistered = false;

  constructor(opts: MetricsOptions) {
    this.service = opts.service;
    this.cacheMs = opts.cacheMs ?? 5_000;
    this.logger = opts.logger;
    this.registry.setDefaultLabels({ service: opts.service });
    if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });
    const registers = [this.registry];

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration by route template and status code.',
      labelNames: ['method', 'route', 'status_code'],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.eventsPublished = new Counter({
      name: 'events_published_total',
      help: 'Outbox events published to the event bus by the relay.',
      registers,
    });
    this.outboxPublishFailures = new Counter({
      name: 'outbox_publish_failures_total',
      help: 'Outbox relay batches that failed to publish.',
      registers,
    });
    this.eventsHandled = new Counter({
      name: 'events_handled_total',
      help: 'Consumed events by type and outcome (processed, duplicate, failed, dead_lettered).',
      labelNames: ['type', 'outcome'],
      registers,
    });
    this.eventHandleDuration = new Histogram({
      name: 'event_handle_duration_seconds',
      help: 'Event handler duration, including its inbox transaction.',
      labelNames: ['type'],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.jobRuns = new Counter({
      name: 'job_runs_total',
      help: 'Periodic job ticks by outcome (succeeded, failed, skipped = another instance held the lock).',
      labelNames: ['job', 'outcome'],
      registers,
    });
    this.jobDuration = new Histogram({
      name: 'job_duration_seconds',
      help: 'Periodic job duration (runs that acquired the lock).',
      labelNames: ['job'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60, 300],
      registers,
    });
    this.rateLimitRejections = new Counter({
      name: 'rate_limit_rejections_total',
      help: 'Requests rejected with 429 RATE_LIMITED, by route template.',
      labelNames: ['route'],
      registers,
    });
    this.idempotencyReplays = new Counter({
      name: 'idempotency_replays_total',
      help: 'Requests answered from a stored Idempotency-Key response.',
      labelNames: ['scope'],
      registers,
    });
  }

  /** Records one HTTP request. `route` must be the matched route template. */
  observeHttp(method: string, route: string | undefined, statusCode: number, seconds: number) {
    this.httpRequestDuration.observe(
      {
        method: HTTP_METHODS.has(method) ? method : 'OTHER',
        route: route ?? 'unmatched',
        status_code: String(statusCode),
      },
      seconds,
    );
  }

  /** `db_pool_*` gauges for a pg pool, read at scrape time. */
  observePool(pool: pg.Pool): void {
    this.pools.push(pool);
    if (this.poolGaugesRegistered) return;
    this.poolGaugesRegistered = true;
    const pools = this.pools;
    const gauge = (name: string, help: string, read: (p: pg.Pool) => number) =>
      new Gauge({
        name,
        help,
        registers: [this.registry],
        collect() {
          this.set(pools.reduce((n, p) => n + read(p), 0));
        },
      });
    gauge(
      'db_pool_connections_total',
      'Open connections in the Postgres pool.',
      (p) => p.totalCount,
    );
    gauge('db_pool_connections_idle', 'Idle connections in the Postgres pool.', (p) => p.idleCount);
    gauge(
      'db_pool_clients_waiting',
      'Queries waiting for a free pool connection.',
      (p) => p.waitingCount,
    );
  }

  /** `outbox_unpublished_count` and `outbox_oldest_unpublished_age_seconds` (cached query). */
  observeOutbox(db: Kysely<KernelTables>): void {
    this.outboxReaders.push(
      cached(
        this.cacheMs,
        async () => {
          // Served by the partial index outbox_unpublished_idx (rows with published_at null).
          const row = await db
            .selectFrom('outbox')
            .select([
              sql<string>`count(*)`.as('n'),
              sql<string | null>`extract(epoch from now() - min(occurred_at))`.as('age'),
            ])
            .where('published_at', 'is', null)
            .executeTakeFirst();
          return {
            unpublished: Number(row?.n ?? 0),
            oldestAgeSeconds: Math.max(0, Number(row?.age ?? 0)),
          };
        },
        (err) => this.logger?.warn({ err }, 'metrics: outbox reading failed'),
      ),
    );
    if (this.outboxGaugesRegistered) return;
    this.outboxGaugesRegistered = true;
    const readAll = async () =>
      (await Promise.all(this.outboxReaders.map((r) => r()))).flatMap((r) => (r ? [r] : []));
    new Gauge({
      name: 'outbox_unpublished_count',
      help: 'Committed events not yet published by the relay.',
      registers: [this.registry],
      async collect() {
        const rs = await readAll();
        if (rs.length) this.set(rs.reduce((n, r) => n + r.unpublished, 0));
      },
    });
    new Gauge({
      name: 'outbox_oldest_unpublished_age_seconds',
      help: 'Age of the oldest unpublished outbox event (0 when the outbox is drained).',
      registers: [this.registry],
      async collect() {
        const rs = await readAll();
        if (rs.length) this.set(Math.max(...rs.map((r) => r.oldestAgeSeconds)));
      },
    });
  }

  /**
   * `consumer_group_lag`, `consumer_group_pending` and `dead_letter_stream_length` for a consumed
   * stream (cached XINFO GROUPS / XLEN). `redis` must be an unprefixed connection that does not
   * issue blocking reads (not the consumer's own connection).
   */
  observeConsumerGroup(redis: Redis, producer: string, group: string, dlq: string): void {
    const stream = eventStreamFor(producer);
    this.groupReaders.push(
      cached(
        this.cacheMs,
        async (): Promise<GroupReading> => {
          const [groups, dead] = await Promise.all([
            (redis.xinfo('GROUPS', stream) as Promise<unknown[][]>).catch((err: unknown) => {
              if (err instanceof Error && err.message.includes('no such key')) return [];
              throw err;
            }),
            redis.xlen(dlq),
          ]);
          const info = groups.map((g) => toRecord(g)).find((g) => g['name'] === group);
          const lag = info?.['lag'];
          return {
            stream: producer,
            lag: typeof lag === 'number' ? lag : info ? null : 0,
            pending: typeof info?.['pending'] === 'number' ? info['pending'] : 0,
            deadLettered: dead,
          };
        },
        (err) => this.logger?.warn({ err, stream }, 'metrics: consumer group reading failed'),
      ),
    );
    if (this.groupGaugesRegistered) return;
    this.groupGaugesRegistered = true;
    const readAll = async () =>
      (await Promise.all(this.groupReaders.map((r) => r()))).flatMap((r) => (r ? [r] : []));
    new Gauge({
      name: 'consumer_group_lag',
      help: 'Entries in the stream not yet delivered to this service’s consumer group (XINFO GROUPS lag).',
      labelNames: ['stream'],
      registers: [this.registry],
      async collect() {
        for (const r of await readAll()) if (r.lag !== null) this.set({ stream: r.stream }, r.lag);
      },
    });
    new Gauge({
      name: 'consumer_group_pending',
      help: 'Entries delivered to the consumer group but not yet acknowledged.',
      labelNames: ['stream'],
      registers: [this.registry],
      async collect() {
        for (const r of await readAll()) this.set({ stream: r.stream }, r.pending);
      },
    });
    new Gauge({
      name: 'dead_letter_stream_length',
      help: 'Entries in this service’s dead-letter stream for a consumed stream.',
      labelNames: ['stream'],
      registers: [this.registry],
      async collect() {
        for (const r of await readAll()) this.set({ stream: r.stream }, r.deadLettered);
      },
    });
  }

  /** Stops reading external sources (on shutdown); the counters stay. */
  forgetSources(): void {
    this.pools.length = 0;
    this.outboxReaders = [];
    this.groupReaders = [];
  }

  /** Prometheus text exposition. */
  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}

function toRecord(flat: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}
