import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Time-ordered UUID (RFC 9562 v7): 48-bit ms timestamp + 74 random bits. */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  let ts = nowMs;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** URL-safe random token with `bytes` bytes of entropy. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string | Buffer): Buffer =>
  createHash('sha256').update(value).digest();

export const hmacSha256 = (key: string | Buffer, value: string | Buffer): Buffer =>
  createHmac('sha256', key).update(value).digest();

/** Constant-time comparison that is also safe for different lengths. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Keyed pseudonymous hash for values we need to correlate but must not store raw
 * (IP addresses, device keys, phone numbers in rate-limit keys).
 */
export const pseudonymize = (key: string, value: string): string =>
  hmacSha256(key, value).toString('base64url').slice(0, 32);
