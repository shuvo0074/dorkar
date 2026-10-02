import { describe, expect, it } from 'vitest';
import {
  availableActions,
  bidRefusal,
  canSee,
  draftAuction,
  extendedEndsAt,
  nextBidBound,
  retractRefusal,
  type Auction,
  type BidFacts,
  type CreateAuctionInput,
  type ListingSnapshot,
  type NeedSnapshot,
} from '../../src/domain/auction';

const now = new Date('2026-10-02T12:00:00.000Z');
const at = (ms: number) => new Date(now.getTime() + ms);
const bdt = (amount: number) => ({ amount, currency: 'BDT' as const });
const OWNER = 'owner';
const ME = 'me';

const auction = (over: Partial<BidFacts['auction']> = {}): BidFacts['auction'] => ({
  kind: 'FORWARD',
  ownerId: OWNER,
  status: 'OPEN',
  endsAt: at(3_600_000),
  hidden: false,
  startPrice: bdt(10_000),
  minIncrement: bdt(500),
  leadingAmount: null,
  leadingBidId: null,
  ...over,
});

const refuse = (a: BidFacts['auction'], amount: number, o: Partial<BidFacts> = {}) =>
  bidRefusal({ auction: a, leaderId: null, bidderId: ME, amount: bdt(amount), now, ...o });

const ruleOf = (e: ReturnType<typeof refuse>) => e?.details?.['rule'] ?? e?.details?.['reason'];

describe('bid rules — FORWARD (bids go up)', () => {
  it.each([
    [9_999, 'BID_TOO_LOW'],
    [10_000, null],
    [50_000, null],
  ])('first bid %i → %s (≥ opening price)', (amount, expected) => {
    expect(ruleOf(refuse(auction(), amount)) ?? null).toBe(expected);
  });

  it.each([
    [12_000, 'BID_TOO_LOW'],
    [12_499, 'BID_TOO_LOW'],
    [12_500, null],
    [20_000, null],
  ])('with leader at 12000 (+500): %i → %s', (amount, expected) => {
    const a = auction({ leadingAmount: bdt(12_000), leadingBidId: 'lead' });
    expect(ruleOf(refuse(a, amount, { leaderId: 'other' })) ?? null).toBe(expected);
  });

  it('reports the minimum the next bid must reach', () => {
    const e = refuse(auction({ leadingAmount: bdt(12_000), leadingBidId: 'x' }), 1, {
      leaderId: 'x-bidder',
    });
    expect(e?.details?.['minimum']).toEqual(bdt(12_500));
    expect(nextBidBound(auction())).toEqual({ minimum: bdt(10_000), maximum: null });
  });
});

describe('bid rules — REVERSE (bids go down)', () => {
  const rev = (o: Partial<BidFacts['auction']> = {}) => auction({ kind: 'REVERSE', ...o });

  it.each([
    [10_001, 'BID_TOO_HIGH'],
    [10_000, null],
    [1, null],
    [0, 'BID_TOO_LOW'],
  ])('first bid %i → %s (≤ ceiling, > 0)', (amount, expected) => {
    expect(ruleOf(refuse(rev(), amount)) ?? null).toBe(expected);
  });

  it.each([
    [8_000, 'BID_TOO_HIGH'],
    [7_501, 'BID_TOO_HIGH'],
    [7_500, null],
    [1, null],
    [0, 'BID_TOO_LOW'],
  ])('with leader at 8000 (−500): %i → %s', (amount, expected) => {
    const a = rev({ leadingAmount: bdt(8_000), leadingBidId: 'lead' });
    expect(ruleOf(refuse(a, amount, { leaderId: 'other' })) ?? null).toBe(expected);
  });

  it('cannot go below one poisha even when the decrement would allow nothing', () => {
    const a = rev({ leadingAmount: bdt(400), leadingBidId: 'l' });
    expect(nextBidBound(a)).toEqual({ minimum: bdt(1), maximum: bdt(-100) });
    expect(ruleOf(refuse(a, 1, { leaderId: 'other' }))).toBe('BID_TOO_HIGH');
  });
});

describe('bid rules — both kinds', () => {
  for (const kind of ['FORWARD', 'REVERSE'] as const) {
    const a = auction({ kind });

    it(`${kind}: the owner cannot bid`, () => {
      expect(ruleOf(refuse(a, 10_000, { bidderId: OWNER }))).toBe('OWN_AUCTION');
    });

    it(`${kind}: the leader cannot bid against themselves`, () => {
      const led = auction({ kind, leadingAmount: bdt(10_000), leadingBidId: 'l' });
      const e = refuse(led, kind === 'FORWARD' ? 99_000 : 1, { leaderId: ME });
      expect(e?.status).toBe(422);
      expect(ruleOf(e)).toBe('ALREADY_LEADING');
    });

    it(`${kind}: only while OPEN and before ends_at (DB clock)`, () => {
      for (const status of ['SCHEDULED', 'CLOSING', 'AWARDED', 'CANCELLED'] as const) {
        const e = refuse(auction({ kind, status }), 10_000);
        expect(e?.code).toBe('INVALID_STATE_TRANSITION');
        expect(e?.details?.['reason']).toBe('AUCTION_NOT_OPEN');
      }
      expect(ruleOf(refuse(auction({ kind, endsAt: now }), 10_000))).toBe('AUCTION_ENDED');
      expect(refuse(auction({ kind, endsAt: at(1) }), 10_000)).toBeNull();
    });

    it(`${kind}: hidden auctions take no bids`, () => {
      expect(ruleOf(refuse(auction({ kind, hidden: true }), 10_000))).toBe('AUCTION_HIDDEN');
    });
  }
});

describe('anti-sniping', () => {
  const ends = at(10 * 60_000);
  it('does nothing outside the window', () => {
    expect(extendedEndsAt(ends, now, 120)).toBe(ends);
    expect(extendedEndsAt(ends, at(8 * 60_000), 120)).toBe(ends); // exactly at the window edge
  });
  it('extends to now + window inside it', () => {
    const t = at(9 * 60_000);
    expect(extendedEndsAt(ends, t, 120).getTime()).toBe(t.getTime() + 120_000);
  });
  it('is off when the window is 0', () => {
    expect(extendedEndsAt(ends, at(10 * 60_000 - 1), 0)).toBe(ends);
  });
});

describe('retraction', () => {
  const ok: Parameters<typeof retractRefusal>[0] = {
    auction: { status: 'OPEN', endsAt: at(3_600_000) },
    bid: { status: 'LEADING', placedAt: at(-30_000) },
    now,
    windowSeconds: 60,
  };
  const rule = (o: Partial<typeof ok>) => {
    const e = retractRefusal({ ...ok, ...o });
    return e?.details?.['rule'] ?? e?.details?.['reason'] ?? null;
  };

  it('allowed within the window on a leading or outbid bid', () => {
    expect(rule({})).toBeNull();
    expect(rule({ bid: { status: 'OUTBID', placedAt: at(-60_000) } })).toBeNull();
  });
  it('refused after the window', () => {
    expect(rule({ bid: { status: 'LEADING', placedAt: at(-60_001) } })).toBe(
      'RETRACT_WINDOW_CLOSED',
    );
  });
  it('refused within 10 minutes of the end', () => {
    expect(rule({ auction: { status: 'OPEN', endsAt: at(10 * 60_000) } })).toBe('TOO_CLOSE_TO_END');
    expect(rule({ auction: { status: 'OPEN', endsAt: at(10 * 60_000 + 1) } })).toBeNull();
  });
  it('refused for settled bids and closed auctions', () => {
    for (const status of ['RETRACTED', 'WON', 'LOST'] as const) {
      expect(rule({ bid: { status, placedAt: now } })).toBe('BID_NOT_ACTIVE');
    }
    expect(rule({ auction: { status: 'CLOSING', endsAt: at(3_600_000) } })).toBe(
      'AUCTION_NOT_OPEN',
    );
  });
});

describe('creation', () => {
  const settings = { defaultAntiSnipeSeconds: 120, maxDurationDays: 14 };
  const listing = (o: Partial<ListingSnapshot> = {}): ListingSnapshot => ({
    listingId: 'l',
    sellerId: OWNER,
    categoryId: 'c',
    kind: 'PRODUCT',
    title: 'Phone',
    district: 'dhaka',
    price: bdt(50_000),
    quantityAvailable: 3,
    available: true,
    ...o,
  });
  const need = (o: Partial<NeedSnapshot> = {}): NeedSnapshot => ({
    needId: 'n',
    requesterId: OWNER,
    mode: 'SOURCE',
    categoryId: 'c',
    title: '100 bags of cement',
    district: 'chattogram',
    budgetMax: bdt(900_000),
    quantity: 100,
    status: 'OPEN',
    ...o,
  });
  const fwd = (o: Partial<CreateAuctionInput> = {}): CreateAuctionInput => ({
    kind: 'FORWARD',
    subjectId: 'l',
    startPrice: bdt(10_000),
    minIncrement: bdt(500),
    endsAt: at(2 * 3_600_000),
    ...o,
  });
  const rev = (o: Partial<CreateAuctionInput> = {}): CreateAuctionInput => ({
    kind: 'REVERSE',
    subjectId: 'n',
    minIncrement: bdt(1_000),
    endsAt: at(2 * 3_600_000),
    ...o,
  });
  const err = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      const d = (e as { details?: Record<string, unknown>; code: string }).details;
      return (
        (d?.['rule'] as string | undefined) ??
        (d?.['field'] as string | undefined) ??
        (e as { code: string }).code
      );
    }
    return null;
  };
  const draft = (input: CreateAuctionInput, l: ListingSnapshot | null, n: NeedSnapshot | null) =>
    draftAuction(OWNER, input, { listing: l, need: n }, now, settings);

  it('FORWARD copies title/district from the listing; mode BUY; opens now by default', () => {
    const d = draft(fwd({ quantity: 2 }), listing(), null);
    expect(d).toMatchObject({
      subjectType: 'LISTING',
      title: 'Phone',
      district: 'dhaka',
      mode: 'BUY',
      quantity: 2,
      startsAt: now,
      antiSnipeSeconds: 120,
      reservePrice: null,
    });
  });

  it('FORWARD rules', () => {
    expect(err(() => draft(fwd(), null, null))).toBe('NOT_FOUND');
    expect(err(() => draft(fwd(), listing({ sellerId: 'x' }), null))).toBe('NOT_YOUR_LISTING');
    expect(err(() => draft(fwd(), listing({ kind: 'SERVICE' }), null))).toBe(
      'LISTING_NOT_AUCTIONABLE',
    );
    expect(err(() => draft(fwd(), listing({ available: false }), null))).toBe(
      'LISTING_UNAVAILABLE',
    );
    expect(err(() => draft(fwd({ quantity: 4 }), listing(), null))).toBe('QUANTITY_EXCEEDS_STOCK');
    expect(err(() => draft(fwd({ startPrice: undefined }), listing(), null))).toBe('startPrice');
    expect(err(() => draft(fwd({ reservePrice: bdt(9_999) }), listing(), null))).toBe(
      'RESERVE_BELOW_START',
    );
  });

  it('REVERSE uses the need quantity and budgetMax as default ceiling', () => {
    const d = draft(rev(), null, need());
    expect(d).toMatchObject({
      subjectType: 'NEED',
      mode: 'SOURCE',
      quantity: 100,
      startPrice: bdt(900_000),
      district: 'chattogram',
    });
    expect(draft(rev({ startPrice: bdt(800_000) }), null, need()).startPrice).toEqual(bdt(800_000));
  });

  it('REVERSE rules', () => {
    expect(err(() => draft(rev(), null, null))).toBe('NOT_FOUND');
    expect(err(() => draft(rev(), null, need({ requesterId: 'x' })))).toBe('NOT_YOUR_NEED');
    expect(err(() => draft(rev(), null, need({ status: 'PAUSED' })))).toBe('NEED_NOT_OPEN');
    expect(err(() => draft(rev(), null, need({ mode: 'RENT' })))).toBe('NEED_MODE_NOT_AUCTIONABLE');
    expect(draft(rev(), null, need({ mode: 'BUY' })).mode).toBe('BUY');
    expect(err(() => draft(rev({ quantity: 5 }), null, need()))).toBe('QUANTITY_FIXED_BY_NEED');
    expect(err(() => draft(rev(), null, need({ budgetMax: null })))).toBe('CEILING_REQUIRED');
    expect(err(() => draft(rev({ reservePrice: bdt(900_001) }), null, need()))).toBe(
      'RESERVE_ABOVE_CEILING',
    );
  });

  it('schedule bounds', () => {
    const l = listing();
    expect(err(() => draft(fwd({ startsAt: at(-6 * 60_000) }), l, null))).toBe('startsAt');
    expect(draft(fwd({ startsAt: at(-60_000) }), l, null).startsAt).toEqual(now); // skew → now
    expect(
      err(() => draft(fwd({ startsAt: at(8 * 86_400_000), endsAt: at(9 * 86_400_000) }), l, null)),
    ).toBe('startsAt');
    expect(err(() => draft(fwd({ endsAt: at(3_600_000 - 1) }), l, null))).toBe('endsAt');
    expect(draft(fwd({ endsAt: at(3_600_000) }), l, null).endsAt).toEqual(at(3_600_000));
    expect(err(() => draft(fwd({ endsAt: at(14 * 86_400_000 + 1) }), l, null))).toBe('endsAt');
    expect(err(() => draft(fwd({ antiSnipeSeconds: 601 }), l, null))).toBe('antiSnipeSeconds');
  });
});

describe('visibility and actions', () => {
  const full = (o: Partial<Auction> = {}): Auction => ({
    id: 'a',
    kind: 'FORWARD',
    ownerId: OWNER,
    subjectType: 'LISTING',
    subjectId: 'l',
    categoryId: 'c',
    title: 't',
    district: 'dhaka',
    mode: 'BUY',
    quantity: 1,
    startPrice: bdt(10_000),
    reservePrice: null,
    minIncrement: bdt(500),
    startsAt: at(-60_000),
    endsAt: at(3_600_000),
    antiSnipeSeconds: 120,
    status: 'OPEN',
    leadingBidId: null,
    leadingAmount: null,
    bidCount: 0,
    hidden: false,
    cancelReason: null,
    closedAt: null,
    transactionId: null,
    createdAt: now,
    updatedAt: now,
    version: 0,
    ...o,
  });
  const member = { id: ME, isStaff: false, canManage: false, canBid: true };
  const owner = { id: OWNER, isStaff: false, canManage: false, canBid: true };
  const admin = { id: 'adm', isStaff: true, canManage: true, canBid: false };
  const anon = { id: null, isStaff: false, canManage: false, canBid: false };
  const ctx = { now, leaderId: null, myRetractable: null, retractWindowSeconds: 60 };

  it('hidden auctions are visible only to the owner and staff', () => {
    const h = full({ hidden: true });
    expect(canSee(h, member)).toBe(false);
    expect(canSee(h, anon)).toBe(false);
    expect(canSee(h, owner)).toBe(true);
    expect(canSee(h, admin)).toBe(true);
  });

  it('advertises what each caller can do', () => {
    expect(availableActions(full(), member, ctx)).toEqual(['BID']);
    expect(availableActions(full(), anon, ctx)).toEqual([]);
    expect(availableActions(full(), owner, ctx)).toEqual(['CANCEL']);
    expect(availableActions(full({ bidCount: 1 }), owner, ctx)).toEqual([]);
    expect(availableActions(full(), admin, ctx)).toEqual(['ADMIN_CANCEL']);
    expect(availableActions(full(), member, { ...ctx, leaderId: ME })).toEqual([]);
    expect(
      availableActions(full(), member, {
        ...ctx,
        leaderId: ME,
        myRetractable: { status: 'LEADING', placedAt: at(-1_000) },
      }),
    ).toEqual(['RETRACT_BID']);
    expect(availableActions(full({ status: 'AWARDED' }), member, ctx)).toEqual([]);
  });
});
