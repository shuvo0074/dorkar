/**
 * The one way the app talks to the API: the native twin of apps/web/src/lib/http.ts, with the
 * same exports. The access token lives in memory; the rotating refresh token lives in the
 * platform keychain (the server returns it in the body because of `x-client: mobile`). Refresh
 * is single-flight, because the server treats a reused refresh token as theft.
 */
import type { ErrorCode } from '@dorkar/contracts';
import * as Keychain from 'react-native-keychain';
import { API_URL } from '../config';

const SERVICE = 'dorkar.refresh';

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
  Keychain.resetGenericPassword({ service: SERVICE }).catch(() => {});
  if (had) listeners.forEach((l) => l(false));
}

export const hasAccessToken = () => current !== null;

export async function storeRefreshToken(token: string): Promise<void> {
  await Keychain.setGenericPassword('dorkar', token, {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

async function storedRefreshToken(): Promise<string | null> {
  try {
    const entry = await Keychain.getGenericPassword({ service: SERVICE });
    return entry ? entry.password : null;
  } catch {
    return null;
  }
}

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

/** Exchange the stored refresh token for a new access token. Resolves false when signed out. */
export function refreshSession(): Promise<boolean> {
  inflight ??= (async () => {
    const stored = await storedRefreshToken();
    if (!stored) {
      clearAccessToken();
      return false;
    }
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-client': 'mobile',
          accept: 'application/json',
        },
        body: JSON.stringify({ refreshToken: stored }),
      });
      if (!res.ok) {
        // A server fault says nothing about the token; only a rejection ends the session.
        if (res.status < 500) clearAccessToken();
        return false;
      }
      const { data } = (await res.json()) as {
        data: { accessToken: string; accessTokenExpiresAt: string; refreshToken: string };
      };
      await storeRefreshToken(data.refreshToken);
      setAccessToken(data.accessToken, data.accessTokenExpiresAt);
      return true;
    } catch {
      return false; // offline: keep whatever state we had
    }
  })().finally(() => {
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
   * and reuse it on retries, so a double tap never makes two offers.
   */
  idempotencyKey?: string;
}

/** "?a=1&b=x" from the defined, non-empty entries; "" when there are none. */
export function query(params: Record<string, string | number | boolean | null | undefined>) {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** One page of a cursor-paginated list, as every list endpoint returns it. */
export interface Page<T> {
  data: T[];
  page: { nextCursor: string | null };
}

/** A fresh idempotency key for one user intent. */
export const intentKey = (): string => crypto.randomUUID();

const isAbort = (err: unknown) => err instanceof Error && err.name === 'AbortError';

/** Sends with the access token, refreshing once on 401; throws ApiError on failure. */
async function request(path: string, opts: RequestOptions, accept: string): Promise<Response> {
  const auth = opts.auth ?? true;
  if (auth && current && current.expiresAt - Date.now() < 30_000) await refreshSession();

  const send = () => {
    const headers: Record<string, string> = { accept, 'x-client': 'mobile' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (auth && current) headers.authorization = `Bearer ${current.token}`;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    return fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers,
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
    if (isAbort(err)) throw err;
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

/** Same auth and refresh rules, body returned as a Blob. */
export async function apiBlob(path: string, opts: RequestOptions = {}): Promise<Blob> {
  const res = await request(path, opts, '*/*');
  return res.blob();
}
