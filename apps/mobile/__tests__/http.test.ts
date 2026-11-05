jest.mock('react-native-keychain', () => {
  let stored: string | false = false;
  return {
    ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'x' },
    setGenericPassword: jest.fn(async (_u: string, p: string) => {
      stored = p;
    }),
    getGenericPassword: jest.fn(async () => (stored ? { password: stored } : false)),
    resetGenericPassword: jest.fn(async () => {
      stored = false;
    }),
  };
});
jest.mock('../src/config', () => ({ API_URL: 'http://api', reachableUrl: (u: string) => u }));

import {
  api,
  ApiError,
  clearAccessToken,
  hasAccessToken,
  query,
  refreshSession,
  storeRefreshToken,
} from '../src/lib/http';

const json = (status: number, body: unknown) =>
  ({
    ok: status < 400,
    status,
    statusText: '',
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response);
const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  clearAccessToken();
});
const tokens = {
  data: {
    accessToken: 'a2',
    accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    refreshToken: 'r2',
  },
};

test('query skips empty values and encodes the rest', () => {
  expect(query({ a: 1, b: '', c: undefined, d: 'x y' })).toBe('?a=1&d=x%20y');
});

test('no stored token means signed out, without calling the server', async () => {
  expect(await refreshSession()).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('refresh presents the stored token as a native client and is single-flight', async () => {
  await storeRefreshToken('r1');
  fetchMock.mockResolvedValue(json(200, tokens));
  const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
  expect(a && b).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe('http://api/api/v1/auth/refresh');
  expect(init.headers['x-client']).toBe('mobile');
  expect(JSON.parse(init.body)).toEqual({ refreshToken: 'r1' });
  expect(hasAccessToken()).toBe(true);
});

test('a server fault keeps the token; a rejection ends the session', async () => {
  await storeRefreshToken('r1');
  fetchMock.mockResolvedValueOnce(json(503, {}));
  expect(await refreshSession()).toBe(false);
  fetchMock.mockResolvedValueOnce(json(200, tokens));
  expect(await refreshSession()).toBe(true);
  fetchMock.mockResolvedValueOnce(json(401, {}));
  expect(await refreshSession()).toBe(false);
  expect(hasAccessToken()).toBe(false);
  fetchMock.mockClear();
  expect(await refreshSession()).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a 401 refreshes once and retries with the new token', async () => {
  await storeRefreshToken('r1');
  fetchMock.mockResolvedValueOnce(json(200, tokens));
  await refreshSession();
  fetchMock
    .mockResolvedValueOnce(json(401, {}))
    .mockResolvedValueOnce(json(200, { ...tokens, data: { ...tokens.data, accessToken: 'a3' } }))
    .mockResolvedValueOnce(json(200, { ok: true }));
  expect(await api('/x')).toEqual({ ok: true });
  expect(fetchMock.mock.calls[3][1].headers.authorization).toBe('Bearer a3');
});

test('errors carry the API code; no connection becomes NETWORK', async () => {
  fetchMock.mockResolvedValueOnce(json(409, { error: { code: 'CONFLICT', message: 'no' } }));
  await expect(api('/x')).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
  await expect(api('/x')).rejects.toBeInstanceOf(ApiError);
});
