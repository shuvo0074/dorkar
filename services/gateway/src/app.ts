import { hostname } from 'node:os';
import {
  createHttpServer,
  createJwtVerifier,
  createRedis,
  RedisRateLimiter,
  RedisStreamConsumer,
  type App,
  type Logger,
  type RateLimiter,
  type Redis,
} from '@dorkar/kernel';
import { createRemoteJWKSet } from 'jose';
import { createRevocationHandler, type RevocationStore } from './application/revocation';
import type { GatewayConfig } from './config/env';
import { RedisRevocationStore } from './infrastructure/redis-revocation-store';
import { registerEdgePolicy } from './interfaces/http/edge';
import { registerProxies } from './interfaces/http/proxy';
import { ROUTE_TABLE } from './route-table';

export interface GatewayOverrides {
  limiter?: RateLimiter;
  revocations?: RevocationStore;
}

export interface GatewayService {
  app: App;
  redis: Redis;
  consumer: RedisStreamConsumer;
  startWorkers(): Promise<void>;
  stopWorkers(): Promise<void>;
  close(): Promise<void>;
}

/** Composition root for the edge. */
export async function buildGateway(
  config: GatewayConfig,
  logger: Logger,
  overrides: GatewayOverrides = {},
): Promise<GatewayService> {
  const redis = createRedis(config.REDIS_URL, { keyPrefix: 'gateway', logger });
  const revocations = overrides.revocations ?? new RedisRevocationStore(redis);

  const app = await createHttpServer({
    config,
    logger,
    ipHashKey: config.PII_HASH_KEY,
    readiness: [{ name: 'redis', check: async () => void (await redis.ping()) }],
  });

  registerEdgePolicy(app, {
    verifier: createJwtVerifier({
      // Cached; refetched on unknown `kid` (key rotation) with a cooldown against hammering.
      key: createRemoteJWKSet(new URL(config.JWKS_URL), {
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        timeoutDuration: 2_000,
      }),
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }),
    revocations,
    limiter: overrides.limiter ?? new RedisRateLimiter(redis),
    limits: {
      ipPerMinute: config.RATE_LIMIT_IP_PER_MINUTE,
      actorPerMinute: config.RATE_LIMIT_ACTOR_PER_MINUTE,
    },
  });

  await registerProxies(app, {
    routes: ROUTE_TABLE,
    upstreams: { identity: config.UPSTREAM_IDENTITY_URL },
    timeoutMs: config.UPSTREAM_TIMEOUT_MS,
  });

  // Dedicated, unprefixed connection without command timeout: the consumer issues blocking reads.
  const consumer = new RedisStreamConsumer(
    createRedis(config.REDIS_URL, { keyPrefix: null, commandTimeoutMs: null, logger }),
    {
      producer: 'identity',
      group: config.EVENTS_GROUP,
      consumer: `${hostname()}-${process.pid}`,
      handler: createRevocationHandler(revocations, config.ACCESS_TOKEN_TTL_SECONDS),
      logger,
    },
  );

  const stopWorkers = () => consumer.stop();
  return {
    app,
    redis,
    consumer,
    async startWorkers() {
      if (config.EVENTS_CONSUMER_ENABLED) await consumer.start();
    },
    stopWorkers,
    async close() {
      await app.close();
      await stopWorkers();
      redis.disconnect();
    },
  };
}
