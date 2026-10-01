import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createRedis } from '../src/redis';
import { RedisRateLimiter } from '../src/rate-limit';
import { TEST_REDIS_URL } from '../src/testing';
import { randomBytes } from 'node:crypto';

const redis = createRedis(TEST_REDIS_URL, {
  keyPrefix: `kernel-test-${randomBytes(4).toString('hex')}`,
});
let now = 1_000_000;
const limiter = new RedisRateLimiter(redis, () => now);
let k: string;

beforeEach(() => {
  k = randomBytes(4).toString('hex');
});
afterAll(async () => {
  const keys = await redis.keys(`${redis.options.keyPrefix}*`);
  if (keys.length) await redis.del(...keys.map((x) => x.slice(redis.options.keyPrefix!.length)));
  await redis.quit();
});

describe('RedisRateLimiter', () => {
  it('allows up to the limit, then reports when a slot frees up', async () => {
    const rule = { key: k, limit: 2, windowMs: 1000 };
    expect(await limiter.consume([rule])).toEqual({ allowed: true });
    now += 100;
    expect(await limiter.consume([rule])).toEqual({ allowed: true });
    now += 100;
    expect(await limiter.consume([rule])).toEqual({ allowed: false, retryAfterMs: 800 });
    now += 800;
    expect(await limiter.consume([rule])).toEqual({ allowed: true });
  });

  it('does not consume other rules when one rejects', async () => {
    const tight = { key: `${k}:tight`, limit: 1, windowMs: 10_000 };
    const loose = { key: `${k}:loose`, limit: 5, windowMs: 10_000 };
    await limiter.consume([tight, loose]);
    for (let i = 0; i < 3; i++) expect((await limiter.consume([tight, loose])).allowed).toBe(false);
    expect(await limiter.count(loose.key, loose.windowMs)).toBe(1);
  });

  it('is atomic under concurrency', async () => {
    const rule = { key: k, limit: 5, windowMs: 60_000 };
    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.consume([rule])));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('hit/count support lockout counters', async () => {
    await limiter.hit(k, 1000);
    await limiter.hit(k, 1000);
    expect(await limiter.count(k, 1000)).toBe(2);
    now += 1001;
    expect(await limiter.count(k, 1000)).toBe(0);
  });
});
