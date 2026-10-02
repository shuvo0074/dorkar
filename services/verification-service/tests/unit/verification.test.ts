import { VerificationStatuses } from '@dorkar/contracts';
import { describe, expect, it } from 'vitest';
import {
  ageOn,
  assertCanSubmitNid,
  canTransition,
  normalizeNid,
  parseIsoDate,
  validateNidSubmission,
  type VerificationStatus,
} from '../../src/domain/verification';

const TODAY = new Date('2026-10-02T10:00:00Z');
const valid = { nidNumber: '1234567890', dateOfBirth: '1990-05-17', fullName: 'Rahim Uddin' };

describe('NID normalization', () => {
  it('accepts 10, 13 and 17 digits', () => {
    expect(normalizeNid('1234567890')).toBe('1234567890');
    expect(normalizeNid('1234567890123')).toBe('1234567890123');
    expect(normalizeNid('19901234567890123')).toBe('19901234567890123');
  });

  it('converts Bengali digits and drops spaces and dashes', () => {
    expect(normalizeNid('১২৩৪৫৬৭৮৯০')).toBe('1234567890');
    expect(normalizeNid('১২৩ ৪৫৬-৭৮৯০')).toBe('1234567890');
    expect(normalizeNid(' 123-456-7890 ')).toBe('1234567890');
  });

  it('rejects other lengths and non-digits', () => {
    for (const bad of [
      '',
      '123456789',
      '12345678901',
      '123456789012',
      '12345678901234',
      '1234567890123456',
      '123456789012345678',
      '12345678X0',
      '+1234567890',
      '١٢٣٤٥٦٧٨٩٠', // Arabic-Indic digits are not Bengali
    ]) {
      expect(normalizeNid(bad), bad).toBeNull();
    }
  });
});

describe('date of birth', () => {
  it('parses strict calendar dates', () => {
    expect(parseIsoDate('2000-02-29')).toEqual({ y: 2000, m: 2, d: 29 });
    expect(parseIsoDate('2001-02-29')).toBeNull();
    expect(parseIsoDate('1990-13-01')).toBeNull();
    expect(parseIsoDate('17/05/1990')).toBeNull();
    expect(parseIsoDate('1990-5-17')).toBeNull();
  });

  it('computes age by calendar day', () => {
    expect(ageOn({ y: 2008, m: 10, d: 2 }, TODAY)).toBe(18);
    expect(ageOn({ y: 2008, m: 10, d: 3 }, TODAY)).toBe(17);
    expect(ageOn({ y: 2008, m: 11, d: 1 }, TODAY)).toBe(17);
  });
});

describe('NID submission validation', () => {
  it('returns normalized data and last4', () => {
    expect(
      validateNidSubmission(
        { ...valid, nidNumber: '১২৩৪৫৬৭৮৯০', fullName: '  Rahim   Uddin ' },
        TODAY,
      ),
    ).toEqual({
      nid: '1234567890',
      dateOfBirth: '1990-05-17',
      fullName: 'Rahim Uddin',
      last4: '7890',
    });
  });

  it('accepts exactly 18 today, rejects 17 as UNDERAGE', () => {
    expect(() =>
      validateNidSubmission({ ...valid, dateOfBirth: '2008-10-02' }, TODAY),
    ).not.toThrow();
    expect(() => validateNidSubmission({ ...valid, dateOfBirth: '2008-10-03' }, TODAY)).toThrow(
      expect.objectContaining({ code: 'BUSINESS_RULE_VIOLATION', details: { rule: 'UNDERAGE' } }),
    );
  });

  it('names the bad field and never echoes the value', () => {
    const cases: Array<[Partial<typeof valid>, string]> = [
      [{ nidNumber: '12345' }, 'nidNumber'],
      [{ dateOfBirth: '1990-02-30' }, 'dateOfBirth'],
      [{ dateOfBirth: '2030-01-01' }, 'dateOfBirth'],
      [{ dateOfBirth: '1850-01-01' }, 'dateOfBirth'],
      [{ fullName: 'R' }, 'fullName'],
      [{ fullName: 'x'.repeat(81) }, 'fullName'],
      [{ fullName: 'Rahim 123' }, 'fullName'],
    ];
    for (const [patch, field] of cases) {
      try {
        validateNidSubmission({ ...valid, ...patch }, TODAY);
        expect.fail(`expected ${field} to fail`);
      } catch (err) {
        const e = err as { code: string; details: unknown; message: string };
        expect(e.code).toBe('VALIDATION_FAILED');
        expect(e.details).toEqual({ field });
        for (const v of Object.values(patch)) expect(e.message).not.toContain(v);
      }
    }
  });

  it('accepts Bengali names', () => {
    expect(validateNidSubmission({ ...valid, fullName: 'রহিম উদ্দিন' }, TODAY).fullName).toBe(
      'রহিম উদ্দিন',
    );
  });
});

describe('verification state machine', () => {
  const allowed: Record<VerificationStatus, VerificationStatus[]> = {
    PENDING: ['VERIFIED', 'REJECTED'],
    VERIFIED: ['REVOKED', 'EXPIRED'],
    REJECTED: ['PENDING'],
    REVOKED: ['PENDING'],
    EXPIRED: ['PENDING'],
  };

  it('allows exactly the listed transitions', () => {
    for (const from of VerificationStatuses) {
      for (const to of VerificationStatuses) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(allowed[from].includes(to));
      }
    }
  });

  it('allows a new NID submission only without a pending or verified one', () => {
    expect(() => assertCanSubmitNid(null)).not.toThrow();
    for (const s of ['REJECTED', 'REVOKED', 'EXPIRED'] as const) {
      expect(() => assertCanSubmitNid(s)).not.toThrow();
    }
    expect(() => assertCanSubmitNid('PENDING')).toThrow(
      expect.objectContaining({ details: { rule: 'NID_PENDING' } }),
    );
    expect(() => assertCanSubmitNid('VERIFIED')).toThrow(
      expect.objectContaining({ details: { rule: 'NID_ALREADY_VERIFIED' } }),
    );
  });
});
