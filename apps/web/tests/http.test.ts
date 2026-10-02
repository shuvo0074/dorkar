import { afterEach, describe, expect, it } from 'vitest';
import {
  api,
  clearAccessToken,
  onSessionChange,
  refreshSession,
  setAccessToken,
} from '../src/lib/http';
import { fakeApi, inTenMinutes } from './fake-api';

afterEach(() => clearAccessToken());

describe('api client', () => {
  it('sends the bearer token and parses the error envelope', async () => {
    const { calls } = fakeApi({
      'GET /api/v1/me/account': () => ({
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'slow down', requestId: 'r' } },
        headers: { 'retry-after': '7' },
      }),
    });
    setAccessToken('t1', inTenMinutes());
    await expect(api('/api/v1/me/account')).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 7,
    });
    expect(calls[0]!.headers['authorization']).toBe('Bearer t1');
  });

  it('refreshes once on 401 and retries with the new token; concurrent callers share one refresh', async () => {
    let refreshes = 0;
    const { calls } = fakeApi({
      'GET /api/v1/me/account': (_b, init) => {
        const auth = (init.headers as Record<string, string>)['authorization'];
        return auth === 'Bearer fresh'
          ? { body: { data: { ok: true } } }
          : { status: 401, body: { error: { code: 'UNAUTHENTICATED' } } };
      },
      'POST /api/v1/auth/refresh': () => {
        refreshes++;
        return { body: { data: { accessToken: 'fresh', accessTokenExpiresAt: inTenMinutes() } } };
      },
    });
    setAccessToken('stale', inTenMinutes());
    const results = await Promise.all([api('/api/v1/me/account'), api('/api/v1/me/account')]);
    expect(results).toEqual([{ data: { ok: true } }, { data: { ok: true } }]);
    expect(refreshes).toBe(1);
    const refreshCall = calls.find((c) => c.key === 'POST /api/v1/auth/refresh')!;
    expect(refreshCall.headers['x-requested-with']).toBe('dorkar');
  });

  it('signals sign-out when the refresh cookie is rejected', async () => {
    fakeApi({
      'POST /api/v1/auth/refresh': () => ({
        status: 401,
        body: { error: { code: 'SESSION_REVOKED' } },
      }),
    });
    setAccessToken('t', inTenMinutes());
    const events: boolean[] = [];
    const off = onSessionChange((s) => events.push(s));
    expect(await refreshSession()).toBe(false);
    off();
    expect(events).toEqual([false]);
  });

  it('reports network failures as NETWORK errors', async () => {
    fakeApi({});
    (
      globalThis.fetch as unknown as { mockRejectedValueOnce: (e: Error) => void }
    ).mockRejectedValueOnce(new TypeError('fail'));
    await expect(api('/api/v1/x', { auth: false })).rejects.toMatchObject({ code: 'NETWORK' });
  });
});
