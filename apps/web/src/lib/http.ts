/**
 * The one way the app talks to the API.
 *
 * - The access token lives in memory only (never localStorage): an XSS cannot read a token that
 *   was never persisted, and the httpOnly refresh cookie restores it on reload.
 * - Refresh is single-flight inside a tab and serialized across tabs with the Web Locks API, so
 *   two tabs never present the same rotating refresh token (the server treats reuse as theft).
 * - One automatic retry after a 401, then the caller sees the error.
 */
import type { ErrorCode } from '@dorkar/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface TokenState {
  token: string;
  expiresAt: number;
}

let current: TokenState | null = null;
let inflight: Promise<boolean> | null = null;
const listeners = new Set<(signedIn: boolean) => void>();

/** Notified when the session is established or lost (e.g. refresh rejected). */
export function onSessionChange(fn: (signedIn: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setAccessToken(token: string, expiresAt: string): void {
  current = { token, expiresAt: Date.parse(expiresAt) };
  listeners.forEach((l) => l(true));
}

export function clearAccessToken(): void {
  const had = current !== null;
  current = null;
  if (had) listeners.forEach((l) => l(false));
}

export const hasAccessToken = () => current !== null;

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: { code?: ErrorCode; message?: string; details?: Record<string, unknown> } } =
    {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // non-JSON error (proxy, network appliance): fall through to a generic error
  }
  const retry = Number(res.headers.get('retry-after'));
  return new ApiError(
    res.status,
    body.error?.code ?? (res.status >= 500 ? 'UNAVAILABLE' : 'BAD_REQUEST'),
    body.error?.message ?? res.statusText,
    body.error?.details,
    Number.isFinite(retry) && retry > 0 ? retry : undefined,
  );
}

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request('dorkar-refresh', fn) : fn();
}

/** Exchange the refresh cookie for a new access token. Resolves false when signed out. */
export function refreshSession(): Promise<boolean> {
  inflight ??= withRefreshLock(async () => {
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-requested-with': 'dorkar' },
      });
      if (!res.ok) {
        clearAccessToken();
        return false;
      }
      const { data } = (await res.json()) as {
        data: { accessToken: string; accessTokenExpiresAt: string };
      };
      setAccessToken(data.accessToken, data.accessTokenExpiresAt);
      return true;
    } catch {
      return false; // offline: keep whatever state we had
    }
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Attach the access token (default true when signed in). */
  auth?: boolean;
  /**
   * Sent as `Idempotency-Key` on commands the API marks (idem). Create one per user intent
   * (see `intentKey`) and reuse it on retries, so a double tap never makes two offers.
   */
  idempotencyKey?: string;
}

/** A fresh idempotency key for one user intent. */
export const intentKey = (): string => crypto.randomUUID();

/** Sends with the access token, refreshing once on 401; throws ApiError on failure. */
async function request(path: string, opts: RequestOptions, accept: string): Promise<Response> {
  const auth = opts.auth ?? true;
  if (auth && current && current.expiresAt - Date.now() < 30_000) await refreshSession();

  const send = () => {
    const headers: Record<string, string> = { accept };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (auth && current) headers['authorization'] = `Bearer ${current.token}`;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    return fetch(path, {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  };

  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && auth && current) {
      if (await refreshSession()) res = await send();
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'No connection. Check your internet and try again.');
  }

  if (!res.ok) throw await parseError(res);
  return res;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(path, opts, 'application/json');
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** For downloads (CSV exports): same auth and refresh rules, body returned as a Blob. */
export async function apiBlob(path: string, opts: RequestOptions = {}): Promise<Blob> {
  const res = await request(path, opts, '*/*');
  return res.blob();
}
