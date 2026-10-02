import { describe, expect, it } from 'vitest';
import type {
  ListingCandidate,
  ScoringNeed,
  SellerCandidate,
  SellerSignals,
} from '../../src/domain/matching';
import { NO_SIGNALS } from '../../src/domain/matching';
import { RulesScorerV1, type MatchScore } from '../../src/domain/scoring';

const CAT = '00000000-0000-7000-8000-000000000001';
const PARENT = '00000000-0000-7000-8000-000000000002';
const CHILD = '00000000-0000-7000-8000-000000000003';
const OTHER = '00000000-0000-7000-8000-000000000004';
const BUYER = '00000000-0000-7000-8000-0000000000b0';
const SELLER = '00000000-0000-7000-8000-0000000000c0';

const scorer = new RulesScorerV1();

const need = (o: Partial<ScoringNeed> = {}): ScoringNeed => ({
  needId: '00000000-0000-7000-8000-0000000000a0',
  requesterId: BUYER,
  mode: 'BUY',
  categoryId: CAT,
  categoryParentId: PARENT,
  quantity: 1,
  budgetMax: null,
  conditions: [],
  district: 'dhaka',
  attributes: {},
  ...o,
});

const listing = (o: Partial<ListingCandidate> = {}): ListingCandidate => ({
  type: 'LISTING',
  listingId: '00000000-0000-7000-8000-0000000000d0',
  sellerId: SELLER,
  categoryId: CAT,
  categoryParentId: PARENT,
  kind: 'PRODUCT',
  condition: 'NEW',
  priceAmount: 100_00,
  priceUnit: 'TOTAL',
  quantityAvailable: 1,
  district: 'dhaka',
  attributes: {},
  deliveryModes: [],
  available: true,
  ...o,
});

const seller = (o: Partial<SellerCandidate> = {}): SellerCandidate => ({
  type: 'SELLER',
  sellerId: SELLER,
  roles: ['SELLER'],
  categoryIds: [CAT],
  serviceDistricts: ['dhaka'],
  deliveryModes: [],
  active: true,
  ...o,
});

const sig = (o: Partial<SellerSignals> = {}): SellerSignals => ({ ...NO_SIGNALS, ...o });

const score = (n: ScoringNeed, c: ListingCandidate | SellerCandidate, s = NO_SIGNALS) => {
  const r = scorer.score(n, c, s);
  expect(r).not.toBeNull();
  return r as MatchScore;
};

const sum = (r: MatchScore) => Object.values(r.reasons).reduce((a, b) => a + b, 0);

describe('hard filters', () => {
  it('passes a plain compatible listing', () => {
    expect(scorer.rejection(need(), listing())).toBeNull();
  });

  it('never matches the requester with themselves', () => {
    expect(scorer.rejection(need(), listing({ sellerId: BUYER }))).toBe('SELF');
    expect(scorer.rejection(need(), seller({ sellerId: BUYER }))).toBe('SELF');
    expect(scorer.score(need(), listing({ sellerId: BUYER }), NO_SIGNALS)).toBeNull();
  });

  it('requires the same, parent or child category', () => {
    expect(
      scorer.rejection(need(), listing({ categoryId: PARENT, categoryParentId: null })),
    ).toBeNull();
    expect(
      scorer.rejection(need(), listing({ categoryId: CHILD, categoryParentId: CAT })),
    ).toBeNull();
    expect(scorer.rejection(need(), listing({ categoryId: OTHER, categoryParentId: PARENT }))).toBe(
      'CATEGORY',
    ); // sibling
    expect(scorer.rejection(need(), listing({ categoryId: OTHER, categoryParentId: null }))).toBe(
      'CATEGORY',
    );
    expect(scorer.rejection(need(), seller({ categoryIds: [PARENT] }))).toBeNull();
    expect(scorer.rejection(need(), seller({ categoryIds: [OTHER] }))).toBe('CATEGORY');
    expect(
      scorer.rejection(need({ categoryParentId: null }), seller({ categoryIds: [PARENT] })),
    ).toBe('CATEGORY');
  });

  it.each([
    ['BUY', ['SELLER'], ['LENDER', 'SERVICE_PROVIDER', 'SUPPLIER']],
    ['RENT', ['SELLER', 'LENDER'], ['SERVICE_PROVIDER', 'SUPPLIER']],
    ['BORROW', ['LENDER'], ['SELLER', 'SERVICE_PROVIDER', 'SUPPLIER']],
    ['HIRE', ['SERVICE_PROVIDER'], ['SELLER', 'LENDER', 'SUPPLIER']],
    ['SOURCE', ['SUPPLIER', 'SELLER'], ['LENDER', 'SERVICE_PROVIDER']],
  ] as const)('mode %s accepts roles %j and rejects %j', (mode, ok, bad) => {
    for (const r of ok) expect(scorer.rejection(need({ mode }), seller({ roles: [r] }))).toBeNull();
    for (const r of bad)
      expect(scorer.rejection(need({ mode }), seller({ roles: [r] }))).toBe('ROLE');
  });

  it.each([
    ['BUY', 'PRODUCT'],
    ['SOURCE', 'PRODUCT'],
    ['RENT', 'RENTAL'],
    ['BORROW', 'RENTAL'],
    ['HIRE', 'SERVICE'],
  ] as const)('mode %s accepts only %s listings', (mode, kind) => {
    for (const k of ['PRODUCT', 'RENTAL', 'SERVICE'] as const) {
      const c = listing({ kind: k, condition: null });
      expect(scorer.rejection(need({ mode }), c)).toBe(k === kind ? null : 'KIND');
    }
  });

  it('rejects inactive sellers', () => {
    expect(scorer.rejection(need(), seller({ active: false }))).toBe('INACTIVE');
  });

  it('rejects unavailable or sold-out listings', () => {
    expect(scorer.rejection(need(), listing({ available: false }))).toBe('UNAVAILABLE');
    expect(scorer.rejection(need(), listing({ quantityAvailable: 0 }))).toBe('UNAVAILABLE');
  });

  it('allows up to 25% over budget, using the total for per-unit prices', () => {
    const n = need({ budgetMax: 100_00 });
    expect(scorer.rejection(n, listing({ priceAmount: 125_00 }))).toBeNull();
    expect(scorer.rejection(n, listing({ priceAmount: 125_01 }))).toBe('OVER_BUDGET');
    const n3 = need({ budgetMax: 300_00, quantity: 3 });
    expect(scorer.rejection(n3, listing({ priceAmount: 130_00, priceUnit: 'PER_UNIT' }))).toBe(
      'OVER_BUDGET',
    );
    expect(scorer.rejection(n3, listing({ priceAmount: 130_00, priceUnit: 'TOTAL' }))).toBeNull();
    expect(scorer.rejection(need(), listing({ priceAmount: 10 ** 10 }))).toBeNull(); // no budget
  });

  it('requires a listed condition when the need asks for some', () => {
    const n = need({ conditions: ['USED', 'REFURBISHED'] });
    expect(scorer.rejection(n, listing({ condition: 'USED' }))).toBeNull();
    expect(scorer.rejection(n, listing({ condition: 'NEW' }))).toBe('CONDITION');
    expect(scorer.rejection(n, listing({ condition: null }))).toBe('CONDITION');
    expect(scorer.rejection(n, seller())).toBeNull(); // capabilities carry no condition
  });

  it('requires the candidate in the need’s division or delivering to it', () => {
    expect(scorer.rejection(need(), listing({ district: 'gazipur' }))).toBeNull();
    expect(scorer.rejection(need(), listing({ district: 'sylhet' }))).toBe('OUT_OF_REACH');
    expect(
      scorer.rejection(need(), listing({ district: 'sylhet', deliveryModes: ['SELLER_DELIVERY'] })),
    ).toBeNull();
    expect(scorer.rejection(need(), seller({ serviceDistricts: ['sylhet'] }))).toBe('OUT_OF_REACH');
    expect(scorer.rejection(need(), seller({ serviceDistricts: [] }))).toBe('OUT_OF_REACH');
  });
});

describe('scoring factors', () => {
  const base = { location: 25, category: 30 };

  it('category: exact 30, related (parent or child) 18', () => {
    expect(score(need(), listing()).reasons['category']).toBe(30);
    expect(
      score(need(), listing({ categoryId: PARENT, categoryParentId: null })).reasons['category'],
    ).toBe(18);
    expect(
      score(need(), listing({ categoryId: CHILD, categoryParentId: CAT })).reasons['category'],
    ).toBe(18);
    expect(score(need(), seller({ categoryIds: [PARENT] })).reasons['category']).toBe(18);
    expect(score(need(), seller({ categoryIds: [PARENT, CAT] })).reasons['category']).toBe(30);
  });

  it('location: same district 25, same division 12, delivers 8', () => {
    expect(score(need(), listing()).reasons['location']).toBe(25);
    expect(score(need(), listing({ district: 'gazipur' })).reasons['location']).toBe(12);
    expect(
      score(need(), listing({ district: 'sylhet', deliveryModes: ['SELLER_DELIVERY'] })).reasons[
        'location'
      ],
    ).toBe(8);
    // Best applicable tier only, never added up.
    expect(score(need(), listing({ deliveryModes: ['SELLER_DELIVERY'] })).reasons['location']).toBe(
      25,
    );
    // Capabilities: serving the need's district counts as same district.
    expect(
      score(need(), seller({ serviceDistricts: ['sylhet', 'dhaka'] })).reasons['location'],
    ).toBe(25);
    expect(score(need(), seller({ serviceDistricts: ['narayanganj'] })).reasons['location']).toBe(
      12,
    );
    expect(
      score(need(), seller({ serviceDistricts: [], deliveryModes: ['SELLER_DELIVERY'] })).reasons[
        'location'
      ],
    ).toBe(8);
  });

  it('budget: within 20, within 10% over 10, otherwise 0; none without a budget', () => {
    const n = need({ budgetMax: 100_00 });
    expect(score(n, listing({ priceAmount: 100_00 })).reasons['budget']).toBe(20);
    expect(score(n, listing({ priceAmount: 110_00 })).reasons['budget']).toBe(10);
    expect(score(n, listing({ priceAmount: 110_01 })).reasons['budget']).toBe(0);
    expect(score(n, listing({ priceAmount: 50_00, priceUnit: 'PER_UNIT' })).reasons['budget']).toBe(
      20,
    );
    expect(
      score(
        need({ budgetMax: 100_00, quantity: 2 }),
        listing({ priceAmount: 55_00, priceUnit: 'PER_UNIT' }),
      ).reasons['budget'],
    ).toBe(10);
    expect(score(need(), listing()).reasons['budget']).toBe(0);
    expect(score(n, seller()).reasons['budget']).toBe(0);
  });

  it('condition: 10 when the listing has a requested condition', () => {
    expect(score(need({ conditions: ['NEW'] }), listing()).reasons['condition']).toBe(10);
    expect(score(need(), listing()).reasons['condition']).toBe(0);
    expect(score(need({ conditions: ['NEW'] }), seller()).reasons['condition']).toBe(0);
  });

  it('attributes: share of the need’s attributes with equal values, up to 10', () => {
    const n = need({ attributes: { brand: 'Walton', storage: 128, color: 'black', ram: 8 } });
    const l = listing({ attributes: { brand: ' walton ', storage: 128, color: 'blue', extra: 1 } });
    expect(score(n, l).reasons['attributes']).toBe(5);
    expect(
      score(n, listing({ attributes: { brand: 'Walton', storage: 128, color: 'black', ram: 8 } }))
        .reasons['attributes'],
    ).toBe(10);
    expect(
      score(need({ attributes: { a: 1, b: 2, c: 3 } }), listing({ attributes: { a: 1 } })).reasons[
        'attributes'
      ],
    ).toBe(3.33);
    expect(score(need(), listing({ attributes: { a: 1 } })).reasons['attributes']).toBe(0);
    expect(score(n, seller()).reasons['attributes']).toBe(0);
  });

  it('reputation: rating/5 × 7 + min(completed, 10) × 0.3', () => {
    expect(
      score(need(), listing(), sig({ ratingAverage: 5, completedCount: 10 })).reasons['reputation'],
    ).toBe(10);
    expect(
      score(need(), listing(), sig({ ratingAverage: 4, completedCount: 3 })).reasons['reputation'],
    ).toBe(6.5);
    expect(
      score(need(), listing(), sig({ ratingAverage: null, completedCount: 50 })).reasons[
        'reputation'
      ],
    ).toBe(3);
    expect(score(need(), listing(), NO_SIGNALS).reasons['reputation']).toBe(0);
  });

  it('verification: NID verified 5', () => {
    expect(score(need(), listing(), sig({ nidVerified: true })).reasons['verification']).toBe(5);
    expect(score(need(), listing()).reasons['verification']).toBe(0);
  });

  it('scores a bare capability with listing factors at 0', () => {
    const r = score(need({ budgetMax: 1, conditions: ['NEW'], attributes: { a: 1 } }), seller());
    expect(r).toEqual({
      score: 55,
      reasons: { ...base, budget: 0, condition: 0, attributes: 0, reputation: 0, verification: 0 },
    });
  });
});

describe('totals and explainability', () => {
  it('reasons always add up to the score', () => {
    const cases: [ScoringNeed, ListingCandidate | SellerCandidate, SellerSignals][] = [
      [need(), listing(), NO_SIGNALS],
      [
        need({ attributes: { a: 1, b: 2, c: 3 } }),
        listing({ attributes: { a: 1 } }),
        sig({ ratingAverage: 3.33, completedCount: 7 }),
      ],
      [
        need({ budgetMax: 100_00 }),
        listing({ district: 'gazipur', priceAmount: 105_00 }),
        sig({ ratingAverage: 4.71 }),
      ],
      [need(), seller({ categoryIds: [PARENT] }), sig({ nidVerified: true, completedCount: 2 })],
    ];
    for (const [n, c, s] of cases) {
      const r = score(n, c, s);
      expect(sum(r)).toBeCloseTo(r.score, 10);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it('caps at 100 with an explicit negative `cap` reason', () => {
    const r = score(
      need({ budgetMax: 100_00, conditions: ['NEW'], attributes: { brand: 'Walton' } }),
      listing({ attributes: { brand: 'Walton' } }),
      sig({ ratingAverage: 5, completedCount: 20, nidVerified: true }),
    );
    // 30 + 25 + 20 + 10 + 10 + 10 + 5 = 110
    expect(r.score).toBe(100);
    expect(r.reasons['cap']).toBe(-10);
    expect(sum(r)).toBeCloseTo(100, 10);
  });

  it('omits `cap` when under 100 and is deterministic', () => {
    const args = [need({ budgetMax: 100_00 }), listing(), sig({ ratingAverage: 4.2 })] as const;
    const a = score(...args);
    expect(a.reasons).not.toHaveProperty('cap');
    expect(score(...args)).toEqual(a);
    expect(scorer.name).toBe('rules@v1');
  });
});
