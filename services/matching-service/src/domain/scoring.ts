import {
  delivers,
  divisionOf,
  KindsForMode,
  RolesForMode,
  type Candidate,
  type ListingCandidate,
  type ScoringNeed,
  type SellerSignals,
} from './matching';

export interface MatchScore {
  /** 0..100, equal to the sum of `reasons`. */
  score: number;
  /** Points per factor, so every score can be explained to sellers and buyers. */
  reasons: Record<string, number>;
}

/**
 * Port for match scoring. Pure: same inputs, same output. `null` means a hard filter failed.
 * Rules today; an ML scorer can replace or wrap this behind the same interface.
 */
export interface MatchScorer {
  readonly name: string;
  score(need: ScoringNeed, candidate: Candidate, signals: SellerSignals): MatchScore | null;
}

export type HardFilter =
  | 'SELF'
  | 'CATEGORY'
  | 'ROLE'
  | 'KIND'
  | 'INACTIVE'
  | 'UNAVAILABLE'
  | 'OVER_BUDGET'
  | 'CONDITION'
  | 'OUT_OF_REACH';

export const Points = {
  categoryExact: 30,
  categoryRelated: 18,
  sameDistrict: 25,
  sameDivision: 12,
  sellerDelivers: 8,
  budgetWithin: 20,
  budgetNear: 10,
  condition: 10,
  attributesMax: 10,
  ratingMax: 7,
  perCompleted: 0.3,
  completedCap: 10,
  nidVerified: 5,
  max: 100,
} as const;

/** Listings may exceed the budget by up to 25% and still be shown (with fewer points). */
export const BUDGET_TOLERANCE = 1.25;
const BUDGET_NEAR = 1.1;

type CategoryFit = 'EXACT' | 'RELATED' | null;

function categoryFit(need: ScoringNeed, c: Candidate): CategoryFit {
  if (c.type === 'LISTING') {
    if (c.categoryId === need.categoryId) return 'EXACT';
    if (
      (need.categoryParentId !== null && c.categoryId === need.categoryParentId) ||
      c.categoryParentId === need.categoryId
    ) {
      return 'RELATED';
    }
    return null;
  }
  if (c.categoryIds.includes(need.categoryId)) return 'EXACT';
  if (need.categoryParentId !== null && c.categoryIds.includes(need.categoryParentId)) {
    return 'RELATED';
  }
  return null;
}

/** What the buyer would pay for the requested quantity (poisha). */
export const effectivePrice = (need: ScoringNeed, l: ListingCandidate): number =>
  l.priceUnit === 'PER_UNIT' ? l.priceAmount * need.quantity : l.priceAmount;

function locationPoints(need: ScoringNeed, c: Candidate): number {
  const division = divisionOf(need.district);
  const districts = c.type === 'LISTING' ? [c.district] : c.serviceDistricts;
  if (districts.includes(need.district)) return Points.sameDistrict;
  if (districts.some((d) => divisionOf(d) === division)) return Points.sameDivision;
  if (delivers(c.deliveryModes)) return Points.sellerDelivers;
  return 0;
}

const normalize = (v: unknown): string =>
  typeof v === 'string' ? v.trim().toLowerCase() : JSON.stringify(v);

/** Share of the need's attributes the listing has with an equal value, scaled to 10. */
function attributePoints(need: ScoringNeed, l: ListingCandidate): number {
  const keys = Object.keys(need.attributes);
  if (keys.length === 0) return 0;
  const equal = keys.filter(
    (k) =>
      Object.hasOwn(l.attributes, k) &&
      normalize(l.attributes[k]) === normalize(need.attributes[k]),
  ).length;
  return (Points.attributesMax * equal) / keys.length;
}

function reputationPoints(s: SellerSignals): number {
  const rating =
    s.ratingAverage === null
      ? 0
      : (Math.min(Math.max(s.ratingAverage, 0), 5) / 5) * Points.ratingMax;
  return (
    rating + Math.min(Math.max(s.completedCount, 0), Points.completedCap) * Points.perCompleted
  );
}

/** Rounded to hundredths, in integer arithmetic so reasons always sum exactly to the score. */
const cents = (x: number) => Math.round(x * 100);

/**
 * Deterministic, explainable rules (v1). Hard filters reject; factors add points; the total
 * is capped at 100 with an explicit negative `cap` reason so `sum(reasons) === score`.
 */
export class RulesScorerV1 implements MatchScorer {
  readonly name = 'rules@v1';

  /** The first hard filter the candidate fails, or null if it may be scored. */
  rejection(need: ScoringNeed, c: Candidate): HardFilter | null {
    if (c.sellerId === need.requesterId) return 'SELF';
    if (categoryFit(need, c) === null) return 'CATEGORY';
    if (c.type === 'SELLER') {
      if (!c.active) return 'INACTIVE';
      if (!c.roles.some((r) => RolesForMode[need.mode].includes(r))) return 'ROLE';
    } else {
      if (!KindsForMode[need.mode].includes(c.kind)) return 'KIND';
      if (!c.available || c.quantityAvailable < 1) return 'UNAVAILABLE';
      if (need.budgetMax !== null && effectivePrice(need, c) > need.budgetMax * BUDGET_TOLERANCE) {
        return 'OVER_BUDGET';
      }
      if (
        need.conditions.length > 0 &&
        (c.condition === null || !need.conditions.includes(c.condition))
      ) {
        return 'CONDITION';
      }
    }
    // Same as the SQL prefilter: the candidate is in the need's division or delivers to it.
    if (locationPoints(need, c) === 0) return 'OUT_OF_REACH';
    return null;
  }

  score(need: ScoringNeed, c: Candidate, signals: SellerSignals): MatchScore | null {
    if (this.rejection(need, c) !== null) return null;

    const factors: Record<string, number> = {
      category: categoryFit(need, c) === 'EXACT' ? Points.categoryExact : Points.categoryRelated,
      location: locationPoints(need, c),
      budget: 0,
      condition: 0,
      attributes: 0,
      reputation: reputationPoints(signals),
      verification: signals.nidVerified ? Points.nidVerified : 0,
    };
    if (c.type === 'LISTING') {
      if (need.budgetMax !== null) {
        const price = effectivePrice(need, c);
        factors['budget'] =
          price <= need.budgetMax
            ? Points.budgetWithin
            : price <= need.budgetMax * BUDGET_NEAR
              ? Points.budgetNear
              : 0;
      }
      if (
        need.conditions.length > 0 &&
        c.condition !== null &&
        need.conditions.includes(c.condition)
      ) {
        factors['condition'] = Points.condition;
      }
      factors['attributes'] = attributePoints(need, c);
    }

    const reasons: Record<string, number> = {};
    let total = 0;
    for (const [k, v] of Object.entries(factors)) {
      const c100 = cents(v);
      reasons[k] = c100 / 100;
      total += c100;
    }
    const over = total - Points.max * 100;
    if (over > 0) {
      reasons['cap'] = -over / 100;
      total -= over;
    }
    return { score: total / 100, reasons };
  }
}
