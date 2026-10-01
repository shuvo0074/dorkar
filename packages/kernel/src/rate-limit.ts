import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface RateLimitRule {
  key: string;
  limit: number;
  windowMs: number;
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Port so use cases can be unit-tested without Redis. */
export interface RateLimiter {
  /** Atomically check all rules; consume a slot in every rule only if all pass. */
  consume(rules: readonly RateLimitRule[]): Promise<RateLimitResult>;
  /** Number of hits recorded under `key` within the window (does not consume). */
  count(key: string, windowMs: number): Promise<number>;
  /** Record a hit unconditionally (e.g. failed attempts used for lockouts). */
  hit(key: string, windowMs: number): Promise<void>;
}

// Sliding-window log over sorted sets. All rules are evaluated in one script, so a request
// rejected by one rule does not burn quota in the others, and concurrent requests cannot both
// take the last slot. (Single Redis node; on Cluster, rule keys would need a shared hash tag.)
const CONSUME = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local retry = 0
for i = 1, #KEYS do
  local limit = tonumber(ARGV[1 + i * 2])
  local window = tonumber(ARGV[2 + i * 2])
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - window)
  local count = redis.call('ZCARD', KEYS[i])
  if count >= limit then
    local entry = redis.call('ZRANGE', KEYS[i], count - limit, count - limit, 'WITHSCORES')
    local wait = tonumber(entry[2]) + window - now
    if wait > retry then retry = wait end
  end
end
if retry > 0 then return retry end
for i = 1, #KEYS do
  local window = tonumber(ARGV[2 + i * 2])
  redis.call('ZADD', KEYS[i], now, member)
  redis.call('PEXPIRE', KEYS[i], window)
end
return 0
`;

const COUNT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
return redis.call('ZCARD', KEYS[1])
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => number = Date.now,
  ) {}

  async consume(rules: readonly RateLimitRule[]): Promise<RateLimitResult> {
    if (rules.length === 0) return { allowed: true };
    const now = this.now();
    const member = `${now}:${randomBytes(6).toString('hex')}`;
    const args = rules.flatMap((r) => [r.limit, r.windowMs]);
    const retry = (await this.redis.eval(
      CONSUME,
      rules.length,
      ...rules.map((r) => `rl:${r.key}`),
      now,
      member,
      ...args,
    )) as number;
    return retry > 0 ? { allowed: false, retryAfterMs: retry } : { allowed: true };
  }

  async count(key: string, windowMs: number): Promise<number> {
    return (await this.redis.eval(COUNT, 1, `rl:${key}`, this.now(), windowMs)) as number;
  }

  async hit(key: string, windowMs: number): Promise<void> {
    await this.consume([{ key, limit: Number.MAX_SAFE_INTEGER, windowMs }]);
  }
}
