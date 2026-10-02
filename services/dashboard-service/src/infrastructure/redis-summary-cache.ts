import type { Logger, Redis } from '@dorkar/kernel';
import type { SummaryCache } from '../application/ports';

/**
 * Short-lived JSON cache. Redis is never a source of truth: any failure falls through to a
 * fresh computation (fail open).
 */
export function redisSummaryCache<T>(redis: Redis, key: string, logger: Logger): SummaryCache<T> {
  return {
    async get() {
      try {
        const raw = await redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      } catch (err) {
        logger.warn({ err }, 'summary cache read failed');
        return null;
      }
    },
    async set(value, ttlSeconds) {
      try {
        await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
      } catch (err) {
        logger.warn({ err }, 'summary cache write failed');
      }
    },
  };
}
