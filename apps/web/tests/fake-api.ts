import { vi } from 'vitest';

type Handler = (
  body: unknown,
  init: RequestInit,
) => { status?: number; body?: unknown; headers?: Record<string, string> };

/**
 * Minimal fetch stub keyed by "METHOD path". Records every call. A key without a query string
 * also answers requests to that path with any query.
 */
export function fakeApi(routes: Record<string, Handler>) {
  const calls: Array<{ key: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const key = `${init.method ?? 'GET'} ${input}`;
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ key, body, headers: (init.headers ?? {}) as Record<string, string> });
    const handler = routes[key] ?? routes[key.split('?')[0]!];
    if (!handler)
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: key } }), {
        status: 404,
      });
    const r = handler(body, init);
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export const account = {
  id: '0192f0c4-0000-7000-8000-00000000abcd',
  phoneMasked: '+88017•••••678',
  status: 'ACTIVE',
  roles: ['MEMBER'],
  createdAt: '2026-10-01T10:00:00.000Z',
};

export const inTenMinutes = () => new Date(Date.now() + 600_000).toISOString();
