import { randomToken, sha256 } from '@dorkar/kernel';

export interface SessionPolicy {
  accessTokenTtlSeconds: number;
  /** A refresh token unused for this long expires (sliding). */
  refreshIdleTtlSeconds: number;
  /** Hard cap on a session's lifetime regardless of activity. */
  sessionAbsoluteTtlSeconds: number;
}

export type RevokeReason =
  'LOGOUT' | 'LOGOUT_ALL' | 'DEVICE_REVOKED' | 'REFRESH_TOKEN_REUSE' | 'ACCOUNT_STATUS_CHANGED';

export const sessionExpiry = (now: Date, p: SessionPolicy) =>
  new Date(now.getTime() + p.sessionAbsoluteTtlSeconds * 1000);

/** Sliding refresh expiry, never beyond the session's absolute expiry. */
export const refreshExpiry = (now: Date, sessionExpiresAt: Date, p: SessionPolicy) =>
  new Date(Math.min(now.getTime() + p.refreshIdleTtlSeconds * 1000, sessionExpiresAt.getTime()));

/** Opaque 256-bit refresh token; only its SHA-256 is stored. */
export function newRefreshToken(): { token: string; hash: Buffer } {
  const token = randomToken(32);
  return { token, hash: hashRefreshToken(token) };
}

export const hashRefreshToken = (token: string): Buffer => sha256(token);
