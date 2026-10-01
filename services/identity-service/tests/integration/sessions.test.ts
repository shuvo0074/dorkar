import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay, RedisStreamPublisher, type Logger } from '@dorkar/kernel';
import { eventStreamFor } from '@dorkar/contracts';
import {
  bearer,
  createHarness,
  login,
  ORIGIN,
  randomDeviceKey,
  randomPhone,
  refreshHeaders,
  type Harness,
} from './harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const refresh = (cookie: string, headers: Record<string, string> = {}) =>
  h.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    headers: { ...refreshHeaders(cookie), ...headers },
  });

describe('login', () => {
  it('creates an account, sets a hardened refresh cookie and returns a verifiable access token', async () => {
    const phone = randomPhone();
    const s = await login(h, phone);
    expect(s.body.isNewAccount).toBe(true);
    expect(s.body.account).toMatchObject({ status: 'ACTIVE', roles: ['MEMBER'] });
    expect(s.body.account.phoneMasked).toMatch(/^\+88017•+\d{3}$/);
    expect(s.body.refreshToken).toBeUndefined();

    const res = await h.inject({ url: '/.well-known/jwks.json' });
    const { payload, protectedHeader } = await jwtVerify(
      s.accessToken,
      createLocalJWKSet(res.json()),
      {
        issuer: h.config.JWT_ISSUER,
        audience: h.config.JWT_AUDIENCE,
      },
    );
    expect(protectedHeader).toMatchObject({ alg: 'EdDSA', kid: 'test-key' });
    expect(payload).toMatchObject({ sub: s.accountId, roles: ['MEMBER'] });
    expect(payload.exp! - payload.iat!).toBe(h.config.ACCESS_TOKEN_TTL_SECONDS);

    await new Promise((r) => setTimeout(r, 1_050)); // resend cooldown
    const again = await login(h, phone);
    expect(again.accountId).toBe(s.accountId);
    expect(again.body.isNewAccount).toBe(false);
  });

  it('sets cookie flags that keep the refresh token away from scripts and other sites', async () => {
    const phone = randomPhone();
    const req = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/request-otp',
      payload: { phone },
    });
    const res = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        challengeId: req.json().data.challengeId,
        code: h.sms.lastCodeFor(`+880${phone.slice(1)}`),
        device: { key: randomDeviceKey(), platform: 'web' },
      },
    });
    const cookie = res.cookies.find((c) => c.name === 'dorkar_rt')!;
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/api/v1/auth',
    });
  });

  it('records audit events and publishes AccountCreated + UserLoggedIn through the outbox', async () => {
    const s = await login(h);
    const actions = (
      await h.svc.database.db
        .selectFrom('audit_log')
        .select('action')
        .where('actor_id', '=', s.accountId)
        .execute()
    ).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['auth.account_created', 'device.registered', 'auth.login_succeeded']),
    );

    const relay = new OutboxRelay(
      h.svc.database.db,
      new RedisStreamPublisher(h.svc.bus, 'identity'),
      h.svc.app.log as unknown as Logger,
      { producer: 'identity' },
    );
    while ((await relay.tick()) > 0);
    const entries = await h.svc.bus.xrevrange(eventStreamFor('identity'), '+', '-', 'COUNT', 50);
    const events = entries.map(([, fields]) => JSON.parse(fields[3]!));
    const mine = events.filter((e) => e.aggregateId === s.accountId).map((e) => e.type);
    expect(mine).toEqual(
      expect.arrayContaining(['identity.AccountCreated', 'identity.UserLoggedIn']),
    );
  });
});

describe('refresh token rotation', () => {
  it('rotates on every refresh', async () => {
    const s = await login(h);
    const r1 = await refresh(s.refreshCookie);
    expect(r1.statusCode).toBe(200);
    const next = r1.cookies.find((c) => c.name === 'dorkar_rt')!.value;
    expect(next).not.toBe(s.refreshCookie);
    expect(r1.json().data.accessToken).toBeTruthy();
    expect((await refresh(next)).statusCode).toBe(200);
  });

  it('revokes the whole session when a used refresh token is replayed', async () => {
    const s = await login(h);
    const r1 = await refresh(s.refreshCookie);
    const next = r1.cookies.find((c) => c.name === 'dorkar_rt')!.value;

    const replay = await refresh(s.refreshCookie);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('SESSION_REVOKED');
    // the legitimately rotated token is now dead too — attacker and victim both re-authenticate
    expect((await refresh(next)).statusCode).toBe(401);
    expect(
      (await h.inject({ url: '/api/v1/me/account', headers: bearer(s.accessToken) })).statusCode,
    ).toBe(401);
  });

  it('serializes concurrent refreshes of the same token', async () => {
    const s = await login(h);
    const results = await Promise.all([refresh(s.refreshCookie), refresh(s.refreshCookie)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it('requires the CSRF header and an allowed Origin for cookie refresh', async () => {
    const s = await login(h);
    const noHeader = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: `dorkar_rt=${s.refreshCookie}`, origin: ORIGIN },
    });
    expect(noHeader.statusCode).toBe(403);
    const evil = await refresh(s.refreshCookie, { origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    expect((await refresh(s.refreshCookie)).statusCode).toBe(200);
  });

  it('supports native clients with body tokens and no cookies', async () => {
    const s = await login(h, randomPhone(), randomDeviceKey(), { 'x-client': 'mobile' });
    expect(s.refreshCookie).toBe('');
    expect(s.body.refreshToken).toHaveLength(43);
    const res = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { 'x-client': 'mobile' },
      payload: { refreshToken: s.body.refreshToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.refreshToken).toHaveLength(43);
    expect(res.cookies).toHaveLength(0);
  });

  it('rejects unknown refresh tokens', async () => {
    expect((await refresh('x'.repeat(43))).statusCode).toBe(401);
  });
});

describe('revocation events (consumed by the gateway for immediate cut-off)', () => {
  const eventsFor = (accountId: string) =>
    h.svc.database.db
      .selectFrom('outbox')
      .select(['type', 'payload'])
      .where('aggregate_id', '=', accountId)
      .orderBy('occurred_at')
      .execute();

  it('logout emits SessionRevoked; logout-all emits AccountSessionsRevoked', async () => {
    const phone = randomPhone();
    const a = await login(h, phone);
    await h.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: bearer(a.accessToken) });
    await new Promise((r) => setTimeout(r, 1_050));
    const b = await login(h, phone);
    await h.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: bearer(b.accessToken),
    });

    const events = await eventsFor(a.accountId);
    expect(events.find((e) => e.type === 'identity.SessionRevoked')?.payload).toMatchObject({
      reason: 'LOGOUT',
    });
    const all = events.find((e) => e.type === 'identity.AccountSessionsRevoked');
    expect(all?.payload).toMatchObject({ accountId: a.accountId, reason: 'LOGOUT_ALL' });
  });

  it('refresh-token reuse emits SessionRevoked once', async () => {
    const s = await login(h);
    await refresh(s.refreshCookie);
    await refresh(s.refreshCookie);
    await refresh(s.refreshCookie);
    const revoked = (await eventsFor(s.accountId)).filter(
      (e) => e.type === 'identity.SessionRevoked',
    );
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.payload).toMatchObject({ reason: 'REFRESH_TOKEN_REUSE' });
  });
});

describe('logout and devices', () => {
  it('logout revokes the session immediately', async () => {
    const s = await login(h);
    const out = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: bearer(s.accessToken),
    });
    expect(out.statusCode).toBe(204);
    expect(
      (await h.inject({ url: '/api/v1/me/account', headers: bearer(s.accessToken) })).statusCode,
    ).toBe(401);
    expect((await refresh(s.refreshCookie)).statusCode).toBe(401);
  });

  it('logout-all revokes every session of the account', async () => {
    const phone = randomPhone();
    const a = await login(h, phone);
    await new Promise((r) => setTimeout(r, 1_050)); // resend cooldown
    const b = await login(h, phone);
    const res = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-all',
      headers: bearer(b.accessToken),
    });
    expect(res.json().data.revokedSessions).toBe(2);
    expect((await refresh(a.refreshCookie)).statusCode).toBe(401);
    expect((await refresh(b.refreshCookie)).statusCode).toBe(401);
  });

  it('lists devices and revokes another device of the same account', async () => {
    const phone = randomPhone();
    const laptop = await login(h, phone);
    await new Promise((r) => setTimeout(r, 1_050));
    const phoneDevice = await login(h, phone);

    const list = await h.inject({
      url: '/api/v1/me/devices',
      headers: bearer(phoneDevice.accessToken),
    });
    const devices = list.json().data as Array<{ id: string; current: boolean }>;
    expect(devices).toHaveLength(2);
    const other = devices.find((d) => !d.current)!;

    const del = await h.inject({
      method: 'DELETE',
      url: `/api/v1/me/devices/${other.id}`,
      headers: bearer(phoneDevice.accessToken),
    });
    expect(del.statusCode).toBe(204);
    expect((await refresh(laptop.refreshCookie)).statusCode).toBe(401);
    expect((await refresh(phoneDevice.refreshCookie)).statusCode).toBe(200);
  });

  it("cannot revoke someone else's device (IDOR) — answers 404", async () => {
    const victim = await login(h);
    const attacker = await login(h);
    const victimDevices = await h.inject({
      url: '/api/v1/me/devices',
      headers: bearer(victim.accessToken),
    });
    const victimDeviceId = victimDevices.json().data[0].id;
    const res = await h.inject({
      method: 'DELETE',
      url: `/api/v1/me/devices/${victimDeviceId}`,
      headers: bearer(attacker.accessToken),
    });
    expect(res.statusCode).toBe(404);
    expect((await refresh(victim.refreshCookie)).statusCode).toBe(200);
  });

  it('lists active sessions and marks the current one', async () => {
    const s = await login(h);
    const res = await h.inject({ url: '/api/v1/me/sessions', headers: bearer(s.accessToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([expect.objectContaining({ current: true })]);
  });

  it('rejects missing, malformed and forged access tokens', async () => {
    expect((await h.inject({ url: '/api/v1/me/account' })).statusCode).toBe(401);
    expect((await h.inject({ url: '/api/v1/me/account', headers: bearer('abc') })).statusCode).toBe(
      401,
    );
    const s = await login(h);
    const [head, body] = s.accessToken.split('.');
    const forgedBody = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, 'base64url').toString()),
        roles: ['SUPER_ADMIN'],
      }),
    ).toString('base64url');
    const forged = `${head}.${forgedBody}.${s.accessToken.split('.')[2]}`;
    expect(
      (await h.inject({ url: '/api/v1/me/account', headers: bearer(forged) })).statusCode,
    ).toBe(401);
  });
});
