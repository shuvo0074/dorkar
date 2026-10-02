import { randomUUID } from 'node:crypto';
import {
  BiddingEvents,
  CatalogEvents,
  DemandEvents,
  ModerationEvents,
  TransactionEvents,
  type NeedMode,
} from '@dorkar/contracts';
import { createInternalClient, Errors } from '@dorkar/kernel';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildBiddingService } from '../../src/app';
import type { VerificationGateway } from '../../src/application/ports';
import { httpVerificationGateway } from '../../src/infrastructure/http-gateways';
import { pgAuctionStore } from '../../src/infrastructure/pg-auction-store';

let t: TestService<Awaited<ReturnType<typeof buildBiddingService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

let verificationMode: 'ok' | 'deny' | 'down' = 'ok';
const verificationCalls: Array<{ action: string; amount: number }> = [];
const verification: VerificationGateway = {
  async evaluate(q) {
    verificationCalls.push({ action: q.action, amount: q.amount });
    if (verificationMode === 'down') throw Errors.unavailable('Verification is down.');
    return verificationMode === 'ok'
      ? { satisfied: true, missing: [] }
      : { satisfied: false, missing: ['NID'] };
  },
};

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'bidding',
    migrations,
    build: (env, logger, verifier) => buildBiddingService(env, logger, { verifier, verification }),
  });
});
afterAll(() => t.close());
beforeEach(() => {
  verificationMode = 'ok';
  verificationCalls.length = 0;
});

// ---------------------------------------------------------------- helpers

const bdt = (amount: number) => ({ amount, currency: 'BDT' as const });
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const HOUR = 3_600_000;

async function publishListing(
  over: Partial<{ sellerId: string; quantity: number; kind: 'PRODUCT' | 'SERVICE' }> = {},
) {
  const listingId = randomUUID();
  const sellerId = over.sellerId ?? randomUUID();
  const categoryId = randomUUID();
  await t.svc.runtime.deliver(
    envelope(CatalogEvents.ListingPublished, {
      listingId,
      sellerId,
      categoryId,
      kind: over.kind ?? 'PRODUCT',
      condition: 'USED',
      title: 'Vintage camera',
      price: bdt(2_000_000),
      priceUnit: 'TOTAL',
      quantityAvailable: over.quantity ?? 2,
      district: 'dhaka',
      attributes: {},
      deliveryModes: ['BUYER_PICKUP'],
    }),
  );
  return { listingId, sellerId, categoryId };
}

async function publishNeed(
  over: Partial<{ requesterId: string; mode: NeedMode; budgetMax: number | null }> = {},
) {
  const needId = randomUUID();
  const requesterId = over.requesterId ?? randomUUID();
  const categoryId = randomUUID();
  await t.svc.runtime.deliver(
    envelope(DemandEvents.NeedPublished, {
      needId,
      requesterId,
      mode: over.mode ?? 'SOURCE',
      categoryId,
      title: '200 bags of cement',
      quantity: 200,
      budgetMin: null,
      budgetMax: over.budgetMax === null ? null : bdt(over.budgetMax ?? 10_000_000),
      conditions: ['NEW'],
      district: 'chattogram',
      attributes: {},
      requiredBy: null,
      expiresAt: inMs(10 * 24 * HOUR),
      maxOffers: 10,
    }),
  );
  return { needId, requesterId, categoryId };
}

async function headers(id: string, key: string | null = randomUUID(), roles?: string[]) {
  return {
    ...(await t.auth.as(id, roles as never)),
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

const forwardBody = (listingId: string, over: Record<string, unknown> = {}) => ({
  kind: 'FORWARD',
  subjectId: listingId,
  startPrice: bdt(100_000),
  minIncrement: bdt(5_000),
  endsAt: inMs(2 * HOUR),
  ...over,
});

const reverseBody = (needId: string, over: Record<string, unknown> = {}) => ({
  kind: 'REVERSE',
  subjectId: needId,
  minIncrement: bdt(10_000),
  endsAt: inMs(2 * HOUR),
  ...over,
});

async function create(ownerId: string, body: Record<string, unknown>, key = randomUUID()) {
  const res = await app().inject({
    method: 'POST',
    url: '/api/v1/auctions',
    headers: await headers(ownerId, key),
    payload: body,
  });
  return { res, auction: res.json().data };
}

async function forwardAuction(over: Record<string, unknown> = {}) {
  const l = await publishListing();
  const { res, auction } = await create(l.sellerId, forwardBody(l.listingId, over));
  expect(res.statusCode).toBe(201);
  return { ...l, ownerId: l.sellerId, auction };
}

async function reverseAuction(over: Record<string, unknown> = {}, mode: NeedMode = 'SOURCE') {
  const n = await publishNeed({ mode });
  const { res, auction } = await create(n.requesterId, reverseBody(n.needId, over));
  expect(res.statusCode).toBe(201);
  return { ...n, ownerId: n.requesterId, auction };
}

async function bid(
  auctionId: string,
  bidderId: string,
  amount: number,
  key: string | null = randomUUID(),
  roles?: string[],
) {
  return app().inject({
    method: 'POST',
    url: `/api/v1/auctions/${auctionId}/bids`,
    headers: await headers(bidderId, key, roles),
    payload: { amount: bdt(amount) },
  });
}

const post = async (url: string, actorId: string, payload?: unknown, roles?: string[]) =>
  app().inject({
    method: 'POST',
    url,
    headers: await headers(actorId, randomUUID(), roles),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });

const getAuction = async (id: string, actorId?: string, roles?: string[]) =>
  app().inject({
    url: `/api/v1/auctions/${id}`,
    ...(actorId ? { headers: await t.auth.as(actorId, roles as never) } : {}),
  });

async function events(type: string, auctionId: string) {
  const rows = await db()
    .selectFrom('outbox')
    .select(['payload'])
    .where('type', '=', type)
    .where('aggregate_id', '=', auctionId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => r.payload as Record<string, unknown>);
}

const auctionRow = (id: string) =>
  db().selectFrom('auctions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const bidRows = (auctionId: string) =>
  db().selectFrom('bids').selectAll().where('auction_id', '=', auctionId).orderBy('seq').execute();

/** Moves an auction's end into the past (or to `ms` from now) on the DB clock. */
const setEndsAt = (id: string, ms: number) => {
  const end = sql<Date>`clock_timestamp() + ${`${ms} milliseconds`}::interval`;
  // Keep ends_at > starts_at (table check) when moving the end into the past.
  return db()
    .updateTable('auctions')
    .set({
      ends_at: end,
      starts_at: sql<Date>`least(starts_at, ${end} - interval '1 hour')`,
    })
    .where('id', '=', id)
    .execute();
};

const runClose = () =>
  db()
    .transaction()
    .execute((trx) => t.svc.bidding.closeDue(pgAuctionStore(trx)));
const runOpen = () =>
  db()
    .transaction()
    .execute((trx) => t.svc.bidding.openDue(pgAuctionStore(trx)));

// ---------------------------------------------------------------- creation

describe('create', () => {
  it('FORWARD on my product listing opens immediately and emits a valid AuctionOpened', async () => {
    const { auction, listingId, ownerId, categoryId } = await forwardAuction({
      reservePrice: bdt(150_000),
      quantity: 2,
    });
    expect(auction).toMatchObject({
      kind: 'FORWARD',
      ownerId,
      subjectType: 'LISTING',
      subjectId: listingId,
      categoryId,
      title: 'Vintage camera',
      district: 'dhaka',
      mode: 'BUY',
      quantity: 2,
      status: 'OPEN',
      reservePrice: bdt(150_000), // the owner sees it
      reserveMet: false,
      bidCount: 0,
      leadingAmount: null,
      antiSnipeSeconds: 120,
      actions: ['CANCEL'],
    });
    expect(verificationCalls).toEqual([{ action: 'AUCTION_CREATE', amount: 100_000 }]);

    const [opened] = await events('bidding.AuctionOpened', auction.id);
    expect(BiddingEvents.AuctionOpened.schema.parse(opened)).toEqual({
      auctionId: auction.id,
      kind: 'FORWARD',
      ownerId,
      subjectType: 'LISTING',
      subjectId: listingId,
      categoryId,
      title: 'Vintage camera',
      district: 'dhaka',
      startPrice: bdt(100_000),
      startsAt: auction.startsAt,
      endsAt: auction.endsAt,
    });

    // Bidders never see the reserve value.
    const asBidder = (await getAuction(auction.id, randomUUID())).json().data;
    expect(asBidder.reservePrice).toBeNull();
    expect(asBidder.actions).toEqual(['BID']);
    expect(asBidder.nextBid).toEqual({ minimum: bdt(100_000), maximum: null });
    const history = await db()
      .selectFrom('auction_status_history')
      .select(['from_status', 'to_status'])
      .where('auction_id', '=', auction.id)
      .orderBy('created_at')
      .execute();
    expect(history).toEqual([
      { from_status: null, to_status: 'SCHEDULED' },
      { from_status: 'SCHEDULED', to_status: 'OPEN' },
    ]);
  });

  it('REVERSE on my sourcing need uses the need quantity and budget ceiling', async () => {
    const { auction, needId, ownerId } = await reverseAuction();
    expect(auction).toMatchObject({
      kind: 'REVERSE',
      ownerId,
      subjectType: 'NEED',
      subjectId: needId,
      mode: 'SOURCE',
      quantity: 200,
      startPrice: bdt(10_000_000),
      district: 'chattogram',
      status: 'OPEN',
    });
    const asSeller = (await getAuction(auction.id, randomUUID())).json().data;
    expect(asSeller.nextBid).toEqual({ minimum: bdt(1), maximum: bdt(10_000_000) });
  });

  it('a future start stays SCHEDULED until the open job runs', async () => {
    const { auction } = await forwardAuction({ startsAt: inMs(HOUR), endsAt: inMs(3 * HOUR) });
    expect(auction.status).toBe('SCHEDULED');
    expect(await events('bidding.AuctionOpened', auction.id)).toHaveLength(0);
    const early = await bid(auction.id, randomUUID(), 100_000);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.details.reason).toBe('AUCTION_NOT_OPEN');

    await db()
      .updateTable('auctions')
      .set({ starts_at: new Date(Date.now() - 1000) })
      .where('id', '=', auction.id)
      .execute();
    expect(await runOpen()).toBeGreaterThanOrEqual(1);
    expect((await auctionRow(auction.id)).status).toBe('OPEN');
    expect(await events('bidding.AuctionOpened', auction.id)).toHaveLength(1);
    expect((await bid(auction.id, randomUUID(), 100_000)).statusCode).toBe(201);
  });

  it('enforces subject ownership, kind, mode, ceiling, one live auction, and schedule', async () => {
    const l = await publishListing();
    const notMine = await create(randomUUID(), forwardBody(l.listingId));
    expect(notMine.res.json().error.details.rule).toBe('NOT_YOUR_LISTING');

    const svc = await publishListing({ kind: 'SERVICE' });
    expect(
      (await create(svc.sellerId, forwardBody(svc.listingId))).res.json().error.details.rule,
    ).toBe('LISTING_NOT_AUCTIONABLE');
    expect((await create(randomUUID(), forwardBody(randomUUID()))).res.statusCode).toBe(404);

    expect((await create(l.sellerId, forwardBody(l.listingId))).res.statusCode).toBe(201);
    const dup = await create(l.sellerId, forwardBody(l.listingId));
    expect(dup.res.statusCode).toBe(409);
    expect(dup.res.json().error.details.rule).toBe('AUCTION_ALREADY_LIVE');

    const rent = await publishNeed({ mode: 'RENT' });
    expect(
      (await create(rent.requesterId, reverseBody(rent.needId))).res.json().error.details.rule,
    ).toBe('NEED_MODE_NOT_AUCTIONABLE');
    const noBudget = await publishNeed({ budgetMax: null });
    expect(
      (await create(noBudget.requesterId, reverseBody(noBudget.needId))).res.json().error.details
        .rule,
    ).toBe('CEILING_REQUIRED');
    expect(
      (
        await create(
          noBudget.requesterId,
          reverseBody(noBudget.needId, { startPrice: bdt(5_000_000) }),
        )
      ).res.statusCode,
    ).toBe(201);

    const l2 = await publishListing();
    const short = await create(
      l2.sellerId,
      forwardBody(l2.listingId, { endsAt: inMs(30 * 60_000) }),
    );
    expect(short.res.statusCode).toBe(400);
    const unknownKey = await create(l2.sellerId, { ...forwardBody(l2.listingId), extra: 1 });
    expect(unknownKey.res.statusCode).toBe(400);
  });

  it('requires verification (fails closed), auction:create and an Idempotency-Key', async () => {
    const l = await publishListing();
    verificationMode = 'deny';
    const denied = await create(l.sellerId, forwardBody(l.listingId));
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.json().error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      details: { action: 'AUCTION_CREATE', missing: ['NID'] },
    });
    verificationMode = 'down';
    expect((await create(l.sellerId, forwardBody(l.listingId))).res.statusCode).toBe(503);
    verificationMode = 'ok';

    const noKey = await app().inject({
      method: 'POST',
      url: '/api/v1/auctions',
      headers: await headers(l.sellerId, null),
      payload: forwardBody(l.listingId),
    });
    expect(noKey.statusCode).toBe(400);
    const support = await app().inject({
      method: 'POST',
      url: '/api/v1/auctions',
      headers: await headers(l.sellerId, randomUUID(), ['SUPPORT']),
      payload: forwardBody(l.listingId),
    });
    expect(support.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------- bidding

describe('bidding', () => {
  it('FORWARD: new bid leads, the previous leader is outbid, events match the contracts', async () => {
    const { auction, ownerId } = await forwardAuction();
    const a = randomUUID();
    const b = randomUUID();

    const tooLow = await bid(auction.id, a, 99_999);
    expect(tooLow.statusCode).toBe(422);
    expect(tooLow.json().error.details).toMatchObject({
      rule: 'BID_TOO_LOW',
      minimum: bdt(100_000),
    });

    const first = await bid(auction.id, a, 100_000);
    expect(first.statusCode).toBe(201);
    expect(first.json().data.bid).toMatchObject({
      bidder: 'Bidder 1',
      isMine: true,
      status: 'LEADING',
      amount: bdt(100_000),
    });
    expect(first.json().data.auction).toMatchObject({
      leadingAmount: bdt(100_000),
      bidCount: 1,
      reserveMet: true,
      myBid: { status: 'LEADING' },
      actions: ['RETRACT_BID'],
    });

    expect((await bid(auction.id, a, 200_000)).json().error.details.rule).toBe('ALREADY_LEADING');
    expect((await bid(auction.id, b, 104_999)).json().error.details.minimum).toEqual(bdt(105_000));
    const second = await bid(auction.id, b, 105_000);
    expect(second.statusCode).toBe(201);

    const firstId = first.json().data.bid.id;
    const secondId = second.json().data.bid.id;
    const asA = (await getAuction(auction.id, a)).json().data;
    expect(asA.myBid).toMatchObject({ id: firstId, status: 'OUTBID' });
    expect(asA.actions).toEqual(['BID', 'RETRACT_BID']);

    const placed = await events('bidding.BidPlaced', auction.id);
    expect(placed.map((p) => BiddingEvents.BidPlaced.schema.parse(p))).toEqual([
      {
        auctionId: auction.id,
        bidId: firstId,
        bidderId: a,
        ownerId,
        amount: bdt(100_000),
        endsAt: auction.endsAt,
      },
      {
        auctionId: auction.id,
        bidId: secondId,
        bidderId: b,
        ownerId,
        amount: bdt(105_000),
        endsAt: auction.endsAt,
      },
    ]);
    const [outbid] = await events('bidding.BidOutbid', auction.id);
    expect(BiddingEvents.BidOutbid.schema.parse(outbid)).toEqual({
      auctionId: auction.id,
      bidId: firstId,
      bidderId: a,
      leadingAmount: bdt(105_000),
    });
    expect(verificationCalls.filter((c) => c.action === 'BID_PLACE').length).toBeGreaterThan(0);
  });

  it('REVERSE: bids go down by the minimum decrement and must stay above zero', async () => {
    const { auction } = await reverseAuction();
    const s1 = randomUUID();
    const s2 = randomUUID();
    expect((await bid(auction.id, s1, 10_000_001)).json().error.details.rule).toBe('BID_TOO_HIGH');
    expect((await bid(auction.id, s1, 9_000_000)).statusCode).toBe(201);
    const high = await bid(auction.id, s2, 8_995_000);
    expect(high.json().error.details).toMatchObject({
      rule: 'BID_TOO_HIGH',
      maximum: bdt(8_990_000),
    });
    expect((await bid(auction.id, s2, 8_990_000)).statusCode).toBe(201);
    expect((await bid(auction.id, s1, 0)).statusCode).toBe(422);
    const row = await auctionRow(auction.id);
    expect(Number(row.leading_amount)).toBe(8_990_000);
    expect(row.bid_count).toBe(2);
  });

  it('the owner cannot bid; verification is required and fails closed', async () => {
    const { auction, ownerId } = await forwardAuction();
    const own = await bid(auction.id, ownerId, 100_000);
    expect(own.statusCode).toBe(422);
    expect(own.json().error.details.rule).toBe('OWN_AUCTION');

    verificationMode = 'deny';
    const denied = await bid(auction.id, randomUUID(), 100_000);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.details.action).toBe('BID_PLACE');
    verificationMode = 'down';
    expect((await bid(auction.id, randomUUID(), 100_000)).statusCode).toBe(503);
    verificationMode = 'ok';
    expect(
      (await bid(auction.id, randomUUID(), 100_000, randomUUID(), ['SUPPORT'])).statusCode,
    ).toBe(403);
    expect((await bid(randomUUID(), randomUUID(), 100_000)).statusCode).toBe(404);
  });

  it('refuses bids after ends_at (DB clock) even before the close job runs', async () => {
    const { auction } = await forwardAuction();
    await setEndsAt(auction.id, -1000);
    const late = await bid(auction.id, randomUUID(), 100_000);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.details.reason).toBe('AUCTION_ENDED');
    expect((await getAuction(auction.id, randomUUID())).json().data).toMatchObject({
      actions: [],
      nextBid: null,
    });
  });

  it('Idempotency-Key replay returns the same bid without a second effect', async () => {
    const { auction } = await forwardAuction();
    const bidder = randomUUID();
    const key = randomUUID();
    const first = await bid(auction.id, bidder, 100_000, key);
    const again = await bid(auction.id, bidder, 100_000, key);
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.body).toBe(first.body);
    expect(await bidRows(auction.id)).toHaveLength(1);
    expect(await events('bidding.BidPlaced', auction.id)).toHaveLength(1);

    const reused = await bid(auction.id, bidder, 110_000, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await bid(auction.id, bidder, 100_000, null)).statusCode).toBe(400);
  });

  it('rate-limits 10 bids per bidder per auction per minute', async () => {
    const { auction } = await forwardAuction();
    const bidder = randomUUID();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push((await bid(auction.id, bidder, 100_000 + i)).statusCode);
    expect(codes[0]).toBe(201);
    expect(codes.slice(1, 10).every((c) => c === 422)).toBe(true); // ALREADY_LEADING
    expect(codes[10]).toBe(429);
    // Another bidder on the same auction is unaffected.
    expect((await bid(auction.id, randomUUID(), 200_000)).statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------- concurrency

describe.each(['FORWARD', 'REVERSE'] as const)('concurrent bids (%s)', (kind) => {
  it('serialize on the auction row: one leader, strictly monotonic, no lost updates', async () => {
    const { auction } =
      kind === 'FORWARD'
        ? await forwardAuction({ minIncrement: bdt(1_000) })
        : await reverseAuction({ minIncrement: bdt(1_000) });
    const N = 16;
    const amounts = Array.from({ length: N }, (_, i) =>
      kind === 'FORWARD' ? 100_000 + i * 1_000 : 10_000_000 - i * 1_000,
    ).sort(() => Math.random() - 0.5);

    const responses = await Promise.all(amounts.map((amt) => bid(auction.id, randomUUID(), amt)));
    for (const r of responses) {
      expect([201, 422]).toContain(r.statusCode);
      if (r.statusCode === 422) {
        expect(r.json().error.details.rule).toBe(
          kind === 'FORWARD' ? 'BID_TOO_LOW' : 'BID_TOO_HIGH',
        );
      }
    }
    const accepted = responses.filter((r) => r.statusCode === 201).length;
    expect(accepted).toBeGreaterThanOrEqual(1);

    const rows = await bidRows(auction.id);
    expect(rows).toHaveLength(accepted);
    expect(rows.filter((r) => r.status === 'LEADING')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'OUTBID')).toHaveLength(accepted - 1);
    const placed = rows.map((r) => Number(r.amount));
    for (let i = 1; i < placed.length; i++) {
      if (kind === 'FORWARD') expect(placed[i]! - placed[i - 1]!).toBeGreaterThanOrEqual(1_000);
      else expect(placed[i - 1]! - placed[i]!).toBeGreaterThanOrEqual(1_000);
    }
    const best = kind === 'FORWARD' ? Math.max(...amounts) : Math.min(...amounts);
    const leader = rows.find((r) => r.status === 'LEADING')!;
    expect(Number(leader.amount)).toBe(best); // the best bid can never be lost
    expect(leader.id).toBe(rows.at(-1)!.id);

    const a = await auctionRow(auction.id);
    expect(Number(a.leading_amount)).toBe(best);
    expect(a.leading_bid_id).toBe(leader.id);
    expect(a.bid_count).toBe(accepted);
    expect(await events('bidding.BidPlaced', auction.id)).toHaveLength(accepted);
    expect(await events('bidding.BidOutbid', auction.id)).toHaveLength(accepted - 1);
  });
});

// ---------------------------------------------------------------- anti-sniping

describe('anti-sniping', () => {
  it('a bid inside the window pushes the end to now + window; outside it does not', async () => {
    const { auction } = await forwardAuction({ antiSnipeSeconds: 120 });
    const before = (await auctionRow(auction.id)).ends_at.getTime();
    await bid(auction.id, randomUUID(), 100_000);
    expect((await auctionRow(auction.id)).ends_at.getTime()).toBe(before);

    await setEndsAt(auction.id, 30_000);
    const t0 = Date.now();
    const r = await bid(auction.id, randomUUID(), 105_000);
    expect(r.statusCode).toBe(201);
    const endsAt = (await auctionRow(auction.id)).ends_at.getTime();
    expect(endsAt).toBeGreaterThanOrEqual(t0 + 120_000 - 2_000);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 120_000 + 2_000);
    expect(new Date(r.json().data.auction.endsAt).getTime()).toBe(endsAt);
    const placed = await events('bidding.BidPlaced', auction.id);
    expect(new Date(placed.at(-1)!['endsAt'] as string).getTime()).toBe(endsAt);
  });

  it('antiSnipeSeconds 0 never extends', async () => {
    const { auction } = await forwardAuction({ antiSnipeSeconds: 0 });
    await setEndsAt(auction.id, 5_000);
    const before = (await auctionRow(auction.id)).ends_at.getTime();
    expect((await bid(auction.id, randomUUID(), 100_000)).statusCode).toBe(201);
    expect((await auctionRow(auction.id)).ends_at.getTime()).toBe(before);
  });
});

// ---------------------------------------------------------------- retraction

describe('retraction', () => {
  it('restores the previous leader and recomputes the leading amount', async () => {
    const { auction } = await forwardAuction();
    const a = randomUUID();
    const b = randomUUID();
    const first = (await bid(auction.id, a, 100_000)).json().data.bid;
    const second = (await bid(auction.id, b, 120_000)).json().data.bid;

    const r = await post(`/api/v1/auctions/${auction.id}/bids/${second.id}/retract`, b);
    expect(r.statusCode).toBe(200);
    expect(r.json().data.bid).toMatchObject({ id: second.id, status: 'RETRACTED' });
    expect(r.json().data.auction).toMatchObject({ leadingAmount: bdt(100_000), bidCount: 1 });

    const row = await auctionRow(auction.id);
    expect(row.leading_bid_id).toBe(first.id);
    const statuses = (await bidRows(auction.id)).map((x) => x.status);
    expect(statuses).toEqual(['LEADING', 'RETRACTED']);
    // b may bid again; the minimum is back to leader + increment.
    expect((await bid(auction.id, b, 104_999)).json().error.details.minimum).toEqual(bdt(105_000));
  });

  it('retracting the only bid clears the leader; an outbid bid just leaves the race', async () => {
    const { auction } = await forwardAuction();
    const a = randomUUID();
    const only = (await bid(auction.id, a, 100_000)).json().data.bid;
    await post(`/api/v1/auctions/${auction.id}/bids/${only.id}/retract`, a);
    let row = await auctionRow(auction.id);
    expect(row).toMatchObject({ leading_bid_id: null, leading_amount: null, bid_count: 0 });

    const b = randomUUID();
    const c = randomUUID();
    const outbid = (await bid(auction.id, b, 100_000)).json().data.bid;
    const lead = (await bid(auction.id, c, 110_000)).json().data.bid;
    expect(
      (await post(`/api/v1/auctions/${auction.id}/bids/${outbid.id}/retract`, b)).statusCode,
    ).toBe(200);
    row = await auctionRow(auction.id);
    expect(row.leading_bid_id).toBe(lead.id);
    expect(row.bid_count).toBe(1);
  });

  it('only the bidder, only within the window, never near the end', async () => {
    const { auction } = await forwardAuction();
    const a = randomUUID();
    const placed = (await bid(auction.id, a, 100_000)).json().data.bid;
    const url = `/api/v1/auctions/${auction.id}/bids/${placed.id}/retract`;
    expect((await post(url, randomUUID())).statusCode).toBe(404);

    await setEndsAt(auction.id, 5 * 60_000);
    expect((await post(url, a)).json().error.details.rule).toBe('TOO_CLOSE_TO_END');
    await setEndsAt(auction.id, HOUR);
    await db()
      .updateTable('bids')
      .set({ placed_at: new Date(Date.now() - 120_000) })
      .where('id', '=', placed.id)
      .execute();
    expect((await post(url, a)).json().error.details.rule).toBe('RETRACT_WINDOW_CLOSED');
  });
});

// ---------------------------------------------------------------- closing

describe('close job', () => {
  it('FORWARD award: WON/LOST, AuctionClosed and AuctionAwarded (buyer = winner)', async () => {
    const { auction, ownerId, listingId } = await forwardAuction({
      reservePrice: bdt(110_000),
      quantity: 2,
    });
    const a = randomUUID();
    const b = randomUUID();
    const lost = (await bid(auction.id, a, 100_000)).json().data.bid;
    const won = (await bid(auction.id, b, 110_000)).json().data.bid;
    await setEndsAt(auction.id, -1000);
    expect(await runClose()).toBeGreaterThanOrEqual(1);

    const row = await auctionRow(auction.id);
    expect(row.status).toBe('AWARDED');
    expect(row.closed_at).not.toBeNull();
    expect((await bidRows(auction.id)).map((x) => [x.id, x.status])).toEqual([
      [lost.id, 'LOST'],
      [won.id, 'WON'],
    ]);

    const [closed] = await events('bidding.AuctionClosed', auction.id);
    expect(BiddingEvents.AuctionClosed.schema.parse(closed)).toMatchObject({
      auctionId: auction.id,
      outcome: 'AWARDED',
      winnerId: b,
      winningBidId: won.id,
      amount: bdt(110_000),
    });
    expect([...(closed!['bidderIds'] as string[])].sort()).toEqual([a, b].sort());

    const [awarded] = await events('bidding.AuctionAwarded', auction.id);
    const parsed = BiddingEvents.AuctionAwarded.schema.parse(awarded);
    expect(parsed).toMatchObject({
      auctionId: auction.id,
      winningBidId: won.id,
      kind: 'FORWARD',
      needId: null,
      listingId,
      buyerId: b,
      sellerId: ownerId,
      mode: 'BUY',
      amount: bdt(110_000),
      quantity: 2,
      terms: { auctionKind: 'FORWARD', quantity: 2 },
    });
    expect(typeof parsed.terms['closedAt']).toBe('string');

    // The winner and owner see who won; other bidders do not.
    expect((await getAuction(auction.id, ownerId)).json().data.winnerId).toBe(b);
    expect((await getAuction(auction.id, b)).json().data.winnerId).toBe(b);
    expect((await getAuction(auction.id, a)).json().data).toMatchObject({
      winnerId: null,
      myBid: { status: 'LOST' },
    });

    // A second run does nothing.
    await runClose();
    expect(await events('bidding.AuctionAwarded', auction.id)).toHaveLength(1);
  });

  it('REVERSE award: buyer = owner, seller = winner, needId and the need mode', async () => {
    const { auction, ownerId, needId } = await reverseAuction({}, 'BUY');
    const seller = randomUUID();
    const won = (await bid(auction.id, seller, 9_000_000)).json().data.bid;
    await setEndsAt(auction.id, -1000);
    await runClose();
    const [awarded] = await events('bidding.AuctionAwarded', auction.id);
    expect(BiddingEvents.AuctionAwarded.schema.parse(awarded)).toMatchObject({
      winningBidId: won.id,
      kind: 'REVERSE',
      needId,
      listingId: null,
      buyerId: ownerId,
      sellerId: seller,
      mode: 'BUY',
      amount: bdt(9_000_000),
      quantity: 200,
      terms: { auctionKind: 'REVERSE', quantity: 200 },
    });
  });

  it('no bids → NO_WINNER with an empty bidder list', async () => {
    const { auction } = await forwardAuction();
    await setEndsAt(auction.id, -1000);
    await runClose();
    expect((await auctionRow(auction.id)).status).toBe('NO_WINNER');
    const [closed] = await events('bidding.AuctionClosed', auction.id);
    expect(BiddingEvents.AuctionClosed.schema.parse(closed)).toMatchObject({
      outcome: 'NO_WINNER',
      winnerId: null,
      winningBidId: null,
      amount: null,
      bidderIds: [],
    });
    expect(await events('bidding.AuctionAwarded', auction.id)).toHaveLength(0);
  });

  it.each(['FORWARD', 'REVERSE'] as const)(
    '%s reserve not met → NO_WINNER, every bid LOST, no award',
    async (kind) => {
      const { auction } =
        kind === 'FORWARD'
          ? await forwardAuction({ reservePrice: bdt(500_000) })
          : await reverseAuction({ reservePrice: bdt(1_000_000) });
      const amount = kind === 'FORWARD' ? 200_000 : 5_000_000;
      const placed = await bid(auction.id, randomUUID(), amount);
      expect(placed.json().data.auction.reserveMet).toBe(false);
      await setEndsAt(auction.id, -1000);
      await runClose();
      expect((await auctionRow(auction.id)).status).toBe('NO_WINNER');
      expect((await bidRows(auction.id)).map((x) => x.status)).toEqual(['LOST']);
      expect(await events('bidding.AuctionAwarded', auction.id)).toHaveLength(0);
      const history = await db()
        .selectFrom('auction_status_history')
        .select(['to_status', 'reason'])
        .where('auction_id', '=', auction.id)
        .orderBy('created_at')
        .execute();
      expect(history.slice(-2)).toEqual([
        { to_status: 'CLOSING', reason: 'ENDS_AT_REACHED' },
        { to_status: 'NO_WINNER', reason: 'RESERVE_NOT_MET' },
      ]);
    },
  );

  it('TransactionCreated (AUCTION) settles the award exactly once', async () => {
    const { auction, ownerId, listingId } = await forwardAuction();
    const buyer = randomUUID();
    await bid(auction.id, buyer, 100_000);
    await setEndsAt(auction.id, -1000);
    await runClose();
    const transactionId = randomUUID();
    const e = envelope(TransactionEvents.TransactionCreated, {
      transactionId,
      sourceType: 'AUCTION',
      sourceId: auction.id,
      needId: null,
      listingId,
      buyerId: buyer,
      sellerId: ownerId,
      amount: bdt(100_000),
      quantity: 1,
      mode: 'BUY',
    });
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false);
    const row = await auctionRow(auction.id);
    expect(row).toMatchObject({ status: 'SETTLED', transaction_id: transactionId });
    const settled = await db()
      .selectFrom('auction_status_history')
      .selectAll()
      .where('auction_id', '=', auction.id)
      .where('to_status', '=', 'SETTLED')
      .execute();
    expect(settled).toHaveLength(1);

    // Other source types are ignored.
    const other = await forwardAuction();
    await t.svc.runtime.deliver(
      envelope(TransactionEvents.TransactionCreated, {
        transactionId: randomUUID(),
        sourceType: 'OFFER',
        sourceId: other.auction.id,
        needId: null,
        buyerId: buyer,
        sellerId: other.ownerId,
        amount: bdt(1),
        quantity: 1,
        mode: 'BUY',
      }),
    );
    expect((await auctionRow(other.auction.id)).status).toBe('OPEN');
  });

  it('history is append-only', async () => {
    const { auction } = await forwardAuction();
    await expect(
      db()
        .updateTable('auction_status_history')
        .set({ reason: 'x' })
        .where('auction_id', '=', auction.id)
        .execute(),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------- cancellation

describe('cancellation', () => {
  it('owner cancels an OPEN auction without bids; emits AuctionClosed CANCELLED', async () => {
    const { auction, ownerId } = await forwardAuction();
    expect((await post(`/api/v1/auctions/${auction.id}/cancel`, randomUUID(), {})).statusCode).toBe(
      403,
    );
    const r = await post(`/api/v1/auctions/${auction.id}/cancel`, ownerId, {
      reason: 'changed mind',
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({ status: 'CANCELLED', actions: [] });
    const [closed] = await events('bidding.AuctionClosed', auction.id);
    expect(BiddingEvents.AuctionClosed.schema.parse(closed)).toMatchObject({
      outcome: 'CANCELLED',
      winnerId: null,
      bidderIds: [],
    });
    expect((await post(`/api/v1/auctions/${auction.id}/cancel`, ownerId)).statusCode).toBe(409);
  });

  it('owner cannot cancel once bids exist; admin can, with a reason', async () => {
    const { auction, ownerId } = await forwardAuction();
    const bidder = randomUUID();
    await bid(auction.id, bidder, 100_000);
    const refused = await post(`/api/v1/auctions/${auction.id}/cancel`, ownerId);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.details.rule).toBe('AUCTION_HAS_BIDS');

    const url = `/api/v1/admin/auctions/${auction.id}/cancel`;
    expect((await post(url, randomUUID(), { reason: 'fraud report' })).statusCode).toBe(403);
    expect(
      (await post(url, randomUUID(), { reason: 'fraud report' }, ['MODERATOR'])).statusCode,
    ).toBe(403);
    expect((await post(url, randomUUID(), {}, ['ADMIN'])).statusCode).toBe(400);
    const ok = await post(url, randomUUID(), { reason: 'fraud report' }, ['ADMIN']);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ status: 'CANCELLED', cancelReason: 'fraud report' });
    expect((await bidRows(auction.id)).map((x) => x.status)).toEqual(['LOST']);
    const [closed] = await events('bidding.AuctionClosed', auction.id);
    expect(closed).toMatchObject({ outcome: 'CANCELLED', bidderIds: [bidder] });

    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'actor_type'])
      .where('target_id', '=', auction.id)
      .execute();
    expect(audit.map((x) => x.action)).toEqual(
      expect.arrayContaining(['auction.create', 'bid.place', 'auction.admin_cancel']),
    );
  });

  it('listing unavailable cancels the live forward auction exactly once (redelivery)', async () => {
    const { auction, listingId, ownerId } = await forwardAuction();
    await bid(auction.id, randomUUID(), 100_000);
    const e = envelope(CatalogEvents.ListingUnavailable, {
      listingId,
      sellerId: ownerId,
      reason: 'SOLD_OUT',
    });
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false);
    expect(await auctionRow(auction.id)).toMatchObject({
      status: 'CANCELLED',
      cancel_reason: 'LISTING_SOLD_OUT',
    });
    expect(await events('bidding.AuctionClosed', auction.id)).toHaveLength(1);
  });

  it('need closed/expired/hidden cancels the reverse auction; paused does not', async () => {
    const { auction, needId, ownerId } = await reverseAuction();
    const change = (from: string, to: string) =>
      envelope(DemandEvents.NeedStatusChanged, {
        needId,
        requesterId: ownerId,
        from: from as never,
        to: to as never,
        reason: 'owner',
      });
    await t.svc.runtime.deliver(change('OPEN', 'PAUSED'));
    expect((await auctionRow(auction.id)).status).toBe('OPEN');
    const closed = change('PAUSED', 'CLOSED');
    await t.svc.runtime.deliver(closed);
    await t.svc.runtime.deliver(closed);
    expect((await auctionRow(auction.id)).status).toBe('CANCELLED');
    expect(await events('bidding.AuctionClosed', auction.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- moderation & visibility

describe('moderation and visibility', () => {
  const moderate = (auctionId: string, action: 'HIDE' | 'RESTORE') =>
    envelope(ModerationEvents.ContentModerated, {
      caseId: randomUUID(),
      targetType: 'AUCTION',
      targetId: auctionId,
      action,
      reason: 'policy',
      moderatorId: randomUUID(),
    });

  it('hidden auctions are 404 to everyone but the owner and staff, and take no bids', async () => {
    const { auction, ownerId } = await forwardAuction();
    const bidder = randomUUID();
    await bid(auction.id, bidder, 100_000);
    const hide = moderate(auction.id, 'HIDE');
    expect(await t.svc.runtime.deliver(hide)).toBe(true);
    expect(await t.svc.runtime.deliver(hide)).toBe(false);

    expect((await getAuction(auction.id)).statusCode).toBe(404);
    expect((await getAuction(auction.id, bidder)).statusCode).toBe(404);
    expect((await app().inject({ url: `/api/v1/auctions/${auction.id}/bids` })).statusCode).toBe(
      404,
    );
    expect((await bid(auction.id, randomUUID(), 200_000)).statusCode).toBe(404);
    expect((await getAuction(auction.id, ownerId)).json().data.hidden).toBe(true);
    expect((await getAuction(auction.id, randomUUID(), ['MODERATOR'])).statusCode).toBe(200);
    const browse = await app().inject({ url: '/api/v1/auctions?limit=100' });
    expect(browse.json().data.map((x: { id: string }) => x.id)).not.toContain(auction.id);
    const myBids = await app().inject({ url: '/api/v1/me/bids', headers: await t.auth.as(bidder) });
    expect(myBids.json().data).toHaveLength(0);

    await t.svc.runtime.deliver(moderate(auction.id, 'RESTORE'));
    expect((await getAuction(auction.id, bidder)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- reads

describe('reads', () => {
  it('bid history shows stable aliases, isMine, and never other bidders’ ids', async () => {
    const { auction } = await forwardAuction();
    const a = randomUUID();
    const b = randomUUID();
    await bid(auction.id, a, 100_000);
    await bid(auction.id, b, 105_000);
    await bid(auction.id, a, 110_000);

    const res = await app().inject({
      url: `/api/v1/auctions/${auction.id}/bids?limit=2`,
      headers: await t.auth.as(a),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(b);
    expect(res.body).not.toContain(a);
    const page1 = res.json();
    expect(
      page1.data.map((x: { bidder: string; isMine: boolean }) => [x.bidder, x.isMine]),
    ).toEqual([
      ['Bidder 1', true],
      ['Bidder 2', false],
    ]);
    const page2 = await app().inject({
      url: `/api/v1/auctions/${auction.id}/bids?limit=2&cursor=${page1.page.nextCursor}`,
    });
    expect(page2.json().data).toHaveLength(1);
    expect(page2.json().data[0]).toMatchObject({ bidder: 'Bidder 1', isMine: false });
    expect(page2.json().page.nextCursor).toBeNull();
  });

  it('public browse: default OPEN, filters, ending soonest, keyset pages', async () => {
    const district = 'dhaka';
    const categoryOwner = await forwardAuction({ endsAt: inMs(5 * HOUR) });
    const other = await forwardAuction({ endsAt: inMs(4 * HOUR) });
    const rev = await reverseAuction();

    const byCategory = await app().inject({
      url: `/api/v1/auctions?categoryId=${categoryOwner.categoryId}`,
    });
    expect(byCategory.statusCode).toBe(200);
    expect(byCategory.json().data.map((x: { id: string }) => x.id)).toEqual([
      categoryOwner.auction.id,
    ]);

    const reverse = await app().inject({ url: '/api/v1/auctions?kind=REVERSE&limit=100' });
    const ids = reverse.json().data.map((x: { id: string }) => x.id);
    expect(ids).toContain(rev.auction.id);
    expect(ids).not.toContain(other.auction.id);

    const forward = await app().inject({
      url: `/api/v1/auctions?kind=FORWARD&district=${district}&limit=100`,
    });
    const order = forward.json().data.map((x: { endsAt: string }) => x.endsAt);
    expect([...order].sort()).toEqual(order);

    const p1 = await app().inject({ url: '/api/v1/auctions?limit=1' });
    const p2 = await app().inject({
      url: `/api/v1/auctions?limit=1&cursor=${p1.json().page.nextCursor}`,
    });
    expect(p2.json().data[0].id).not.toBe(p1.json().data[0].id);
    expect((await app().inject({ url: '/api/v1/auctions?cursor=bad' })).statusCode).toBe(400);
    expect((await app().inject({ url: '/api/v1/auctions?bogus=1' })).statusCode).toBe(400);
  });

  it('my auctions and my bids', async () => {
    const owner = randomUUID();
    const l1 = await publishListing({ sellerId: owner });
    const l2 = await publishListing({ sellerId: owner });
    const a1 = (await create(owner, forwardBody(l1.listingId))).auction;
    const a2 = (await create(owner, forwardBody(l2.listingId))).auction;
    await post(`/api/v1/auctions/${a2.id}/cancel`, owner);

    const mine = await app().inject({
      url: '/api/v1/me/auctions',
      headers: await t.auth.as(owner),
    });
    expect(mine.json().data.map((x: { id: string }) => x.id)).toEqual([a2.id, a1.id]);
    const open = await app().inject({
      url: '/api/v1/me/auctions?status=OPEN',
      headers: await t.auth.as(owner),
    });
    expect(open.json().data.map((x: { id: string }) => x.id)).toEqual([a1.id]);

    const bidder = randomUUID();
    await bid(a1.id, bidder, 100_000);
    await bid(a1.id, randomUUID(), 105_000);
    const bids = await app().inject({ url: '/api/v1/me/bids', headers: await t.auth.as(bidder) });
    expect(bids.json().data).toHaveLength(1);
    expect(bids.json().data[0]).toMatchObject({
      status: 'OUTBID',
      amount: bdt(100_000),
      auction: { id: a1.id, leadingAmount: bdt(105_000), status: 'OPEN' },
    });
    const leading = await app().inject({
      url: '/api/v1/me/bids?status=LEADING',
      headers: await t.auth.as(bidder),
    });
    expect(leading.json().data).toHaveLength(0);
    expect((await app().inject({ url: '/api/v1/me/bids' })).statusCode).toBe(401);
  });

  it('admin list includes hidden auctions and shows history; members are refused', async () => {
    const { auction } = await forwardAuction();
    await t.svc.runtime.deliver(
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'AUCTION',
        targetId: auction.id,
        action: 'HIDE',
        reason: 'x',
        moderatorId: randomUUID(),
      }),
    );
    const admin = await t.auth.as(randomUUID(), ['ADMIN']);
    const list = await app().inject({ url: '/api/v1/admin/auctions?limit=100', headers: admin });
    expect(list.json().data.map((x: { id: string }) => x.id)).toContain(auction.id);
    const one = await app().inject({ url: `/api/v1/admin/auctions/${auction.id}`, headers: admin });
    expect(one.json().data.history.map((h: { to: string }) => h.to)).toEqual(['SCHEDULED', 'OPEN']);
    expect(
      (
        await app().inject({
          url: '/api/v1/admin/auctions',
          headers: await t.auth.as(randomUUID()),
        })
      ).statusCode,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------- outbound adapter

describe('verification gateway', () => {
  it('fails closed with 503 when verification is unreachable', async () => {
    const gw = httpVerificationGateway(
      createInternalClient({
        baseUrl: 'http://127.0.0.1:9',
        token: 'x'.repeat(32),
        timeoutMs: 300,
      }),
    );
    const ctx = { requestId: 'r', correlationId: 'c', ipHash: null, userAgent: null, actor: null };
    await expect(
      gw.evaluate(
        {
          accountId: randomUUID(),
          action: 'BID_PLACE',
          categoryId: randomUUID(),
          mode: 'BUY',
          amount: 1,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
  });
});
