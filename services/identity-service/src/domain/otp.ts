import { randomInt } from 'node:crypto';
import { hmacSha256, safeEqual } from '@dorkar/kernel';

/** All OTP knobs are configuration, never constants in use cases. */
export interface OtpPolicy {
  length: number;
  ttlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  perPhonePerHour: number;
  perPhonePerDay: number;
  perIpPerHour: number;
  perDevicePerHour: number;
  globalPerMinute: number;
  verifyPerIpPerHour: number;
  /** Exhausted challenges within the window that lock the phone out of new requests. */
  lockoutAfterExhausted: number;
  lockoutWindowSeconds: number;
}

/** Uniformly random numeric code from a CSPRNG. */
export function generateOtp(length: number, rand: (max: number) => number = randomInt): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String(rand(10));
  return out;
}

/**
 * Codes are stored as HMAC(pepper, challengeId:code). The pepper lives outside the DB, so a
 * database leak alone does not allow offline brute force of the 10^6 space; binding to the
 * challenge ID makes hashes non-reusable across challenges.
 */
export const hashOtp = (pepper: string, challengeId: string, otp: string): Buffer =>
  hmacSha256(pepper, `${challengeId}:${otp}`);

export const otpMatches = (pepper: string, challengeId: string, otp: string, stored: Buffer) =>
  safeEqual(hashOtp(pepper, challengeId, otp), stored);

/**
 * SMS body. The trailing `@domain #code` line enables the WebOTP API (Android Chrome autofill).
 */
export function otpMessage(otp: string, ttlSeconds: number, webOtpDomain?: string): string {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  const body = `Your Dorkar code is ${otp}. Valid for ${minutes} min. Never share it with anyone.`;
  return webOtpDomain ? `${body}\n\n@${webOtpDomain} #${otp}` : body;
}
