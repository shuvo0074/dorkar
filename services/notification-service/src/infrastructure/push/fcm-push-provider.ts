import { importPKCS8, SignJWT } from 'jose';
import { z } from 'zod';
import type { PushProvider, PushResult } from '../../application/ports';
import type { PushMessage, PushTarget } from '../../domain/push';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_ENDPOINT = 'https://fcm.googleapis.com/v1/projects';
/** Refresh this long before the access token expires. */
const EXPIRY_SKEW_MS = 60_000;

export const ServiceAccountSchema = z.object({
  project_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  client_email: z.email(),
  private_key: z.string().includes('PRIVATE KEY'),
  token_uri: z.url().default('https://oauth2.googleapis.com/token'),
});
export type ServiceAccount = z.output<typeof ServiceAccountSchema>;

/** FCM_SERVICE_ACCOUNT_JSON is the service-account JSON, base64-encoded. Throws if malformed. */
export function parseServiceAccount(base64: string): ServiceAccount {
  const json: unknown = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  return ServiceAccountSchema.parse(json);
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

const FcmErrorBody = z.object({
  error: z.object({
    status: z.string().optional(),
    details: z.array(z.object({ errorCode: z.string().optional() }).loose()).optional(),
  }),
});

/** FCM says the token itself is unusable: deactivate the device rather than retry. */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH']);

class TokenError extends Error {
  override name = 'FcmTokenError';
}

/**
 * Firebase Cloud Messaging HTTP v1. Authenticates as the service account: an RS256 JWT assertion
 * (signed with `jose`) is exchanged for an OAuth access token, cached until shortly before it
 * expires (single-flight, so a burst of sends makes one exchange). Never logs tokens or bodies.
 */
export class FcmPushProvider implements PushProvider {
  private access: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  private key: ReturnType<typeof importPKCS8> | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    private readonly opts: {
      serviceAccount: ServiceAccount;
      /** Absolute base for web push click-through links (e.g. https://dorkar.com.bd). */
      publicBaseUrl: string;
      fetch?: typeof fetch;
      now?: () => number;
      timeoutMs?: number;
    },
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  async send(device: PushTarget, message: PushMessage): Promise<PushResult> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (err) {
      return { retryable: true, error: err instanceof Error ? err.name : 'FcmTokenError' };
    }
    const sa = this.opts.serviceAccount;
    let res: Response;
    try {
      res = await this.fetch(`${FCM_ENDPOINT}/${encodeURIComponent(sa.project_id)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: this.payload(device, message) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      return { retryable: true, error: err instanceof Error ? err.name : 'FcmNetworkError' };
    }
    if (res.ok) return { ok: true };
    if (res.status === 401) this.access = null; // revoked or expired early: re-authenticate

    const body = FcmErrorBody.safeParse(await res.json().catch(() => null));
    const codes = body.success
      ? [
          ...(body.data.error.details ?? []).flatMap((d) => (d.errorCode ? [d.errorCode] : [])),
          ...(body.data.error.status ? [body.data.error.status] : []),
        ]
      : [];
    if (codes.some((c) => DEAD_TOKEN_CODES.has(c))) return { invalidToken: true };
    return { retryable: true, error: `FCM_${res.status}${codes[0] ? `_${codes[0]}` : ''}` };
  }

  private payload(device: PushTarget, m: PushMessage): Record<string, unknown> {
    const data = { notificationId: m.notificationId, type: m.type, path: m.path };
    const base = { token: device.token, notification: { title: m.title, body: m.body }, data };
    switch (device.platform) {
      case 'ANDROID':
        // Same tag → a coalesced notification replaces its earlier push on the device.
        return { ...base, android: { priority: 'HIGH', notification: { tag: m.notificationId } } };
      case 'IOS':
        return { ...base, apns: { headers: { 'apns-collapse-id': m.notificationId } } };
      case 'WEB':
        return {
          ...base,
          webpush: {
            notification: { tag: m.notificationId },
            fcm_options: { link: new URL(m.path, this.opts.publicBaseUrl).toString() },
          },
        };
    }
  }

  /** Cached access token; one exchange in flight at a time. */
  private async accessToken(): Promise<string> {
    if (this.access && this.now() < this.access.expiresAt - EXPIRY_SKEW_MS) {
      return this.access.token;
    }
    this.pending ??= this.exchange().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async exchange(): Promise<string> {
    const sa = this.opts.serviceAccount;
    this.key ??= importPKCS8(sa.private_key, 'RS256').catch((err: unknown) => {
      this.key = null;
      throw err;
    });
    const nowSec = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(sa.client_email)
      .setSubject(sa.client_email)
      .setAudience(sa.token_uri)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 3600)
      .sign(await this.key);

    const res = await this.fetch(sa.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new TokenError(`token exchange failed (${res.status})`);
    const t = TokenResponse.parse(await res.json());
    this.access = { token: t.access_token, expiresAt: this.now() + t.expires_in * 1000 };
    return t.access_token;
  }
}
