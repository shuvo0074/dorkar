import { Redis } from 'ioredis';
import type { Logger } from './logger';

export type { Redis };

/**
 * Redis is a cache/throttle/transport, never a source of truth. Commands fail fast instead of
 * queueing forever while disconnected, so callers can decide to fail open or closed.
 */
export function createRedis(url: string, keyPrefix: string, logger?: Logger): Redis {
  const redis = new Redis(url, {
    keyPrefix: `${keyPrefix}:`,
    lazyConnect: false,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 1_000,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  redis.on('error', (err: Error) => logger?.warn({ err: err.message }, 'redis error'));
  return redis;
}
