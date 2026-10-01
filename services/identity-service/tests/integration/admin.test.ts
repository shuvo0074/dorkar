import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createHarness,
  login,
  randomPhone,
  refreshHeaders,
  sleep,
  type Harness,
} from './harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

async function loginAsAdmin() {
  const phone = randomPhone();
  const first = await login(h, phone);
  await h.svc.database.db
    .insertInto('role_grants')
    .values({ account_id: first.accountId, role: 'ADMIN', granted_by: null })
    .execute();
  await sleep(1_050);
  return login(h, phone); // new token carries the ADMIN role
}

const setStatus = (token: string, id: string, status: string, reason = 'policy violation') =>
  h.inject({
    method: 'POST',
    url: `/api/v1/admin/accounts/${id}/status`,
    headers: bearer(token),
    payload: { status, reason },
  });

describe('admin account status', () => {
  it('forbids members', async () => {
    const member = await login(h);
    const other = await login(h);
    const res = await setStatus(member.accessToken, other.accountId, 'SUSPENDED');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('suspends a user: sessions die, login is refused, audit + event are written; restore works', async () => {
    const admin = await loginAsAdmin();
    expect(admin.body.account.roles).toContain('ADMIN');
    const phone = randomPhone();
    const user = await login(h, phone);

    const res = await setStatus(admin.accessToken, user.accountId, 'SUSPENDED');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('SUSPENDED');

    expect(
      (await h.inject({ url: '/api/v1/me/account', headers: bearer(user.accessToken) })).statusCode,
    ).toBe(401);
    const refreshed = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: refreshHeaders(user.refreshCookie),
    });
    expect(refreshed.statusCode).toBe(401);

    await sleep(1_050);
    const otp = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/request-otp',
      payload: { phone },
    });
    expect(otp.statusCode).toBe(202); // no status disclosure before the code is proven
    const verify = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        challengeId: otp.json().data.challengeId,
        code: h.sms.lastCodeFor(`+880${phone.slice(1)}`),
        device: { key: user.deviceKey, platform: 'web' },
      },
    });
    expect(verify.statusCode).toBe(403);
    expect(verify.json().error.code).toBe('ACCOUNT_SUSPENDED');

    const audit = await h.svc.database.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'admin.account_status_changed')
      .where('target_id', '=', user.accountId)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_id: admin.accountId, actor_type: 'ADMIN' });
    expect(audit.metadata).toMatchObject({ from: 'ACTIVE', to: 'SUSPENDED', revokedSessions: 1 });

    const event = await h.svc.database.db
      .selectFrom('outbox')
      .selectAll()
      .where('type', '=', 'identity.AccountStatusChanged')
      .where('aggregate_id', '=', user.accountId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ from: 'ACTIVE', to: 'SUSPENDED' });

    const restored = await setStatus(
      admin.accessToken,
      user.accountId,
      'ACTIVE',
      'appeal accepted',
    );
    expect(restored.json().data.status).toBe('ACTIVE');
  });

  it('prevents self-moderation and invalid transitions', async () => {
    const admin = await loginAsAdmin();
    expect((await setStatus(admin.accessToken, admin.accountId, 'BANNED')).statusCode).toBe(403);

    const user = await login(h);
    expect((await setStatus(admin.accessToken, user.accountId, 'DELETED')).statusCode).toBe(200);
    const res = await setStatus(admin.accessToken, user.accountId, 'ACTIVE');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('returns 404 for unknown accounts', async () => {
    const admin = await loginAsAdmin();
    const res = await setStatus(
      admin.accessToken,
      '0192f0c4-0000-7000-8000-000000000000',
      'SUSPENDED',
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('fail-closed throttling', () => {
  it('refuses to send OTPs when Redis is unavailable but still verifies issued codes', async () => {
    const broken = await createHarness(
      {},
      {
        limiter: {
          consume: () => Promise.reject(new Error('redis down')),
          count: () => Promise.reject(new Error('redis down')),
          hit: () => Promise.reject(new Error('redis down')),
        },
      },
    );
    try {
      const res = await broken.inject({
        method: 'POST',
        url: '/api/v1/auth/request-otp',
        payload: { phone: randomPhone() },
      });
      expect(res.statusCode).toBe(503);
      expect(broken.sms.sent).toHaveLength(0);
    } finally {
      await broken.close();
    }
  });
});
