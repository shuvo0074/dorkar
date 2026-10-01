import { IdentityEvents, type EventEnvelope } from '@dorkar/contracts';
import { describe, expect, it } from 'vitest';
import {
  createRevocationHandler,
  remainingTtl,
  type RevocationStore,
} from '../../src/application/revocation';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const acct = '0192f0c4-0000-7000-8000-000000000001';
const sid = '0192f0c4-0000-7000-8000-000000000002';
const did = '0192f0c4-0000-7000-8000-000000000003';

function recorder() {
  const calls: unknown[][] = [];
  const store: RevocationStore = {
    isRevoked: async () => false,
    revokeSession: async (...a) => void calls.push(['session', ...a]),
    revokeDevice: async (...a) => void calls.push(['device', ...a]),
    revokeAccountBefore: async (...a) => void calls.push(['account', ...a]),
  };
  return { store, calls };
}

const envelope = (
  type: string,
  payload: object,
  occurredAt = new Date(NOW).toISOString(),
): EventEnvelope => ({
  id: '0192f0c4-0000-7000-8000-0000000000ff',
  type,
  version: 1,
  occurredAt,
  producer: 'identity',
  aggregateId: acct,
  payload: payload as Record<string, unknown>,
});

describe('revocation handler', () => {
  const ttl = 600;

  it('maps each revocation event to a denylist entry that outlives the access token', async () => {
    const { store, calls } = recorder();
    const handle = createRevocationHandler(store, ttl, () => NOW);
    await handle(
      envelope(IdentityEvents.SessionRevoked.type, {
        accountId: acct,
        sessionId: sid,
        reason: 'LOGOUT',
      }),
    );
    await handle(envelope(IdentityEvents.DeviceRevoked.type, { accountId: acct, deviceId: did }));
    await handle(
      envelope(IdentityEvents.AccountSessionsRevoked.type, {
        accountId: acct,
        revokedBefore: '2026-10-01T11:59:59.500Z',
        reason: 'LOGOUT_ALL',
      }),
    );
    await handle(
      envelope(IdentityEvents.AccountStatusChanged.type, {
        accountId: acct,
        from: 'ACTIVE',
        to: 'BANNED',
        reason: 'x',
      }),
    );
    expect(calls).toEqual([
      ['session', sid, 660],
      ['device', did, 660],
      ['account', acct, Math.floor(Date.parse('2026-10-01T11:59:59Z') / 1000), 660],
      ['account', acct, NOW / 1000, 660],
    ]);
  });

  it('does nothing for restores, unrelated events and events older than any live token', async () => {
    const { store, calls } = recorder();
    const handle = createRevocationHandler(store, ttl, () => NOW);
    await handle(
      envelope(IdentityEvents.AccountStatusChanged.type, {
        accountId: acct,
        from: 'BANNED',
        to: 'ACTIVE',
        reason: 'x',
      }),
    );
    await handle(envelope(IdentityEvents.AccountCreated.type, { accountId: acct }));
    await handle(
      envelope(
        IdentityEvents.SessionRevoked.type,
        { accountId: acct, sessionId: sid, reason: 'LOGOUT' },
        new Date(NOW - 11 * 60_000).toISOString(),
      ),
    );
    expect(calls).toEqual([]);
  });

  it('rejects malformed payloads (so the consumer dead-letters them)', async () => {
    const { store } = recorder();
    const handle = createRevocationHandler(store, ttl, () => NOW);
    await expect(
      handle(envelope(IdentityEvents.SessionRevoked.type, { sessionId: 'nope' })),
    ).rejects.toThrow();
  });

  it('shrinks the TTL by the event age', () => {
    expect(remainingTtl(new Date(NOW - 100_000).toISOString(), 600, NOW)).toBe(560);
  });
});
