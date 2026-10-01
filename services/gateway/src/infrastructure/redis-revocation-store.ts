import type { Redis } from '@dorkar/kernel';
import type { RevocationStore } from '../application/revocation';

// Keep the later cut-off if events for the same account arrive out of order.
const SET_MAX = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local val = tonumber(ARGV[1])
if val > cur then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
else
  redis.call('EXPIRE', KEYS[1], ARGV[2], 'GT')
end
return 1
`;

/** Denylist in Redis. Losing Redis loses at most `access TTL` of early cut-off, not access control. */
export class RedisRevocationStore implements RevocationStore {
  constructor(private readonly redis: Redis) {}

  async isRevoked(c: { sub: string; sid: string; did: string; iat: number }): Promise<boolean> {
    const [sid, did, acct] = await this.redis.mget(
      `revoked:sid:${c.sid}`,
      `revoked:did:${c.did}`,
      `revoked:acct:${c.sub}`,
    );
    return sid !== null || did !== null || (acct !== null && c.iat < Number(acct));
  }

  async revokeSession(sessionId: string, ttl: number): Promise<void> {
    await this.redis.set(`revoked:sid:${sessionId}`, '1', 'EX', ttl);
  }

  async revokeDevice(deviceId: string, ttl: number): Promise<void> {
    await this.redis.set(`revoked:did:${deviceId}`, '1', 'EX', ttl);
  }

  async revokeAccountBefore(accountId: string, epochSeconds: number, ttl: number): Promise<void> {
    await this.redis.eval(SET_MAX, 1, `revoked:acct:${accountId}`, epochSeconds, ttl);
  }
}
