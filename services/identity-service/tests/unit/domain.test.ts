import { describe, expect, it } from 'vitest';
import { assertStatusTransition, effectiveRoles } from '../../src/domain/account';
import { generateOtp, hashOtp, otpMatches, otpMessage } from '../../src/domain/otp';
import { newRefreshToken, refreshExpiry, sessionExpiry } from '../../src/domain/session';

describe('otp', () => {
  it('generates numeric codes of the configured length', () => {
    for (let i = 0; i < 200; i++) expect(generateOtp(6)).toMatch(/^\d{6}$/);
  });

  it('is roughly uniform across digits', () => {
    const counts = new Array(10).fill(0);
    for (const ch of generateOtp(20_000)) counts[Number(ch)]++;
    for (const c of counts) expect(c).toBeGreaterThan(1700);
  });

  it('binds the hash to the pepper and the challenge', () => {
    const h = hashOtp('pepper-a', 'c1', '123456');
    expect(otpMatches('pepper-a', 'c1', '123456', h)).toBe(true);
    expect(otpMatches('pepper-a', 'c1', '123457', h)).toBe(false);
    expect(otpMatches('pepper-a', 'c2', '123456', h)).toBe(false);
    expect(otpMatches('pepper-b', 'c1', '123456', h)).toBe(false);
  });

  it('formats a WebOTP-compatible message when a domain is configured', () => {
    expect(otpMessage('123456', 300)).toContain('123456');
    expect(otpMessage('123456', 300, 'dorkar.com.bd').endsWith('@dorkar.com.bd #123456')).toBe(
      true,
    );
  });
});

describe('account', () => {
  it('always includes MEMBER and de-duplicates', () => {
    expect(effectiveRoles([])).toEqual(['MEMBER']);
    expect(effectiveRoles(['ADMIN', 'MEMBER'])).toEqual(['MEMBER', 'ADMIN']);
  });

  it.each([
    ['ACTIVE', 'SUSPENDED'],
    ['SUSPENDED', 'ACTIVE'],
    ['BANNED', 'ACTIVE'],
    ['ACTIVE', 'DELETED'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(() => assertStatusTransition(from, to)).not.toThrow();
  });

  it.each([
    ['DELETED', 'ACTIVE'],
    ['DELETED', 'SUSPENDED'],
  ] as const)('rejects %s → %s', (from, to) => {
    expect(() => assertStatusTransition(from, to)).toThrow(/cannot move/);
  });
});

describe('session policy', () => {
  const policy = {
    accessTokenTtlSeconds: 600,
    refreshIdleTtlSeconds: 100,
    sessionAbsoluteTtlSeconds: 1000,
  };
  const now = new Date('2026-01-01T00:00:00Z');

  it('slides refresh expiry but never past the absolute session expiry', () => {
    const sessionEnd = sessionExpiry(now, policy);
    expect(refreshExpiry(now, sessionEnd, policy).getTime() - now.getTime()).toBe(100_000);
    const late = new Date(sessionEnd.getTime() - 10_000);
    expect(refreshExpiry(late, sessionEnd, policy)).toEqual(sessionEnd);
  });

  it('creates high-entropy refresh tokens and stores only a hash', () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    expect(a.token).toHaveLength(43);
    expect(a.token).not.toBe(b.token);
    expect(a.hash.toString('hex')).not.toContain(a.token);
  });
});
