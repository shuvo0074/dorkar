import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eventStreamFor, IdentityEvents, type EventEnvelope } from '@dorkar/contracts';
import Fastify from 'fastify';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { uuidv7 } from '../src/crypto';
import type { KernelTables } from '../src/db/database';
import { kernelMigration, kernelOutboxTraceMigration } from '../src/db/kernel-migration';
import { Errors } from '../src/errors';
import { createInternalClient } from '../src/http/internal';
import { createHttpServer, ok } from '../src/http/server';
import {
  kernelIdempotencyMigration,
  requestFingerprint,
  withIdempotency,
  type IdempotencyTables,
} from '../src/idempotency';
import { startPeriodicJob } from '../src/jobs';
import { Metrics } from '../src/metrics';
import { appendToOutbox, createEventFactory } from '../src/outbox/outbox';
import { RedisStreamConsumer, deadLetterStreamFor } from '../src/outbox/redis-stream-consumer';
import { RedisStreamPublisher } from '../src/outbox/redis-stream-publisher';
import { OutboxRelay } from '../src/outbox/relay';
import { createRedis } from '../src/redis';
import { createServiceRuntime, serviceEnvSchema, type ServiceRuntime } from '../src/service';
import { loadConfig } from '../src/config';
import {
  captureLogger,
  envelope,
  startTestService,
  TEST_REDIS_URL,
  type TestService,
} from '../src/testing';
import { childTraceparent, parseTraceparent, runInScope, currentTraceparent } from '../src/trace';

type DB = KernelTables & IdempotencyTables;

const TOKEN = 'metrics-token-0123456789abcdef0123456789';
const TRACE = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const { logger } = captureLogger('silent');

/** prom-client's MetricValue type omits the per-series name of histogram values. */
const seriesName = (v: object) => (v as { metricName?: string }).metricName;

/** Current value of one series of a metric, or undefined when it has no such series. */
async function value(m: Metrics, name: string, labels: Record<string, string> = {}) {
  const metric = m.registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const { values } = await metric.get();
  return values.find((v) =>
    Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want),
  )?.value;
}

let t: TestService<{ runtime: ServiceRuntime<DB> }>;
const emitted: EventEnvelope[] = [];

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'kernelobs',
    migrations: [kernelMigration, kernelIdempotencyMigration, kernelOutboxTraceMigration],
    env: { METRICS_TOKEN: TOKEN },
    build: async (env, log, verifier) => {
      const runtime = await createServiceRuntime<DB>({
        config: loadConfig(serviceEnvSchema, env),
        logger: log,
        producer: 'kernelobs',
        openapi: { title: 'test' },
        verifier,
        idempotency: true,
      });
      runtime.app.get(
        '/items/:id',
        { schema: { params: z.object({ id: z.string() }) } },
        async (req) => ok({ id: req.params.id }),
      );
      runtime.app.get('/limited', async () => {
        throw Errors.rateLimited(1_000);
      });
      // The handler gets the trace both explicitly (req.ctx) and from the execution scope.
      runtime.app.post('/emit', { schema: { body: z.object({ n: z.number() }) } }, async (req) => {
        const id = randomUUID();
        const explicit = runtime.event(
          IdentityEvents.AccountCreated,
          id,
          { accountId: id },
          req.ctx,
        );
        const ambient = runtime.event(IdentityEvents.AccountCreated, id, { accountId: id });
        return ok({ ctx: req.ctx.traceparent, scope: currentTraceparent(), explicit, ambient });
      });
      runtime.app.post(
        '/charge',
        { preHandler: runtime.auth.authenticate, schema: { body: z.object({ n: z.number() }) } },
        async (req, reply) => {
          const r = await withIdempotency(
            runtime.db as unknown as Kysely<IdempotencyTables>,
            {
              actorId: req.ctx.actor!.id,
              scope: 'test:charge',
              key: req.headers['idempotency-key'] as string | undefined,
              fingerprint: requestFingerprint(req.body),
              required: true,
            },
            async () => ({ status: 201, body: { n: req.body.n } }),
          );
          return reply.status(r.status).send(ok(r.body));
        },
      );
      // A consumer that emits a follow-up event without passing any context.
      runtime.on(IdentityEvents.AccountCreated, async (p) => {
        emitted.push(runtime.event(IdentityEvents.AccountCreated, p.accountId, p));
      });
      return { runtime };
    },
  });
});
afterAll(() => t.close());

const scrape = (authorization?: string) =>
  t.svc.runtime.app.inject({
    url: '/metrics',
    headers: authorization ? { authorization } : {},
  });

describe('GET /metrics', () => {
  it('is absent (404) when no METRICS_TOKEN is configured', async () => {
    const app = await createHttpServer({
      config: {
        NODE_ENV: 'test',
        SERVICE_NAME: 'plain',
        SERVICE_VERSION: 't',
        TRUST_PROXY: false,
        CORS_ORIGINS: [],
      },
      logger,
      ipHashKey: 'k'.repeat(32),
      readiness: [],
      metrics: new Metrics({ service: 'plain', defaultMetrics: false }),
    });
    const res = await app.inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('requires the bearer token', async () => {
    expect((await scrape()).statusCode).toBe(401);
    expect((await scrape(`Bearer ${TOKEN}x`)).statusCode).toBe(401);
    expect((await scrape(`Bearer ${TOKEN.slice(1)}`)).statusCode).toBe(401);
    expect((await scrape(TOKEN)).statusCode).toBe(401);
  });

  it('serves the Prometheus exposition with the expected metric names', async () => {
    await t.svc.runtime.app.inject({ url: '/items/abc' });
    const res = await scrape(`Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    for (const name of [
      'process_cpu_user_seconds_total',
      'nodejs_eventloop_lag_seconds',
      'http_request_duration_seconds_bucket',
      'db_pool_connections_total',
      'db_pool_connections_idle',
      'db_pool_clients_waiting',
      'outbox_unpublished_count',
      'outbox_oldest_unpublished_age_seconds',
      'events_published_total',
      'outbox_publish_failures_total',
      'events_handled_total',
      'event_handle_duration_seconds',
      'job_runs_total',
      'job_duration_seconds',
      'rate_limit_rejections_total',
      'idempotency_replays_total',
    ]) {
      expect(res.body, name).toContain(name);
    }
    expect(res.body).toContain(`service="${t.svc.runtime.config.SERVICE_NAME}"`);
  });
});

describe('HTTP metrics', () => {
  it('labels requests with the route template, never the raw URL', async () => {
    const m = t.svc.runtime.metrics;
    const id = `x${randomBytes(4).toString('hex')}`;
    await t.svc.runtime.app.inject({ url: `/items/${id}` });
    await t.svc.runtime.app.inject({ url: `/nowhere/${id}` });
    const body = (await scrape(`Bearer ${TOKEN}`)).body;
    expect(body).not.toContain(id);
    expect(body).toMatch(
      /http_request_duration_seconds_count\{[^}]*method="GET"[^}]*route="\/items\/:id"[^}]*status_code="200"/,
    );
    const metric = await m.registry.getSingleMetric('http_request_duration_seconds')!.get();
    const count = (route: string, status: string) =>
      metric.values.find(
        (v) =>
          seriesName(v) === 'http_request_duration_seconds_count' &&
          v.labels['route'] === route &&
          v.labels['status_code'] === status,
      )?.value ?? 0;
    expect(count('/items/:id', '200')).toBeGreaterThanOrEqual(2);
    expect(count('unmatched', '404')).toBeGreaterThanOrEqual(1);
    // operational endpoints are not counted as traffic
    expect(metric.values.some((v) => v.labels['route'] === '/metrics')).toBe(false);
  });

  it('counts rate-limit rejections and idempotency replays', async () => {
    const m = t.svc.runtime.metrics;
    expect((await t.svc.runtime.app.inject({ url: '/limited' })).statusCode).toBe(429);
    expect(await value(m, 'rate_limit_rejections_total', { route: '/limited' })).toBe(1);

    const headers = { ...(await t.auth.as(randomUUID())), 'idempotency-key': 'obs-key-0001' };
    const charge = () =>
      t.svc.runtime.app.inject({ method: 'POST', url: '/charge', headers, payload: { n: 1 } });
    expect((await charge()).statusCode).toBe(201);
    expect(await value(m, 'idempotency_replays_total', { scope: 'test:charge' })).toBeUndefined();
    expect((await charge()).statusCode).toBe(201);
    expect((await charge()).statusCode).toBe(201);
    expect(await value(m, 'idempotency_replays_total', { scope: 'test:charge' })).toBe(2);
  });
});

describe('outbox metrics', () => {
  it('reports backlog size and oldest age, cached between scrapes', async () => {
    const db = t.svc.runtime.db as unknown as Kysely<KernelTables>;
    const fresh = new Metrics({ service: 's', defaultMetrics: false, cacheMs: 0 });
    fresh.observeOutbox(db);
    const cachedM = new Metrics({ service: 's', defaultMetrics: false, cacheMs: 60_000 });
    cachedM.observeOutbox(db);

    expect(await value(fresh, 'outbox_unpublished_count')).toBe(0);
    expect(await value(fresh, 'outbox_oldest_unpublished_age_seconds')).toBe(0);
    expect(await value(cachedM, 'outbox_unpublished_count')).toBe(0);

    const make = createEventFactory('kernelobs');
    const old = { ...make(IdentityEvents.AccountCreated, 'a', { accountId: randomUUID() }) };
    old.occurredAt = new Date(Date.now() - 120_000).toISOString();
    await appendToOutbox(db, [
      old,
      make(IdentityEvents.AccountCreated, 'b', { accountId: randomUUID() }),
    ]);

    expect(await value(fresh, 'outbox_unpublished_count')).toBe(2);
    expect(await value(fresh, 'outbox_oldest_unpublished_age_seconds')).toBeGreaterThanOrEqual(119);
    expect(await value(cachedM, 'outbox_unpublished_count')).toBe(0); // still the cached reading

    // the relay drains it and counts what it published
    const published: EventEnvelope[] = [];
    const relay = new OutboxRelay(
      db,
      { publish: async (es) => void published.push(...es) },
      logger,
      {
        producer: 'kernelobs',
        metrics: fresh,
      },
    );
    expect(await relay.tick()).toBe(2);
    expect(await value(fresh, 'events_published_total')).toBe(2);
    expect(await value(fresh, 'outbox_unpublished_count')).toBe(0);
    expect(await value(fresh, 'outbox_oldest_unpublished_age_seconds')).toBe(0);
  });

  it('reports pool usage', async () => {
    const m = t.svc.runtime.metrics;
    expect(await value(m, 'db_pool_connections_total')).toBeGreaterThanOrEqual(1);
    expect(await value(m, 'db_pool_clients_waiting')).toBe(0);
  });
});

describe('consumer metrics', () => {
  const bus = createRedis(TEST_REDIS_URL, { keyPrefix: null });
  const streams: string[] = [];
  afterAll(async () => {
    if (streams.length) await bus.del(...streams);
    bus.disconnect();
  });

  it('counts outcomes (processed, duplicate, failed, dead_lettered) and reports group lag', async () => {
    const producer = `kobs${randomBytes(4).toString('hex')}`;
    const group = 'g1';
    const dlq = deadLetterStreamFor(producer, group);
    streams.push(eventStreamFor(producer), dlq);
    const m = new Metrics({ service: 's', defaultMetrics: false, cacheMs: 0 });
    m.observeConsumerGroup(bus, producer, group, dlq);

    const behaviour = new Map<string, 'ok' | 'dup' | 'fail' | 'skip'>();
    const consumer = new RedisStreamConsumer(
      createRedis(TEST_REDIS_URL, { keyPrefix: null, commandTimeoutMs: null }),
      {
        producer,
        group,
        consumer: 'c1',
        logger,
        metrics: m,
        retryAfterMs: 1,
        maxDeliveries: 2,
        handler: async (e) => {
          const b = behaviour.get(e.aggregateId);
          if (b === 'fail') throw new Error('boom');
          if (b === 'dup') return 'duplicate';
          if (b === 'skip') return 'ignored';
        },
      },
    );
    await consumer.ensureGroup();

    const make = createEventFactory(producer);
    const events = (['ok', 'dup', 'fail', 'skip'] as const).map((b) => {
      const id = uuidv7();
      behaviour.set(id, b);
      return make(IdentityEvents.AccountCreated, id, { accountId: id });
    });
    await new RedisStreamPublisher(bus, producer).publish(events);
    await bus.xadd(
      eventStreamFor(producer),
      '*',
      'type',
      'identity.AccountCreated',
      'event',
      '{bad',
    );

    expect(await value(m, 'consumer_group_lag', { stream: producer })).toBe(5);
    await consumer.poll(10);
    expect(await value(m, 'consumer_group_lag', { stream: producer })).toBe(0);
    expect(await value(m, 'consumer_group_pending', { stream: producer })).toBe(1); // the failure

    const handled = (outcome: string) =>
      value(m, 'events_handled_total', { type: 'identity.AccountCreated', outcome });
    expect(await handled('processed')).toBe(1);
    expect(await handled('duplicate')).toBe(1);
    expect(await handled('failed')).toBe(1);
    expect(await handled('dead_lettered')).toBe(1); // the malformed entry
    expect(await value(m, 'dead_letter_stream_length', { stream: producer })).toBe(1);

    // retried once more (fails again), then dead-lettered after maxDeliveries
    await new Promise((r) => setTimeout(r, 5));
    await consumer.poll(10);
    await new Promise((r) => setTimeout(r, 5));
    await consumer.poll(10);
    expect(await handled('failed')).toBe(2);
    expect(await handled('dead_lettered')).toBe(2);
    expect(await value(m, 'dead_letter_stream_length', { stream: producer })).toBe(2);
    expect(await value(m, 'consumer_group_pending', { stream: producer })).toBe(0);
    const durations = await m.registry.getSingleMetric('event_handle_duration_seconds')!.get();
    expect(
      durations.values.find((v) => seriesName(v) === 'event_handle_duration_seconds_count')?.value,
    ).toBe(4); // processed + duplicate + 2 failures; ignored types are not measured
    await consumer.stop();
  });
});

describe('job metrics', () => {
  it('counts succeeded and failed runs and measures duration', async () => {
    const m = new Metrics({ service: 's', defaultMetrics: false });
    let fail = false;
    const name = `obs-job-${randomBytes(3).toString('hex')}`;
    const job = startPeriodicJob({
      name,
      intervalMs: 5,
      db: t.svc.runtime.db,
      logger,
      metrics: m,
      run: async (trx) => {
        await sql`select 1`.execute(trx);
        if (fail) throw new Error('job broke');
      },
    });
    await expect
      .poll(() => value(m, 'job_runs_total', { job: name, outcome: 'succeeded' }))
      .toBeGreaterThanOrEqual(1);
    fail = true;
    await expect
      .poll(() => value(m, 'job_runs_total', { job: name, outcome: 'failed' }))
      .toBeGreaterThanOrEqual(1);
    await job.stop();
    const d = await m.registry.getSingleMetric('job_duration_seconds')!.get();
    expect(
      d.values.some((v) => seriesName(v) === 'job_duration_seconds_count' && v.value >= 2),
    ).toBe(true);
  });
});

describe('trace context', () => {
  it('parses and continues W3C traceparent values', () => {
    expect(parseTraceparent(TRACE)).toEqual({
      traceId: TRACE_ID,
      spanId: '00f067aa0ba902b7',
      flags: '01',
    });
    for (const bad of [
      undefined,
      '',
      'garbage',
      `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
      `00-${TRACE_ID}-${'0'.repeat(16)}-01`,
      `ff-${TRACE_ID}-00f067aa0ba902b7-01`,
      TRACE.toUpperCase(),
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeNull();
    }
    const child = parseTraceparent(childTraceparent(TRACE))!;
    expect(child.traceId).toBe(TRACE_ID);
    expect(child.spanId).not.toBe('00f067aa0ba902b7');
    const root = parseTraceparent(childTraceparent('garbage'))!;
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.traceId).not.toBe(TRACE_ID);
  });

  it('continues the caller trace on HTTP and puts it on emitted events', async () => {
    const res = await t.svc.runtime.app.inject({
      method: 'POST',
      url: '/emit',
      headers: { traceparent: TRACE },
      payload: { n: 1 },
    });
    const { ctx, scope, explicit, ambient } = res.json().data;
    expect(parseTraceparent(ctx)!.traceId).toBe(TRACE_ID);
    expect(parseTraceparent(ctx)!.spanId).not.toBe('00f067aa0ba902b7');
    expect(scope).toBe(ctx);
    expect(explicit.traceparent).toBe(ctx);
    expect(ambient.traceparent).toBe(ctx);
    // logged with the trace id
    expect(
      t.logLines.some((l) => l.includes('"traceId":"' + TRACE_ID) && l.includes('/emit')),
    ).toBe(true);
  });

  it('starts a trace when the request carries none', async () => {
    const res = await t.svc.runtime.app.inject({ method: 'POST', url: '/emit', payload: { n: 1 } });
    expect(parseTraceparent(res.json().data.ctx)).not.toBeNull();
  });

  it('stores the trace in the outbox and the relay publishes it', async () => {
    const db = t.svc.runtime.db as unknown as Kysely<KernelTables>;
    const id = randomUUID();
    const e = t.svc.runtime.event(
      IdentityEvents.AccountCreated,
      id,
      { accountId: id },
      { requestId: 'r-12345678', correlationId: 'c-12345678', traceparent: TRACE },
    );
    expect(e.traceparent).toBe(TRACE);
    await appendToOutbox(db, e);
    const published: EventEnvelope[] = [];
    await new OutboxRelay(db, { publish: async (es) => void published.push(...es) }, logger, {
      producer: 'kernelobs',
    }).tick();
    expect(published.find((p) => p.id === e.id)?.traceparent).toBe(TRACE);
  });

  it('continues the producer trace in consumers, including events they emit', async () => {
    const e = {
      ...envelope(IdentityEvents.AccountCreated, { accountId: randomUUID() }),
      traceparent: TRACE,
    };
    emitted.length = 0;
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    const next = parseTraceparent(emitted[0]?.traceparent)!;
    expect(next.traceId).toBe(TRACE_ID);
    expect(next.spanId).not.toBe('00f067aa0ba902b7');

    // an event without (or with a malformed) trace starts a new one
    emitted.length = 0;
    await t.svc.runtime.deliver({
      ...envelope(IdentityEvents.AccountCreated, { accountId: randomUUID() }),
      traceparent: 'nonsense',
    });
    expect(parseTraceparent(emitted[0]?.traceparent)?.traceId).not.toBe(TRACE_ID);
  });

  describe('internal client', () => {
    const seen: Array<string | undefined> = [];
    const upstream = Fastify();
    let call: ReturnType<typeof createInternalClient>;
    beforeAll(async () => {
      upstream.get('/internal/v1/x', async (req) => {
        seen.push(req.headers['traceparent'] as string | undefined);
        return { ok: true };
      });
      await upstream.listen({ host: '127.0.0.1', port: 0 });
      call = createInternalClient({
        baseUrl: `http://127.0.0.1:${(upstream.server.address() as AddressInfo).port}`,
        token: 't'.repeat(32),
      });
    });
    afterAll(() => upstream.close());

    it('sends traceparent from ctx, else from the execution scope', async () => {
      const other = childTraceparent();
      await call('/internal/v1/x', {
        ctx: { requestId: 'r-12345678', correlationId: 'c-12345678', traceparent: TRACE },
      });
      await runInScope({ traceparent: other }, () => call('/internal/v1/x'));
      await call('/internal/v1/x');
      expect(seen).toEqual([TRACE, other, undefined]);
    });
  });
});
