import { Redis } from 'ioredis';
import type { Logger } from './logger';

export type { Redis };

export interface RedisOptions {
  /**
   * Namespaces a service's private keys (`identity:rl:…`). Use `null` for the shared event bus,
   * whose stream names must be identical for producers and consumers.
   */
  keyPrefix: string | null;
  /** Per-command timeout. Must be disabled (`null`) for connections that issue blocking reads. */
  commandTimeoutMs?: number | null;
  logger?: Logger | undefined;
}

/**
 * Redis is a cache/throttle/transport, never a source of truth. Commands fail fast instead of
 * queueing forever while disconnected, so callers can decide to fail open or closed.
 */
export function createRedis(url: string, opts: RedisOptions): Redis {
  const timeout = opts.commandTimeoutMs === undefined ? 1_000 : opts.commandTimeoutMs;
  const redis = new Redis(url, {
    ...(opts.keyPrefix ? { keyPrefix: `${opts.keyPrefix}:` } : {}),
    ...(timeout ? { commandTimeout: timeout } : {}),
    lazyConnect: false,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
  });
  redis.on('error', (err: Error) => opts.logger?.warn({ err: err.message }, 'redis error'));
  return redis;
}
