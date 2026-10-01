import { IdentityEvents, type EventEnvelope } from '@dorkar/contracts';
import type { AccessTokenClaims, EventHandler } from '@dorkar/kernel';

/**
 * Port: short-lived denylist of access tokens that identity has revoked but that are still
 * cryptographically valid. Entries only need to outlive the access-token TTL.
 */
export interface RevocationStore {
  isRevoked(claims: Pick<AccessTokenClaims, 'sub' | 'sid' | 'did' | 'iat'>): Promise<boolean>;
  revokeSession(sessionId: string, ttlSeconds: number): Promise<void>;
  revokeDevice(deviceId: string, ttlSeconds: number): Promise<void>;
  /** Tokens of `accountId` with `iat` strictly before `epochSeconds` are revoked. */
  revokeAccountBefore(accountId: string, epochSeconds: number, ttlSeconds: number): Promise<void>;
}

/** How long an entry must live: until every token issued before the event has expired. */
export function remainingTtl(occurredAt: string, accessTokenTtlSeconds: number, nowMs: number) {
  const age = Math.floor((nowMs - Date.parse(occurredAt)) / 1000);
  return accessTokenTtlSeconds + 60 - Math.max(0, age);
}

/**
 * Maps identity events to denylist entries. Idempotent (re-applying an entry is harmless), so
 * at-least-once delivery is fine. Unknown event types are ignored; invalid payloads throw and
 * end up dead-lettered by the consumer.
 */
export function createRevocationHandler(
  store: RevocationStore,
  accessTokenTtlSeconds: number,
  now: () => number = Date.now,
): EventHandler {
  return async (e: EventEnvelope) => {
    const ttl = remainingTtl(e.occurredAt, accessTokenTtlSeconds, now());
    if (ttl <= 0) return; // every token it could affect has already expired

    switch (e.type) {
      case IdentityEvents.SessionRevoked.type: {
        const p = IdentityEvents.SessionRevoked.schema.parse(e.payload);
        return store.revokeSession(p.sessionId, ttl);
      }
      case IdentityEvents.DeviceRevoked.type: {
        const p = IdentityEvents.DeviceRevoked.schema.parse(e.payload);
        return store.revokeDevice(p.deviceId, ttl);
      }
      case IdentityEvents.AccountSessionsRevoked.type: {
        const p = IdentityEvents.AccountSessionsRevoked.schema.parse(e.payload);
        return store.revokeAccountBefore(
          p.accountId,
          Math.floor(Date.parse(p.revokedBefore) / 1000),
          ttl,
        );
      }
      case IdentityEvents.AccountStatusChanged.type: {
        const p = IdentityEvents.AccountStatusChanged.schema.parse(e.payload);
        if (p.to === 'ACTIVE') return; // new logins after a restore carry a later iat
        return store.revokeAccountBefore(
          p.accountId,
          Math.floor(Date.parse(e.occurredAt) / 1000),
          ttl,
        );
      }
    }
  };
}
