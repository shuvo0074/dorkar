import { randomUUID } from 'node:crypto';
import { IdentityEvents, type EventEnvelope } from '@dorkar/contracts';
import { createEventFactory, createRedis, RedisStreamPublisher } from '@dorkar/kernel';
import { TEST_REDIS_URL } from '@dorkar/kernel/testing';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bearer,
  createGateway,
  ORIGIN,
  startUpstream,
  type Harness,
  type Upstream,
} from './harness';

let up: Upstream;
let h: Harness;
const bus = createRedis(TEST_REDIS_URL, { keyPrefix: null });

beforeAll(async () => {
  up = await startUpstream();
  h = await createGateway(up.url);
});
afterAll(async () => {
  await h.close();
  await up.app.close();
  bus.disconnect();
});

const inject = (opts: InjectOptions) => h.gw.app.inject(opts);
const lastCall = () => up.calls[up.calls.length - 1]!;

describe('routing', () => {
  it('forwards listed prefixes with path and query intact', async () => {
    const res = await inject({ url: '/api/v1/me/account?x=1&y=two' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-upstream']).toBe('identity');
    expect(res.json().data.url).toBe('/api/v1/me/account?x=1&y=two');
  });

  it('forwards POST bodies and cookies (refresh flow)', async () => {
    const res = await inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: 'dorkar_rt=abc', 'x-requested-with': 'dorkar' },
      payload: { refreshToken: 'x' },
    });
    expect(res.statusCode).toBe(200);
    expect(lastCall().headers['cookie']).toBe('dorkar_rt=abc');
  });

  it('returns 404 for anything not in the route table, without calling upstream', async () => {
    const before = up.calls.length;
    for (const url of [
      '/internal/v1/verification/evaluate',
      '/docs',
      '/api/v1/me/accountX',
      '/api/v2/auth',
    ]) {
      const res = await inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    expect(up.calls.length).toBe(before);
  });

  it('rejects path traversal out of a routed prefix', async () => {
    const res = await inject({ url: '/api/v1/auth/..%2f..%2finternal%2fv1' });
    expect([400, 404]).toContain(res.statusCode);
  });

  it('proxies the JWKS endpoint', async () => {
    const res = await inject({ url: '/.well-known/jwks.json' });
    expect(res.json().keys[0].kid).toBe('k1');
  });
});

describe('headers', () => {
  it('propagates request and correlation ids', async () => {
    await inject({ url: '/api/v1/me/account', headers: { 'x-request-id': 'req-abcdef12' } });
    expect(lastCall().headers['x-request-id']).toBe('req-abcdef12');
    expect(lastCall().headers['x-correlation-id']).toBe('req-abcdef12');
  });

  it('replaces client-supplied forwarding headers with the real client IP', async () => {
    const res = await inject({
      url: '/api/v1/me/account',
      remoteAddress: '10.0.0.5', // the reverse proxy in front of the gateway
      headers: {
        'x-forwarded-for': '6.6.6.6, 203.0.113.9', // spoofed entry, then the proxy-appended real IP
        'x-real-ip': '6.6.6.6',
        'x-internal-actor': 'admin',
      },
    });
    expect(res.statusCode).toBe(200);
    const fwd = lastCall().headers;
    expect(fwd['x-forwarded-for']).toBe('203.0.113.9');
    expect(fwd['x-real-ip']).toBeUndefined();
    expect(fwd['x-internal-actor']).toBeUndefined();
  });

  it('decides CORS at the edge and strips upstream CORS headers', async () => {
    const pre = await inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/request-otp',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(ORIGIN);

    const evil = await inject({
      url: '/api/v1/me/account',
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined(); // upstream's "*" removed
  });
});

describe('authentication at the edge', () => {
  it('lets requests without a token through (services decide what is public)', async () => {
    expect((await inject({ url: '/api/v1/me/account' })).statusCode).toBe(200);
  });

  it('rejects malformed and forged tokens without calling upstream', async () => {
    const before = up.calls.length;
    for (const authorization of [
      'Basic abc',
      'Bearer nope',
      `Bearer ${(await up.sign()).slice(0, -4)}AAAA`,
    ]) {
      const res = await inject({ url: '/api/v1/me/account', headers: { authorization } });
      expect(res.statusCode).toBe(401);
    }
    expect(up.calls.length).toBe(before);
  });

  it('passes valid tokens through untouched', async () => {
    const token = await up.sign();
    const res = await inject({ url: '/api/v1/me/account', headers: bearer(token) });
    expect(res.statusCode).toBe(200);
    expect(lastCall().headers['authorization']).toBe(`Bearer ${token}`);
  });
});

describe('immediate revocation via identity events', () => {
  const event = createEventFactory('identity');
  const publish = (e: ReturnType<typeof event>) =>
    new RedisStreamPublisher(bus, 'identity').publish([e as EventEnvelope]);
  const drain = async () => {
    await h.gw.consumer.ensureGroup();
    while ((await h.gw.consumer.poll(10)) > 0);
  };

  it('logout: the session token is rejected as soon as the event is consumed', async () => {
    const accountId = randomUUID();
    const sid = randomUUID();
    const token = await up.sign({ sub: accountId, sid });
    expect((await inject({ url: '/api/v1/me/account', headers: bearer(token) })).statusCode).toBe(
      200,
    );

    await publish(
      event(IdentityEvents.SessionRevoked, accountId, {
        accountId,
        sessionId: sid,
        reason: 'LOGOUT',
      }),
    );
    await drain();

    const res = await inject({ url: '/api/v1/me/account', headers: bearer(token) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('SESSION_REVOKED');
    // other sessions of the same account are unaffected
    expect(
      (
        await inject({
          url: '/api/v1/me/account',
          headers: bearer(await up.sign({ sub: accountId })),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('device revocation rejects every token of that device', async () => {
    const accountId = randomUUID();
    const did = randomUUID();
    const token = await up.sign({ sub: accountId, did });
    await publish(event(IdentityEvents.DeviceRevoked, accountId, { accountId, deviceId: did }));
    await drain();
    expect((await inject({ url: '/api/v1/me/account', headers: bearer(token) })).statusCode).toBe(
      401,
    );
  });

  it('logout-all and bans cut off tokens issued before the event, not after', async () => {
    const accountId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const old = await up.sign({ sub: accountId, iat: now - 60 });
    await publish(
      event(IdentityEvents.AccountSessionsRevoked, accountId, {
        accountId,
        revokedBefore: new Date((now - 30) * 1000).toISOString(),
        reason: 'LOGOUT_ALL',
      }),
    );
    await drain();
    expect((await inject({ url: '/api/v1/me/account', headers: bearer(old) })).statusCode).toBe(
      401,
    );
    const fresh = await up.sign({ sub: accountId, iat: now });
    expect((await inject({ url: '/api/v1/me/account', headers: bearer(fresh) })).statusCode).toBe(
      200,
    );

    const banned = randomUUID();
    const t = await up.sign({ sub: banned, iat: now - 5 });
    await publish(
      event(IdentityEvents.AccountStatusChanged, banned, {
        accountId: banned,
        from: 'ACTIVE',
        to: 'BANNED',
        reason: 'fraud',
      }),
    );
    await drain();
    expect((await inject({ url: '/api/v1/me/account', headers: bearer(t) })).statusCode).toBe(401);
  });
});

describe('resilience', () => {
  it('maps a slow upstream to 504 UPSTREAM_TIMEOUT', async () => {
    const res = await inject({ url: '/api/v1/me/sessions' });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('UPSTREAM_TIMEOUT');
  });

  it('maps an unreachable upstream to 503 UNAVAILABLE', async () => {
    const down = await createGateway('http://127.0.0.1:9'); // discard port: connection refused
    try {
      // Real HTTP: the in-process injector surfaces upstream socket errors on its own body stream.
      const address = await down.gw.app.listen({ host: '127.0.0.1', port: 0 });
      const res = await fetch(`${address}/api/v1/auth/request-otp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: object }).error).toMatchObject({
        code: 'UNAVAILABLE',
        requestId: expect.any(String),
      });
    } finally {
      await down.close();
    }
  });

  it('fails open on revocation-store outages but still verifies signatures', async () => {
    const flaky = await createGateway(
      up.url,
      {},
      {
        revocations: {
          isRevoked: () => Promise.reject(new Error('redis down')),
          revokeSession: async () => {},
          revokeDevice: async () => {},
          revokeAccountBefore: async () => {},
        },
      },
    );
    try {
      expect(
        (await flaky.gw.app.inject({ url: '/api/v1/me/account', headers: bearer(await up.sign()) }))
          .statusCode,
      ).toBe(200);
      expect(
        (await flaky.gw.app.inject({ url: '/api/v1/me/account', headers: bearer('forged') }))
          .statusCode,
      ).toBe(401);
    } finally {
      await flaky.close();
    }
  });
});

describe('rate limiting', () => {
  it('limits per client IP with Retry-After', async () => {
    const limited = await createGateway(up.url, { RATE_LIMIT_IP_PER_MINUTE: '3' });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) {
        codes.push(
          (
            await limited.gw.app.inject({
              url: '/api/v1/me/account',
              remoteAddress: '198.51.100.7',
            })
          ).statusCode,
        );
      }
      expect(codes).toEqual([200, 200, 200, 429, 429]);
      const other = await limited.gw.app.inject({
        url: '/api/v1/me/account',
        remoteAddress: '198.51.100.8',
      });
      expect(other.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('limits per account across IPs', async () => {
    const limited = await createGateway(up.url, { RATE_LIMIT_ACTOR_PER_MINUTE: '2' });
    try {
      const token = await up.sign();
      const codes = [];
      for (let i = 0; i < 3; i++) {
        codes.push(
          (
            await limited.gw.app.inject({
              url: '/api/v1/me/account',
              headers: bearer(token),
              remoteAddress: `198.51.100.${20 + i}`,
            })
          ).statusCode,
        );
      }
      expect(codes).toEqual([200, 200, 429]);
    } finally {
      await limited.close();
    }
  });

  it('never rate-limits health checks', async () => {
    const limited = await createGateway(up.url, { RATE_LIMIT_IP_PER_MINUTE: '1' });
    try {
      for (let i = 0; i < 3; i++) {
        expect((await limited.gw.app.inject({ url: '/health/live' })).statusCode).toBe(200);
      }
    } finally {
      await limited.close();
    }
  });
});
