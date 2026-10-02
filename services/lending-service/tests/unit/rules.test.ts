import { describe, expect, it } from 'vitest';
import {
  assertCategoryLendable,
  assertMaxLoanDays,
  assertNoContactInfo,
  normalizeRequirements,
  type Requirements,
} from '../../src/domain/lend-item';
import {
  assertCanRequest,
  assertEligible,
  assertLoanWindow,
  START_GRACE_MS,
  UNKNOWN_BORROWER,
  unmetRequirements,
  type BorrowerFacts,
} from '../../src/domain/loan';

const req = (over: Partial<Requirements> = {}): Requirements => ({
  nidVerified: false,
  minCompletedDeals: 0,
  minRating: null,
  ...over,
});
const borrower = (over: Partial<BorrowerFacts> = {}): BorrowerFacts => ({
  ...UNKNOWN_BORROWER,
  ...over,
});

describe('eligibility (trust gate)', () => {
  it('lets anyone borrow an item without requirements', () => {
    expect(unmetRequirements(req(), UNKNOWN_BORROWER)).toEqual([]);
  });

  it('requires NID verification only when asked', () => {
    expect(unmetRequirements(req({ nidVerified: true }), borrower())).toEqual(['nidVerified']);
    expect(unmetRequirements(req({ nidVerified: true }), borrower({ nidVerified: true }))).toEqual(
      [],
    );
    expect(unmetRequirements(req(), borrower({ nidVerified: true }))).toEqual([]);
  });

  it('counts completed deals inclusively', () => {
    const r = req({ minCompletedDeals: 3 });
    expect(unmetRequirements(r, borrower({ completedCount: 2 }))).toEqual(['minCompletedDeals']);
    expect(unmetRequirements(r, borrower({ completedCount: 3 }))).toEqual([]);
  });

  it('treats "no ratings yet" as not meeting a rating requirement', () => {
    const r = req({ minRating: 4 });
    expect(unmetRequirements(r, borrower())).toEqual(['minRating']);
    expect(unmetRequirements(r, borrower({ ratingAverage: 3.99, ratingCount: 5 }))).toEqual([
      'minRating',
    ]);
    expect(unmetRequirements(r, borrower({ ratingAverage: 4, ratingCount: 1 }))).toEqual([]);
    expect(unmetRequirements(r, borrower({ ratingAverage: 4.5, ratingCount: 0 }))).toEqual([
      'minRating',
    ]);
  });

  it('reports every failed key and nothing about the borrower’s actual values', () => {
    const r = req({ nidVerified: true, minCompletedDeals: 1, minRating: 4 });
    try {
      assertEligible(r, borrower({ completedCount: 0, ratingAverage: 2, ratingCount: 3 }));
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({
        code: 'BUSINESS_RULE_VIOLATION',
        details: {
          rule: 'BORROWER_NOT_ELIGIBLE',
          failed: ['nidVerified', 'minCompletedDeals', 'minRating'],
        },
      });
      expect(JSON.stringify((err as { details: unknown }).details)).not.toMatch(/\b2\b|\b3\b/);
    }
    expect(() =>
      assertEligible(
        r,
        borrower({ nidVerified: true, completedCount: 1, ratingAverage: 4, ratingCount: 1 }),
      ),
    ).not.toThrow();
  });
});

describe('request rules', () => {
  const now = new Date('2026-10-02T10:00:00.000Z');
  const at = (ms: number) => new Date(now.getTime() + ms);
  const DAY = 86_400_000;
  const ruleOf = (fn: () => void) => {
    try {
      fn();
      return null;
    } catch (err) {
      return (err as { details?: { rule?: string } }).details?.rule ?? 'unknown';
    }
  };

  it('checks the period', () => {
    expect(ruleOf(() => assertLoanWindow({ startAt: at(DAY), returnBy: at(DAY) }, 7, now))).toBe(
      'INVALID_LOAN_PERIOD',
    );
    expect(ruleOf(() => assertLoanWindow({ startAt: at(DAY), returnBy: at(0) }, 7, now))).toBe(
      'INVALID_LOAN_PERIOD',
    );
    expect(
      ruleOf(() =>
        assertLoanWindow({ startAt: at(-START_GRACE_MS - 1), returnBy: at(DAY) }, 7, now),
      ),
    ).toBe('LOAN_START_IN_PAST');
    expect(
      ruleOf(() => assertLoanWindow({ startAt: at(-START_GRACE_MS), returnBy: at(DAY) }, 7, now)),
    ).toBeNull();
    expect(
      ruleOf(() => assertLoanWindow({ startAt: at(0), returnBy: at(7 * DAY) }, 7, now)),
    ).toBeNull();
    expect(
      ruleOf(() => assertLoanWindow({ startAt: at(0), returnBy: at(7 * DAY + 1) }, 7, now)),
    ).toBe('LOAN_TOO_LONG');
  });

  it('refuses own items and items off the shelf', () => {
    expect(ruleOf(() => assertCanRequest({ lenderId: 'a', active: true }, 'a'))).toBe('OWN_ITEM');
    expect(ruleOf(() => assertCanRequest({ lenderId: 'a', active: false }, 'b'))).toBe(
      'ITEM_NOT_AVAILABLE',
    );
    expect(ruleOf(() => assertCanRequest({ lenderId: 'a', active: true }, 'b'))).toBeNull();
  });
});

describe('lend item rules', () => {
  it('blocks contact details in public text', () => {
    expect(() => assertNoContactInfo('title', 'Drill, call 01712345678')).toThrow(/phone number/);
    expect(() => assertNoContactInfo('description', 'mail me x@y.com')).toThrow(/email/);
    expect(() => assertNoContactInfo('title', 'Bosch drill, 18V')).not.toThrow();
    expect(() => assertNoContactInfo('title', undefined)).not.toThrow();
  });

  it('only allows active categories that permit BORROW', () => {
    const c = { categoryId: 'c', modes: ['BORROW' as const], active: true };
    expect(() => assertCategoryLendable(c)).not.toThrow();
    expect(() => assertCategoryLendable(null)).toThrow();
    expect(() => assertCategoryLendable({ ...c, active: false })).toThrow();
    expect(() => assertCategoryLendable({ ...c, modes: ['BUY', 'RENT'] })).toThrow();
  });

  it('caps the loan length', () => {
    expect(() => assertMaxLoanDays(60, 60)).not.toThrow();
    expect(() => assertMaxLoanDays(61, 60)).toThrow(
      expect.objectContaining({ details: { rule: 'MAX_LOAN_DAYS_EXCEEDED', limit: 60 } }),
    );
  });

  it('keeps ratings to two decimals', () => {
    expect(normalizeRequirements(req({ minRating: 4.256 })).minRating).toBe(4.26);
    expect(normalizeRequirements(req()).minRating).toBeNull();
  });
});
