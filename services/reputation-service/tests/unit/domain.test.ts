import { describe, expect, it } from 'vitest';
import {
  assertNoContactInfo,
  DAY_MS,
  reviewEligibility,
  type TransactionView,
} from '../../src/domain/review';
import {
  affectedAccounts,
  computeSignals,
  fromSignalRows,
  summarizeRatings,
  toSignalRows,
  type AccountStats,
  type RatingInput,
} from '../../src/domain/signals';

const BUYER = '00000000-0000-7000-8000-00000000000b';
const SELLER = '00000000-0000-7000-8000-00000000000s';
const OTHER = '00000000-0000-7000-8000-00000000000o';
const completedAt = new Date('2026-01-01T00:00:00Z');
const tx = (over: Partial<TransactionView> = {}): TransactionView => ({
  id: 't1',
  buyerId: BUYER,
  sellerId: SELLER,
  state: 'COMPLETED',
  completedAt,
  ...over,
});
const at = (ms: number) => new Date(completedAt.getTime() + ms);
const ruleOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (
      (e as { code: string; details?: { rule?: string } }).details?.rule ??
      (e as { code: string }).code
    );
  }
  return 'OK';
};

describe('review eligibility', () => {
  it('sets the subject to the other party and the role from the author', () => {
    expect(reviewEligibility(tx(), BUYER, at(1), 30)).toEqual({
      subjectId: SELLER,
      authorRole: 'BUYER',
    });
    expect(reviewEligibility(tx(), SELLER, at(1), 30)).toEqual({
      subjectId: BUYER,
      authorRole: 'SELLER',
    });
  });

  it('hides transactions from non-parties and unknown ids (404)', () => {
    expect(ruleOf(() => reviewEligibility(tx(), OTHER, at(1), 30))).toBe('NOT_FOUND');
    expect(ruleOf(() => reviewEligibility(null, BUYER, at(1), 30))).toBe('NOT_FOUND');
  });

  it('requires a completed transaction', () => {
    for (const state of [
      'CREATED',
      'CONFIRMED',
      'DELIVERY_PENDING',
      'DELIVERED',
      'CANCELLED',
      'DISPUTED',
      'REFUNDED',
      'EXPIRED',
    ] as const) {
      expect(
        ruleOf(() => reviewEligibility(tx({ state, completedAt: null }), BUYER, at(1), 30)),
      ).toBe('TRANSACTION_NOT_COMPLETED');
    }
  });

  it('closes the window exactly after REVIEW_WINDOW_DAYS (boundary inclusive)', () => {
    expect(ruleOf(() => reviewEligibility(tx(), BUYER, at(30 * DAY_MS), 30))).toBe('OK');
    expect(ruleOf(() => reviewEligibility(tx(), BUYER, at(30 * DAY_MS + 1), 30))).toBe(
      'REVIEW_WINDOW_CLOSED',
    );
    expect(ruleOf(() => reviewEligibility(tx(), BUYER, at(0), 30))).toBe('OK');
  });

  it('never lets an account review itself', () => {
    expect(ruleOf(() => reviewEligibility(tx({ sellerId: BUYER }), BUYER, at(1), 30))).toBe(
      'SELF_REVIEW',
    );
  });

  it('blocks contact details in review text', () => {
    expect(ruleOf(() => assertNoContactInfo('review', 'call 01712345678'))).toBe('NO_CONTACT_INFO');
    expect(ruleOf(() => assertNoContactInfo('review', 'mail me a@b.com'))).toBe('NO_CONTACT_INFO');
    expect(ruleOf(() => assertNoContactInfo('review', 'Great seller, 10/10'))).toBe('OK');
    expect(ruleOf(() => assertNoContactInfo('review', null))).toBe('OK');
  });
});

const r = (
  authorId: string,
  rating: number,
  minutes: number,
  id = `${authorId}-${minutes}`,
): RatingInput => ({
  id,
  authorId,
  rating,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, minutes)),
});

describe('pair-capped rating average', () => {
  it('is null with no reviews', () => {
    expect(summarizeRatings([], 3)).toEqual({ ratingAverage: null, ratingCount: 0 });
  });

  it('counts only the most recent PAIR_CAP reviews per author', () => {
    // A rated 1 long ago, then 5,5,5: only the last three count.
    const rows = [r('A', 1, 0), r('A', 5, 1), r('A', 5, 2), r('A', 5, 3)];
    expect(summarizeRatings(rows, 3)).toEqual({ ratingAverage: 5, ratingCount: 3 });
  });

  it('stops one counterpart from farming the average', () => {
    const farm = Array.from({ length: 10 }, (_, i) => r('FRIEND', 5, i));
    const honest = [r('B', 2, 0), r('C', 2, 0), r('D', 2, 0)];
    // uncapped would be (50 + 6) / 13 ≈ 4.31; capped is (15 + 6) / 6 = 3.5
    expect(summarizeRatings([...farm, ...honest], 3)).toEqual({
      ratingAverage: 3.5,
      ratingCount: 6,
    });
  });

  it('breaks timestamp ties by id and rounds to two decimals', () => {
    const rows = [r('A', 1, 0, 'a1'), r('A', 5, 0, 'a2'), r('B', 4, 0), r('C', 4, 0)];
    // cap 1: A keeps the higher id (a2 → 5); avg (5+4+4)/3 = 4.333…
    expect(summarizeRatings(rows, 1)).toEqual({ ratingAverage: 4.33, ratingCount: 3 });
  });
});

describe('signals', () => {
  const stats: AccountStats = {
    accountId: SELLER,
    completedCount: 7,
    cancelledCount: 1,
    disputedCount: 2,
    asSellerCompleted: 5,
    asBuyerCompleted: 2,
    distinctCounterparties: 4,
  };

  it('combines counters and the capped rating into separate signals', () => {
    const s = computeSignals(stats, [r('A', 4, 0), r('B', 5, 0)], 3);
    expect(s).toEqual({
      ratingAverage: 4.5,
      ratingCount: 2,
      completedCount: 7,
      cancelledCount: 1,
      disputedCount: 2,
      distinctCounterparties: 4,
    });
    const rows = toSignalRows(s);
    expect(rows.map((x) => x.signal).sort()).toEqual([
      'cancelled_count',
      'completed_count',
      'disputed_count',
      'distinct_counterparties',
      'rating_average',
      'rating_count',
    ]);
    expect(fromSignalRows(rows)).toEqual(s);
  });

  it('defaults missing signals to zero / null', () => {
    expect(fromSignalRows([])).toMatchObject({
      ratingAverage: null,
      ratingCount: 0,
      completedCount: 0,
    });
  });

  it('attributes state changes to the right accounts', () => {
    expect(affectedAccounts('COMPLETED', BUYER, SELLER, BUYER)).toEqual([BUYER, SELLER].sort());
    expect(affectedAccounts('DISPUTED', BUYER, SELLER, SELLER)).toEqual([BUYER, SELLER].sort());
    expect(affectedAccounts('CANCELLED', BUYER, SELLER, SELLER)).toEqual([SELLER]);
    expect(affectedAccounts('CANCELLED', BUYER, SELLER, null)).toEqual([]);
    expect(affectedAccounts('CANCELLED', BUYER, SELLER, OTHER)).toEqual([]);
    for (const to of [
      'CREATED',
      'CONFIRMED',
      'DELIVERY_PENDING',
      'DELIVERED',
      'REFUNDED',
      'EXPIRED',
    ] as const) {
      expect(affectedAccounts(to, BUYER, SELLER, BUYER)).toEqual([]);
    }
  });
});
