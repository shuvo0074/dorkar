import type { TransactionState } from '@dorkar/contracts';

/**
 * Reputation is a set of independent signals, never one opaque score. Raw facts (transactions,
 * reviews) are kept so new signals (response rate, account age, verification) can be derived
 * later without migrating old numbers.
 */
export const SignalNames = [
  'rating_average',
  'rating_count',
  'completed_count',
  'cancelled_count',
  'disputed_count',
  'distinct_counterparties',
] as const;
export type SignalName = (typeof SignalNames)[number];

/** Per-account counters derived from the transaction projection. */
export interface AccountStats {
  accountId: string;
  /** Transactions COMPLETED as buyer or seller. */
  completedCount: number;
  /** Transactions this account itself cancelled (the other party is not penalised). */
  cancelledCount: number;
  /** Transactions that went to DISPUTED (counted for both parties). */
  disputedCount: number;
  asSellerCompleted: number;
  asBuyerCompleted: number;
  /** Distinct accounts this account completed deals with. */
  distinctCounterparties: number;
}

export interface RatingInput {
  id: string;
  authorId: string;
  rating: number;
  createdAt: Date;
}

export interface RatingSummary {
  ratingAverage: number | null;
  /** Number of reviews that actually count towards the average (after the pair cap). */
  ratingCount: number;
}

export interface ReputationSignals extends RatingSummary {
  completedCount: number;
  cancelledCount: number;
  disputedCount: number;
  distinctCounterparties: number;
}

export const emptySignals = (): ReputationSignals => ({
  ratingAverage: null,
  ratingCount: 0,
  completedCount: 0,
  cancelledCount: 0,
  disputedCount: 0,
  distinctCounterparties: 0,
});

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Rating average for one subject, hardened against farming:
 *  - callers pass only VISIBLE reviews (moderated reviews never count);
 *  - per (author, subject) pair only the `pairCap` most recent reviews count, so two accounts
 *    repeating cheap deals with each other cannot inflate (or bomb) a rating: one counterpart
 *    can move the average by at most `pairCap` votes, and many distinct counterparts are needed
 *    to build a strong rating;
 *  - `ratingCount` is the number of counted reviews, so the count reflects the same input as
 *    the average.
 * Callers may pre-filter with the same cap in SQL; applying it again here is idempotent.
 */
export function summarizeRatings(rows: readonly RatingInput[], pairCap: number): RatingSummary {
  const byAuthor = new Map<string, RatingInput[]>();
  for (const r of rows) {
    const list = byAuthor.get(r.authorId) ?? [];
    list.push(r);
    byAuthor.set(r.authorId, list);
  }
  let sum = 0;
  let count = 0;
  for (const list of byAuthor.values()) {
    list.sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
    for (const r of list.slice(0, Math.max(0, pairCap))) {
      sum += r.rating;
      count += 1;
    }
  }
  return { ratingAverage: count === 0 ? null : round2(sum / count), ratingCount: count };
}

export function computeSignals(
  stats: AccountStats,
  ratings: readonly RatingInput[],
  pairCap: number,
): ReputationSignals {
  return {
    ...summarizeRatings(ratings, pairCap),
    completedCount: stats.completedCount,
    cancelledCount: stats.cancelledCount,
    disputedCount: stats.disputedCount,
    distinctCounterparties: stats.distinctCounterparties,
  };
}

export function toSignalRows(
  s: ReputationSignals,
): Array<{ signal: SignalName; value: number | null }> {
  return [
    { signal: 'rating_average', value: s.ratingAverage },
    { signal: 'rating_count', value: s.ratingCount },
    { signal: 'completed_count', value: s.completedCount },
    { signal: 'cancelled_count', value: s.cancelledCount },
    { signal: 'disputed_count', value: s.disputedCount },
    { signal: 'distinct_counterparties', value: s.distinctCounterparties },
  ];
}

export function fromSignalRows(
  rows: ReadonlyArray<{ signal: string; value: number | null }>,
): ReputationSignals {
  const s = emptySignals();
  const v = new Map(rows.map((r) => [r.signal, r.value]));
  s.ratingAverage = v.get('rating_average') ?? null;
  s.ratingCount = v.get('rating_count') ?? 0;
  s.completedCount = v.get('completed_count') ?? 0;
  s.cancelledCount = v.get('cancelled_count') ?? 0;
  s.disputedCount = v.get('disputed_count') ?? 0;
  s.distinctCounterparties = v.get('distinct_counterparties') ?? 0;
  return s;
}

/**
 * Accounts whose counters change when a transaction enters `to`:
 *  - COMPLETED / DISPUTED: both parties;
 *  - CANCELLED: only the party who cancelled (a system expiry or an admin is nobody's fault);
 *  - anything else: none.
 * Sorted so callers lock accounts in a stable order (no deadlocks).
 */
export function affectedAccounts(
  to: TransactionState,
  buyerId: string,
  sellerId: string,
  actorId: string | null,
): string[] {
  let ids: string[] = [];
  if (to === 'COMPLETED' || to === 'DISPUTED') ids = [buyerId, sellerId];
  else if (to === 'CANCELLED' && actorId && (actorId === buyerId || actorId === sellerId))
    ids = [actorId];
  return [...new Set(ids)].sort();
}
