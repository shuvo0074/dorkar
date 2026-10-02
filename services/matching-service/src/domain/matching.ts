import {
  Districts,
  type Condition,
  type DeliveryMode,
  type District,
  type Division,
  type NeedMode,
  type SellerRole,
} from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

// ---------------------------------------------------------------- scoring inputs

export type ListingKind = 'PRODUCT' | 'SERVICE' | 'RENTAL';
export type PriceUnit = 'TOTAL' | 'PER_UNIT' | 'PER_HOUR' | 'PER_DAY';

/** The facts of an OPEN need that matching scores against (amounts in poisha). */
export interface ScoringNeed {
  needId: string;
  requesterId: string;
  mode: NeedMode;
  categoryId: string;
  /** Parent of the need's category, from the category projection (null if top-level/unknown). */
  categoryParentId: string | null;
  quantity: number;
  budgetMax: number | null;
  conditions: Condition[];
  district: District;
  attributes: Record<string, unknown>;
}

export interface ListingCandidate {
  type: 'LISTING';
  listingId: string;
  sellerId: string;
  categoryId: string;
  categoryParentId: string | null;
  kind: ListingKind;
  condition: Condition | null;
  priceAmount: number;
  priceUnit: PriceUnit;
  quantityAvailable: number;
  district: District;
  attributes: Record<string, unknown>;
  deliveryModes: DeliveryMode[];
  available: boolean;
}

export interface SellerCandidate {
  type: 'SELLER';
  sellerId: string;
  roles: SellerRole[];
  categoryIds: string[];
  serviceDistricts: District[];
  deliveryModes: DeliveryMode[];
  active: boolean;
}

export type Candidate = ListingCandidate | SellerCandidate;
export type CandidateType = Candidate['type'];

export interface SellerSignals {
  ratingAverage: number | null;
  completedCount: number;
  nidVerified: boolean;
}

export const NO_SIGNALS: SellerSignals = {
  ratingAverage: null,
  completedCount: 0,
  nidVerified: false,
};

export const candidateListingId = (c: Candidate): string | null =>
  c.type === 'LISTING' ? c.listingId : null;

// ---------------------------------------------------------------- compatibility tables

/** Which seller roles can fulfil a need of each mode. */
export const RolesForMode: Readonly<Record<NeedMode, readonly SellerRole[]>> = {
  BUY: ['SELLER'],
  RENT: ['SELLER', 'LENDER'],
  BORROW: ['LENDER'],
  HIRE: ['SERVICE_PROVIDER'],
  SOURCE: ['SUPPLIER', 'SELLER'],
};

/** Which listing kinds can fulfil a need of each mode. */
export const KindsForMode: Readonly<Record<NeedMode, readonly ListingKind[]>> = {
  BUY: ['PRODUCT'],
  SOURCE: ['PRODUCT'],
  RENT: ['RENTAL'],
  BORROW: ['RENTAL'],
  HIRE: ['SERVICE'],
};

const invert = <K extends string, V extends string>(m: Readonly<Record<K, readonly V[]>>) => {
  const out = new Map<V, K[]>();
  for (const [k, vs] of Object.entries(m) as [K, readonly V[]][]) {
    for (const v of vs) out.set(v, [...(out.get(v) ?? []), k]);
  }
  return out;
};
const modesByKind = invert(KindsForMode);
const modesByRole = invert(RolesForMode);

export const modesForKind = (kind: ListingKind): NeedMode[] => modesByKind.get(kind) ?? [];
export const modesForRoles = (roles: readonly SellerRole[]): NeedMode[] => [
  ...new Set(roles.flatMap((r) => modesByRole.get(r) ?? [])),
];

// ---------------------------------------------------------------- geography

export const divisionOf = (d: District): Division => Districts[d].division;

const districtsByDivision = new Map<Division, District[]>();
for (const [d, info] of Object.entries(Districts) as [District, { division: Division }][]) {
  districtsByDivision.set(info.division, [...(districtsByDivision.get(info.division) ?? []), d]);
}

/** Every district sharing a division with any of `districts` (the SQL location prefilter). */
export const districtsNear = (districts: readonly District[]): District[] => [
  ...new Set(districts.flatMap((d) => districtsByDivision.get(divisionOf(d)) ?? [])),
];

export const delivers = (modes: readonly DeliveryMode[]) => modes.includes('SELLER_DELIVERY');

// ---------------------------------------------------------------- match lifecycle

export const MatchStatuses = ['NEW', 'DISMISSED', 'RESPONDED', 'CLOSED'] as const;
export type MatchStatus = (typeof MatchStatuses)[number];

export type MatchAction = 'DISMISS' | 'RESPOND' | 'CLOSE';

/**
 * Allowed transitions. A seller may dismiss a fresh match; making an offer marks it responded
 * (even after dismissing); the need leaving OPEN closes everything. CLOSED is terminal except
 * for `reopenedStatus` when the need is published again.
 */
export const MatchTransitions: Readonly<
  Record<MatchStatus, Partial<Record<MatchAction, MatchStatus>>>
> = {
  NEW: { DISMISS: 'DISMISSED', RESPOND: 'RESPONDED', CLOSE: 'CLOSED' },
  DISMISSED: { RESPOND: 'RESPONDED', CLOSE: 'CLOSED' },
  RESPONDED: { CLOSE: 'CLOSED' },
  CLOSED: {},
};

/** States from which `action` is allowed (used for guarded bulk updates). */
export const fromStatesFor = (action: MatchAction): MatchStatus[] =>
  MatchStatuses.filter((s) => MatchTransitions[s][action] !== undefined);

export function transition(from: MatchStatus, action: MatchAction): MatchStatus {
  const to = MatchTransitions[from][action];
  if (!to) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      `Cannot ${action.toLowerCase()} a ${from.toLowerCase()} match.`,
      {
        from,
        action,
      },
    );
  }
  return to;
}

/** Every action has exactly one target state. */
const Targets: Readonly<Record<MatchAction, MatchStatus>> = {
  DISMISS: 'DISMISSED',
  RESPOND: 'RESPONDED',
  CLOSE: 'CLOSED',
};
export const targetFor = (action: MatchAction): MatchStatus => Targets[action];

/** When a CLOSED match qualifies again (need re-published), restore what the seller had done. */
export function reopenedStatus(m: {
  respondedAt: Date | null;
  dismissedAt: Date | null;
}): MatchStatus {
  if (m.respondedAt) return 'RESPONDED';
  if (m.dismissedAt) return 'DISMISSED';
  return 'NEW';
}

/** Status after re-scoring an existing match that still qualifies: never resets seller choices. */
export const rescoredStatus = (m: {
  status: MatchStatus;
  respondedAt: Date | null;
  dismissedAt: Date | null;
}): MatchStatus => (m.status === 'CLOSED' ? reopenedStatus(m) : m.status);

/** Statuses a re-score may retire when the seller no longer qualifies (responded ones stay). */
export const RETIRABLE: readonly MatchStatus[] = ['NEW', 'DISMISSED'];

// ---------------------------------------------------------------- selection

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  reasons: Record<string, number>;
}

/** Deterministic order: score desc, listings before capabilities, then by id. */
export function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.candidate.type !== b.candidate.type) return a.candidate.type === 'LISTING' ? -1 : 1;
  const ak = `${a.candidate.sellerId}:${candidateListingId(a.candidate) ?? ''}`;
  const bk = `${b.candidate.sellerId}:${candidateListingId(b.candidate) ?? ''}`;
  return ak < bk ? -1 : ak > bk ? 1 : 0;
}

/**
 * One match per seller per need: keep each seller's best candidate, drop anything under
 * `minScore`, and keep the top `max`.
 */
export function selectBestPerSeller(
  scored: readonly ScoredCandidate[],
  minScore: number,
  max: number,
): ScoredCandidate[] {
  const best = new Map<string, ScoredCandidate>();
  for (const s of scored) {
    if (s.score < minScore) continue;
    const cur = best.get(s.candidate.sellerId);
    if (!cur || compareScored(s, cur) < 0) best.set(s.candidate.sellerId, s);
  }
  return [...best.values()].sort(compareScored).slice(0, max);
}
