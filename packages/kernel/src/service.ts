import { hostname } from 'node:os';
import type { EventEnvelope } from '@dorkar/contracts';
import { createRemoteJWKSet } from 'jose';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { baseEnvSchema, metricsTokenSchema } from './config';
import { createDatabase, type Database, type KernelTables } from './db/database';
import { handleOnce } from './db/inbox';
import { migrationStatus, type Migration } from './db/migrator';
import { createAuthenticator, createJwtVerifier, type AccessTokenVerifier } from './http/auth';
import { requireInternal } from './http/internal';
import { createHttpServer, type App } from './http/server';
import { purgeExpiredIdempotencyKeys, type IdempotencyTables } from './idempotency';
import { startPeriodicJob, type PeriodicJob } from './jobs';
import { runService } from './lifecycle';
import type { Logger } from './logger';
import { Metrics } from './metrics';
import { createEventFactory, type EventDefinition } from './outbox/outbox';
import {
  deadLetterStreamFor,
  RedisStreamConsumer,
  type HandleOutcome,
} from './outbox/redis-stream-consumer';
import { RedisStreamPublisher } from './outbox/redis-stream-publisher';
import { OutboxRelay } from './outbox/relay';
import { createRedis, type Redis } from './redis';
import { childTraceparent, runInScope, traceIdOf } from './trace';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/** Environment every marketplace service shares on top of the base. */
export const serviceEnvSchema = baseEnvSchema.extend({
  JWKS_URL: z.url(),
  JWT_ISSUER: z.string().default('dorkar-identity'),
  JWT_AUDIENCE: z.string().default('dorkar-api'),
  /** Shared secret for /internal/v1 calls between services. */
  INTERNAL_API_TOKEN: z.string().min(32),
  /** Keyed hash for client IPs in logs and audit records. */
  PII_HASH_KEY: z.string().min(32),
  OUTBOX_RELAY_ENABLED: bool.default(true),
  CONSUMERS_ENABLED: bool.default(true),
  JOBS_ENABLED: bool.default(true),
  METRICS_TOKEN: metricsTokenSchema,
});
export type ServiceConfig = z.infer<typeof serviceEnvSchema>;

type Handler<DB> = (payload: never, event: EventEnvelope, trx: Transaction<DB>) => Promise<void>;

export interface ServiceRuntime<DB extends KernelTables> {
  config: ServiceConfig;
  logger: Logger;
  app: App;
  /** Process metrics registry, served on `/metrics` when METRICS_TOKEN is set. */
  metrics: Metrics;
  database: Database<DB>;
  db: Kysely<DB>;
  /** Service-private keys (rate limits, caches). */
  redis: Redis;
  /** Unprefixed connection for the shared event bus. */
  bus: Redis;
  auth: ReturnType<typeof createAuthenticator>;
  /** preHandler for /internal/v1 routes. */
  internalOnly: ReturnType<typeof requireInternal>;
  /** Builds validated events for this producer; append them with `appendToOutbox(trx, …)`. */
  event: ReturnType<typeof createEventFactory>;
  /**
   * Subscribe to another service's event. The handler runs inside a transaction together with
   * the inbox record, so each event takes effect exactly once.
   */
  on<S extends z.ZodType>(
    def: EventDefinition<S>,
    handler: (payload: z.output<S>, event: EventEnvelope, trx: Transaction<DB>) => Promise<void>,
    opts?: {
      /**
       * Streams to read this type from. Defaults to the type's prefix (`demand.X` → `demand`).
       * Needed for types every service emits, e.g. `audit.ActivityRecorded`.
       */
      producers?: readonly string[];
    },
  ): void;
  /** Run the registered handler for an envelope directly (tests, replays). Returns false if already processed. */
  deliver(event: EventEnvelope): Promise<boolean>;
  /** Cluster-wide single-runner periodic job. */
  every(
    name: string,
    intervalMs: number,
    run: (trx: Transaction<DB>) => Promise<number | void>,
  ): void;
  startWorkers(): Promise<void>;
  stopWorkers(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  config: ServiceConfig;
  logger: Logger;
  /** Event producer name, e.g. 'demand' — also the stream this service publishes to. */
  producer: string;
  openapi: { title: string; description?: string };
  /** Tests inject a local verifier instead of fetching the JWKS. */
  verifier?: AccessTokenVerifier;
  /** Purge expired Idempotency-Key rows (service uses kernelIdempotencyMigration). */
  idempotency?: boolean;
}

export async function createServiceRuntime<DB extends KernelTables>(
  opts: RuntimeOptions,
): Promise<ServiceRuntime<DB>> {
  const { config, logger } = opts;
  const database = createDatabase<DB>(config);
  const redis = createRedis(config.REDIS_URL, { keyPrefix: opts.producer, logger });
  const bus = createRedis(config.REDIS_URL, { keyPrefix: null, logger });
  const metrics = new Metrics({
    service: config.SERVICE_NAME,
    // Process metrics start a sampler; skip it when nobody can scrape.
    defaultMetrics: Boolean(config.METRICS_TOKEN),
    logger,
  });
  metrics.observePool(database.pool);
  metrics.observeOutbox(database.db as unknown as Kysely<KernelTables>);

  const verifier =
    opts.verifier ??
    createJwtVerifier({
      key: createRemoteJWKSet(new URL(config.JWKS_URL), {
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      }),
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });

  const app = await createHttpServer({
    config,
    logger,
    ipHashKey: config.PII_HASH_KEY,
    readiness: [
      { name: 'postgres', check: () => database.ping() },
      { name: 'redis', check: async () => void (await redis.ping()) },
    ],
    openapi: opts.openapi,
    metrics,
    metricsToken: config.METRICS_TOKEN,
  });

  const handlers = new Map<
    string,
    { producers: readonly string[]; parse: (p: unknown) => unknown; fn: Handler<DB> }
  >();
  const consumers: RedisStreamConsumer[] = [];
  const jobs: Array<{
    name: string;
    intervalMs: number;
    run: (trx: Transaction<DB>) => Promise<number | void>;
  }> = [];
  const running: PeriodicJob[] = [];

  const deliver = async (event: EventEnvelope): Promise<boolean> => {
    const h = handlers.get(event.type);
    if (!h) return false;
    const payload = h.parse(event.payload); // invalid payload throws → retried, then dead-lettered
    // The handler is a new span in the producer's trace; events it emits continue that trace.
    const traceparent = childTraceparent(event.traceparent);
    const handled = await runInScope({ traceparent, metrics }, () =>
      handleOnce(database.db, config.SERVICE_NAME, event, (trx) =>
        h.fn(payload as never, event, trx),
      ),
    );
    logger.debug(
      {
        eventId: event.id,
        type: event.type,
        correlationId: event.correlationId,
        traceId: traceIdOf(traceparent),
        duplicate: !handled,
      },
      'event handled',
    );
    return handled;
  };
  const consume = async (event: EventEnvelope): Promise<HandleOutcome> => {
    if (!handlers.has(event.type)) return 'ignored';
    return (await deliver(event)) ? 'processed' : 'duplicate';
  };
  const observedGroups = new Set<string>();

  if (opts.idempotency) {
    jobs.push({
      name: `${opts.producer}.purge-idempotency-keys`,
      intervalMs: 30 * 60_000,
      run: (trx) => purgeExpiredIdempotencyKeys(trx as unknown as Kysely<IdempotencyTables>),
    });
  }

  const relay = new OutboxRelay(
    database.db as unknown as Kysely<KernelTables>,
    new RedisStreamPublisher(bus, opts.producer),
    logger,
    { producer: opts.producer, metrics },
  );

  const stopWorkers = async () => {
    await relay.stop();
    await Promise.all(consumers.map((c) => c.stop()));
    consumers.length = 0;
    await Promise.all(running.map((j) => j.stop()));
    running.length = 0;
  };

  return {
    config,
    logger,
    app,
    metrics,
    database,
    db: database.db,
    redis,
    bus,
    auth: createAuthenticator({ verifier }),
    internalOnly: requireInternal(config.INTERNAL_API_TOKEN),
    event: createEventFactory(opts.producer),
    on(def, handler, onOpts) {
      handlers.set(def.type, {
        producers: onOpts?.producers ?? [def.type.split('.')[0]!],
        parse: (p) => def.schema.parse(p),
        fn: handler,
      });
    },
    deliver,
    every(name, intervalMs, run) {
      jobs.push({ name, intervalMs, run });
    },
    async startWorkers() {
      if (config.OUTBOX_RELAY_ENABLED) relay.start();
      if (config.CONSUMERS_ENABLED) {
        const producers = new Set([...handlers.values()].flatMap((h) => h.producers));
        for (const producer of producers) {
          const consumer = new RedisStreamConsumer(
            createRedis(config.REDIS_URL, { keyPrefix: null, commandTimeoutMs: null, logger }),
            {
              producer,
              group: config.SERVICE_NAME,
              consumer: `${hostname()}-${process.pid}`,
              logger,
              metrics,
              handler: consume,
            },
          );
          if (!observedGroups.has(producer)) {
            observedGroups.add(producer);
            metrics.observeConsumerGroup(
              bus,
              producer,
              config.SERVICE_NAME,
              deadLetterStreamFor(producer, config.SERVICE_NAME),
            );
          }
          await consumer.start();
          consumers.push(consumer);
        }
      }
      if (config.JOBS_ENABLED) {
        for (const j of jobs) {
          running.push(
            startPeriodicJob({
              name: j.name,
              intervalMs: j.intervalMs,
              db: database.db,
              logger,
              metrics,
              run: j.run,
            }),
          );
        }
      }
    },
    stopWorkers,
    async close() {
      await app.close();
      await stopWorkers();
      metrics.forgetSources();
      redis.disconnect();
      bus.disconnect();
      await database.close();
    },
  };
}

/**
 * Standard `main.ts` body: refuse to start on a stale schema (migrations run as a separate job),
 * start workers, serve with graceful shutdown.
 */
export async function runServiceMain<DB extends KernelTables>(
  rt: ServiceRuntime<DB>,
  migrations: readonly Migration[],
): Promise<void> {
  const pending = (
    await migrationStatus({ db: rt.database.root, schema: rt.config.DATABASE_SCHEMA, migrations })
  ).filter((m) => !m.appliedAt);
  if (pending.length) {
    rt.logger.fatal(
      { pending: pending.map((m) => m.name) },
      'database has pending migrations; run the migrate job',
    );
    process.exit(1);
  }
  await rt.startWorkers();
  await runService({
    app: rt.app,
    host: rt.config.HOST,
    port: rt.config.PORT,
    logger: rt.logger,
    graceMs: rt.config.SHUTDOWN_GRACE_MS,
    closers: [
      {
        name: 'redis',
        close: async () => {
          rt.redis.disconnect();
          rt.bus.disconnect();
        },
      },
      { name: 'postgres', close: () => rt.database.close() },
      { name: 'workers', close: () => rt.stopWorkers() },
    ],
  });
}
