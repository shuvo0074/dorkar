import { NeedModes, OfferStatuses, type OfferStatus } from '@dorkar/contracts';
import type { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  assertCanAccept,
  assertCanAct,
  assertCanSubmit,
  availableActions,
  isLive,
  nextStatus,
  offerExpiry,
  parseModeTerms,
  partyOf,
  refusal,
  transitionTable,
  type NeedSnapshot,
  type NegotiationView,
  type SubmitFacts,
} from '../../src/domain/offer';

const settings = { maxRounds: 5 };
const now = new Date('2026-10-01T10:00:00Z');
const later = new Date(now.getTime() + 3_600_000);

const view = (over: Partial<NegotiationView> = {}): NegotiationView => ({
  status: 'SUBMITTED',
  awaiting: 'BUYER',
  currentRound: 1,
  expiresAt: later,
  hidden: false,
  ...over,
});

const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    const err = e as AppError;
    return { code: err.code, ...(err.details ?? {}) } as Record<string, unknown>;
  }
  return null;
};

describe('negotiation state machine', () => {
  const LIVE: OfferStatus[] = ['SUBMITTED', 'COUNTERED_BY_BUYER', 'COUNTERED_BY_SELLER'];

  it('has exactly three live statuses', () => {
    expect(OfferStatuses.filter(isLive)).toEqual(LIVE);
  });

  // Exhaustive: every status × whose turn × caller × action.
  it.each(transitionTable(settings, now))(
    '$status (awaiting $awaiting): $party $action → allowed=$allowed',
    ({ status, awaiting, party, action, allowed }) => {
      const expected =
        isLive(status) &&
        (action === 'REJECT'
          ? party === 'BUYER'
          : action === 'WITHDRAW'
            ? party === 'SELLER'
            : party === awaiting);
      expect(allowed).toBe(expected);
    },
  );

  it('maps actions to the next status', () => {
    expect(nextStatus('ACCEPT', 'BUYER')).toBe('ACCEPTED');
    expect(nextStatus('ACCEPT', 'SELLER')).toBe('ACCEPTED');
    expect(nextStatus('COUNTER', 'BUYER')).toBe('COUNTERED_BY_BUYER');
    expect(nextStatus('COUNTER', 'SELLER')).toBe('COUNTERED_BY_SELLER');
    expect(nextStatus('REJECT', 'BUYER')).toBe('REJECTED');
    expect(nextStatus('WITHDRAW', 'SELLER')).toBe('WITHDRAWN');
  });

  it('explains refusals with stable codes', () => {
    expect(codeOf(() => assertCanAct(view(), 'SELLER', 'ACCEPT', now, settings))).toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      reason: 'NOT_YOUR_TURN',
      awaiting: 'BUYER',
    });
    expect(codeOf(() => assertCanAct(view(), 'SELLER', 'REJECT', now, settings))).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(codeOf(() => assertCanAct(view(), 'BUYER', 'WITHDRAW', now, settings))).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      codeOf(() => assertCanAct(view({ status: 'REJECTED' }), 'BUYER', 'ACCEPT', now, settings)),
    ).toMatchObject({ code: 'INVALID_STATE_TRANSITION', from: 'REJECTED' });
    expect(
      codeOf(() => assertCanAct(view({ expiresAt: now }), 'BUYER', 'ACCEPT', now, settings)),
    ).toMatchObject({ code: 'INVALID_STATE_TRANSITION', reason: 'OFFER_EXPIRED' });
  });

  it('limits rounds: the awaited party can still accept at the limit, not counter', () => {
    const atLimit = view({ currentRound: 5 });
    expect(codeOf(() => assertCanAct(atLimit, 'BUYER', 'COUNTER', now, settings))).toMatchObject({
      code: 'BUSINESS_RULE_VIOLATION',
      rule: 'MAX_ROUNDS',
    });
    expect(refusal(view({ currentRound: 4 }), 'BUYER', 'COUNTER', now, settings)).toBeNull();
    expect(availableActions(atLimit, 'BUYER', now, settings)).toEqual(['ACCEPT', 'REJECT']);
  });

  it('freezes negotiation on hidden offers but lets parties walk away', () => {
    const hidden = view({ hidden: true });
    expect(availableActions(hidden, 'BUYER', now, settings)).toEqual(['REJECT']);
    expect(availableActions(hidden, 'SELLER', now, settings)).toEqual(['WITHDRAW']);
  });
});

describe('actions per caller', () => {
  it.each([
    ['SUBMITTED', 'BUYER', 'BUYER', ['ACCEPT', 'COUNTER', 'REJECT']],
    ['SUBMITTED', 'BUYER', 'SELLER', ['WITHDRAW']],
    ['COUNTERED_BY_BUYER', 'SELLER', 'SELLER', ['ACCEPT', 'COUNTER', 'WITHDRAW']],
    ['COUNTERED_BY_BUYER', 'SELLER', 'BUYER', ['REJECT']],
    ['COUNTERED_BY_SELLER', 'BUYER', 'BUYER', ['ACCEPT', 'COUNTER', 'REJECT']],
    ['ACCEPTED', 'BUYER', 'BUYER', []],
    ['EXPIRED', 'BUYER', 'SELLER', []],
  ] as const)('%s awaiting %s, caller %s → %j', (status, awaiting, party, expected) => {
    expect(availableActions(view({ status, awaiting }), party, now, settings)).toEqual(expected);
  });

  it('gives a stranger nothing and an expired offer no actions', () => {
    expect(availableActions(view(), null, now, settings)).toEqual([]);
    expect(availableActions(view({ expiresAt: now }), 'BUYER', now, settings)).toEqual([]);
  });

  it('identifies the caller by account id', () => {
    const o = { buyerId: 'b', sellerId: 's' };
    expect(partyOf(o, 'b')).toBe('BUYER');
    expect(partyOf(o, 's')).toBe('SELLER');
    expect(partyOf(o, 'x')).toBeNull();
  });
});

const need = (over: Partial<NeedSnapshot> = {}): NeedSnapshot => ({
  needId: 'n',
  requesterId: 'buyer',
  mode: 'BUY',
  categoryId: 'c',
  title: 'Phone',
  quantity: 3,
  maxOffers: 2,
  expiresAt: later,
  status: 'OPEN',
  acceptedQuantity: 1,
  ...over,
});

describe('submission rules', () => {
  const facts = (over: Partial<SubmitFacts> = {}): SubmitFacts => ({
    need: need(),
    sellerId: 'seller',
    now,
    quantity: 2,
    activeOfferCount: 1,
    sellerHasLiveOffer: false,
    listingId: null,
    listing: null,
    ...over,
  });
  const ruleOf = (f: SubmitFacts) => codeOf(() => assertCanSubmit(f))?.['rule'] ?? null;

  it('accepts a valid offer', () => expect(ruleOf(facts())).toBeNull());
  it('needs an OPEN need', () =>
    expect(ruleOf(facts({ need: need({ status: 'PAUSED' }) }))).toBe('NEED_NOT_OPEN'));
  it('needs an unexpired need', () =>
    expect(ruleOf(facts({ need: need({ expiresAt: now }) }))).toBe('NEED_EXPIRED'));
  it('forbids offering on your own need', () =>
    expect(ruleOf(facts({ sellerId: 'buyer' }))).toBe('OWN_NEED'));
  it('allows one live offer per seller', () =>
    expect(codeOf(() => assertCanSubmit(facts({ sellerHasLiveOffer: true })))).toMatchObject({
      code: 'CONFLICT',
      rule: 'DUPLICATE_OFFER',
    }));
  it('caps offers per need', () =>
    expect(ruleOf(facts({ activeOfferCount: 2 }))).toBe('OFFER_LIMIT'));
  it('caps quantity at what is still needed', () => {
    expect(ruleOf(facts({ quantity: 3 }))).toBe('QUANTITY_EXCEEDS_NEED');
    expect(ruleOf(facts({ quantity: 2 }))).toBeNull();
  });
  it('only attaches own, available listings', () => {
    const l = { listingId: 'l', sellerId: 'seller', available: true };
    expect(ruleOf(facts({ listingId: 'l', listing: l }))).toBeNull();
    expect(ruleOf(facts({ listingId: 'l', listing: null }))).toBe('LISTING_NOT_OWNED');
    expect(ruleOf(facts({ listingId: 'l', listing: { ...l, sellerId: 'other' } }))).toBe(
      'LISTING_NOT_OWNED',
    );
    expect(ruleOf(facts({ listingId: 'l', listing: { ...l, available: false } }))).toBe(
      'LISTING_UNAVAILABLE',
    );
  });
});

describe('exclusive acceptance guard', () => {
  const offer = { ...view(), quantity: 1 };

  it('accepts while capacity remains', () => {
    expect(() =>
      assertCanAccept(offer, 'BUYER', need({ quantity: 1, acceptedQuantity: 0 }), now, settings),
    ).not.toThrow();
  });

  it('reports exhaustion, including for an offer the winner just expired', () => {
    const full = need({ quantity: 1, acceptedQuantity: 1 });
    expect(codeOf(() => assertCanAccept(offer, 'BUYER', full, now, settings))).toMatchObject({
      code: 'NEED_QUANTITY_EXHAUSTED',
      rule: 'NEED_QUANTITY_EXHAUSTED',
    });
    expect(
      codeOf(() => assertCanAccept({ ...offer, status: 'EXPIRED' }, 'BUYER', full, now, settings)),
    ).toMatchObject({ rule: 'NEED_QUANTITY_EXHAUSTED' });
  });

  it('refuses when the need is no longer open, or it is not the caller’s turn', () => {
    expect(
      codeOf(() =>
        assertCanAccept(
          offer,
          'BUYER',
          need({ status: 'CLOSED', acceptedQuantity: 0 }),
          now,
          settings,
        ),
      ),
    ).toMatchObject({ code: 'INVALID_STATE_TRANSITION', reason: 'NEED_NOT_OPEN' });
    expect(
      codeOf(() => assertCanAccept(offer, 'SELLER', need({ acceptedQuantity: 0 }), now, settings)),
    ).toMatchObject({ reason: 'NOT_YOUR_TURN' });
  });
});

describe('offer expiry', () => {
  const policy = { defaultTtlHours: 72, maxTtlDays: 14 };
  const far = new Date(now.getTime() + 30 * 86_400_000);

  it('defaults, honours a request, and never outlives the need', () => {
    expect(offerExpiry(now, undefined, policy, far).getTime()).toBe(now.getTime() + 72 * 3_600_000);
    expect(offerExpiry(now, 5, policy, far).getTime()).toBe(now.getTime() + 5 * 3_600_000);
    expect(offerExpiry(now, 100, policy, later)).toEqual(later);
  });

  it('rejects lifetimes beyond the policy maximum', () => {
    expect(() => offerExpiry(now, 14 * 24 + 1, policy, far)).toThrow(/at most 14 days/);
  });
});

describe('mode terms', () => {
  const valid: Record<(typeof NeedModes)[number], Record<string, unknown>> = {
    BUY: { warrantyMonths: 6 },
    RENT: { startAt: '2026-10-05T09:00:00Z', endAt: '2026-10-07T09:00:00Z', depositAmount: 500000 },
    BORROW: { returnBy: '2026-10-20' },
    HIRE: { serviceDate: '2026-10-10', durationHours: 4, scope: 'Paint two bedrooms' },
    SOURCE: { leadTimeDays: 21, sampleAvailable: true },
  };

  it.each(NeedModes)('accepts valid %s terms', (mode) => {
    expect(parseModeTerms(mode, valid[mode])).toEqual(valid[mode]);
  });

  it('allows empty BUY terms (all optional)', () => {
    expect(parseModeTerms('BUY', undefined)).toEqual({});
  });

  it.each([
    ['BUY', { warrantyMonths: -1 }],
    ['BUY', { leadTimeDays: 3 }],
    ['RENT', { startAt: '2026-10-07T09:00:00Z', endAt: '2026-10-05T09:00:00Z' }],
    ['RENT', {}],
    ['BORROW', { returnBy: 'tomorrow' }],
    ['HIRE', { serviceDate: '2026-10-10' }],
    ['SOURCE', { leadTimeDays: 1.5 }],
  ] as const)('rejects bad %s terms %j', (mode, terms) => {
    expect(codeOf(() => parseModeTerms(mode, terms))).toMatchObject({
      code: 'VALIDATION_FAILED',
      field: 'modeTerms',
    });
  });

  it('keeps phone numbers out of a service scope', () => {
    expect(
      codeOf(() =>
        parseModeTerms('HIRE', { serviceDate: '2026-10-10', scope: 'call me 01712345678' }),
      ),
    ).toMatchObject({ rule: 'NO_CONTACT_INFO' });
  });
});
