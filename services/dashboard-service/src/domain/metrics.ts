/**
 * Platform counters. Each is incremented exactly once per domain event (in the inbox
 * transaction) on the Asia/Dhaka day the event occurred. Dimensioned counters also write the
 * total under dimension '' so totals never need a scan over dimensions.
 */
export const Metrics = [
  'signups',
  'logins',
  'needs_published',
  'listings_published',
  'offers_submitted',
  'offers_accepted',
  'transactions_created',
  'transactions_completed',
  /** Sum of completed deal amounts, in poisha. */
  'gmv_completed',
  'transactions_cancelled',
  'disputes_opened',
  'disputes_resolved',
  'reviews_created',
  'auctions_opened',
  'bids_placed',
  'auctions_awarded',
  'bookings_confirmed',
  'loans_approved',
  'messages_sent',
  'verifications',
] as const;
export type Metric = (typeof Metrics)[number];

export interface Increment {
  metric: Metric;
  /** '' is the total; otherwise e.g. `mode:BUY`, `source:OFFER`, `resolution:RELEASE`, `NID:PENDING`. */
  dimension: string;
  by: number;
}

/** The total plus one row per dimension. */
export const count = (metric: Metric, dimensions: readonly string[] = [], by = 1): Increment[] => [
  { metric, dimension: '', by },
  ...dimensions.map((dimension) => ({ metric, dimension, by })),
];

/** Collapses duplicate keys so one upsert statement never touches a row twice. */
export function mergeIncrements(incs: readonly Increment[]): Increment[] {
  const out = new Map<string, Increment>();
  for (const i of incs) {
    if (i.by === 0) continue;
    const key = `${i.metric}\u0000${i.dimension}`;
    const cur = out.get(key);
    if (cur) cur.by += i.by;
    else out.set(key, { ...i });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- gauge / dashboard status sets

export const OPEN_DISPUTE_STATUSES = ['OPEN', 'AWAITING_RESPONSE', 'UNDER_REVIEW'] as const;
/** Offers waiting for the buyer to answer. */
export const AWAITING_BUYER_OFFER_STATUSES = ['SUBMITTED', 'COUNTERED_BY_SELLER'] as const;
export const UPCOMING_BOOKING_STATUSES = ['CONFIRMED'] as const;
export const ACTIVE_BOOKING_STATUSES = ['ACTIVE'] as const;
/** Approved and not yet concluded: the item is about to go out, is out, or is being returned. */
export const ACTIVE_LOAN_STATUSES = ['APPROVED', 'LENT', 'RETURN_REPORTED', 'DISPUTED'] as const;

// ---------------------------------------------------------------- ordering guard

export interface StatusVersion<S extends string = string> {
  status: S | null;
  at: Date | null;
}

/**
 * Whether a status event may overwrite the projected status. Events carry no aggregate version,
 * so the event time is the version: a newer event wins; on an exact tie the event wins only if
 * its `from` matches the current status (a from/to guard). Events without a `from` (creation
 * facts such as OfferSubmitted) never win a tie.
 */
export function shouldApply(
  current: StatusVersion | null,
  event: { from: string | null; at: Date },
): boolean {
  if (!current || current.status === null || current.at === null) return true;
  const a = event.at.getTime();
  const c = current.at.getTime();
  if (a !== c) return a > c;
  return event.from !== null && event.from === current.status;
}
