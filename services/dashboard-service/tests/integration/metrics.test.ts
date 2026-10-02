import { randomUUID } from 'node:crypto';
import {
  BiddingEvents,
  CatalogEvents,
  DemandEvents,
  DisputeEvents,
  IdentityEvents,
  LendingEvents,
  MessagingEvents,
  OfferEvents,
  RentalEvents,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
  type EventEnvelope,
  type TransactionState,
} from '@dorkar/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ev, money, start, type T } from '../helpers';

/** Fixed clock: noon in Dhaka on 2025-06-15. Seeded events use dates around it. */
const NOW = new Date('2025-06-15T06:00:00.000Z');
const TODAY = '2025-06-15';

let t: T;
const app = () => t.svc.runtime.app;
const deliver = (e: EventEnvelope) => t.svc.runtime.deliver(e);
const admin = () => t.auth.as(randomUUID(), ['ADMIN']);
const get = async (url: string) => app().inject({ url, headers: await admin() });
const clearSummaryCache = () => t.svc.runtime.redis.del(`summary:${t.schema}`);

beforeAll(async () => {
  t = await start(() => NOW);
});
afterAll(async () => {
  await clearSummaryCache();
  await t.close();
});

/** Noon in Dhaka on `day`. */
const noon = (day: string) => new Date(`${day}T06:00:00.000Z`);

const dayRows = async (day: string) =>
  Object.fromEntries(
    (
      await t.svc.runtime.db
        .selectFrom('daily_metrics')
        .select(['metric', 'dimension', 'value'])
        .where('day', '=', day)
        .execute()
    ).map((r) => [r.dimension ? `${r.metric}|${r.dimension}` : r.metric, Number(r.value)]),
  );

const id = () => randomUUID();

function txCreated(tx: string, buyerId: string, sellerId: string, amount: number, at: Date) {
  return ev(
    TransactionEvents.TransactionCreated,
    {
      transactionId: tx,
      sourceType: 'OFFER',
      sourceId: id(),
      needId: id(),
      buyerId,
      sellerId,
      amount: money(amount),
      quantity: 1,
      mode: 'BUY',
    },
    at,
    tx,
  );
}
function txChanged(
  tx: string,
  buyerId: string,
  sellerId: string,
  from: TransactionState,
  to: TransactionState,
  at: Date,
) {
  return ev(
    TransactionEvents.TransactionStateChanged,
    {
      transactionId: tx,
      needId: null,
      sourceType: 'OFFER',
      sourceId: id(),
      buyerId,
      sellerId,
      from,
      to,
      actorId: null,
      mode: 'BUY',
    },
    at,
    tx,
  );
}

describe('counters', () => {
  it('counts every metric once per event, on the Dhaka day, and ignores redelivery', async () => {
    const day = '2024-05-10';
    const at = noon(day);
    const [buyer, seller, tx, dispute, auction] = [id(), id(), id(), id(), id()];
    const events: EventEnvelope[] = [
      ev(IdentityEvents.AccountCreated, { accountId: buyer }, at),
      ev(
        IdentityEvents.UserLoggedIn,
        { accountId: buyer, sessionId: id(), deviceId: id(), newDevice: true },
        at,
      ),
      ev(
        IdentityEvents.UserLoggedIn,
        { accountId: seller, sessionId: id(), deviceId: id(), newDevice: false },
        at,
      ),
      ev(
        DemandEvents.NeedStatusChanged,
        {
          needId: id(),
          requesterId: buyer,
          from: 'DRAFT',
          to: 'OPEN',
          reason: 'PUBLISHED_BY_OWNER',
        },
        at,
      ),
      // Not a first publish: not counted.
      ev(
        DemandEvents.NeedStatusChanged,
        { needId: id(), requesterId: buyer, from: 'PAUSED', to: 'OPEN', reason: 'RESUMED' },
        at,
      ),
      ev(CatalogEvents.ListingPublished, listing(seller), at),
      ev(
        OfferEvents.OfferSubmitted,
        {
          offerId: id(),
          needId: id(),
          buyerId: buyer,
          sellerId: seller,
          price: money(1000),
          quantity: 1,
        },
        at,
      ),
      ev(
        OfferEvents.OfferAccepted,
        {
          offerId: id(),
          needId: id(),
          buyerId: buyer,
          sellerId: seller,
          listingId: null,
          mode: 'BUY',
          price: money(1000),
          quantity: 1,
          terms: {},
        },
        at,
      ),
      txCreated(tx, buyer, seller, 150_000, at),
      txChanged(tx, buyer, seller, 'DELIVERED', 'COMPLETED', at),
      ev(
        TransactionEvents.TransactionCreated,
        {
          transactionId: id(),
          sourceType: 'BOOKING',
          sourceId: id(),
          needId: null,
          buyerId: buyer,
          sellerId: seller,
          amount: money(5000),
          quantity: 1,
          mode: 'RENT',
        },
        at,
      ),
      txChanged(id(), buyer, seller, 'CREATED', 'CANCELLED', at),
      ev(
        DisputeEvents.DisputeOpened,
        {
          disputeId: dispute,
          transactionId: tx,
          buyerId: buyer,
          sellerId: seller,
          openedBy: buyer,
          reason: 'DAMAGED',
          previousState: 'DELIVERED',
        },
        at,
      ),
      ev(
        DisputeEvents.DisputeResolved,
        {
          disputeId: dispute,
          transactionId: tx,
          buyerId: buyer,
          sellerId: seller,
          resolution: 'RELEASE',
          resolvedBy: id(),
          note: 'ok',
        },
        at,
      ),
      ev(
        ReputationEvents.ReviewCreated,
        { reviewId: id(), transactionId: tx, authorId: buyer, subjectId: seller, rating: 5 },
        at,
      ),
      ev(
        BiddingEvents.AuctionOpened,
        {
          auctionId: auction,
          kind: 'FORWARD',
          ownerId: seller,
          subjectType: 'LISTING',
          subjectId: id(),
          categoryId: id(),
          title: 'Camera',
          district: 'dhaka',
          startPrice: money(1000),
          startsAt: at.toISOString(),
          endsAt: new Date(at.getTime() + 86_400_000).toISOString(),
        },
        at,
      ),
      ev(
        BiddingEvents.BidPlaced,
        {
          auctionId: auction,
          bidId: id(),
          bidderId: buyer,
          ownerId: seller,
          amount: money(1200),
          endsAt: new Date(at.getTime() + 86_400_000).toISOString(),
        },
        at,
      ),
      ev(
        BiddingEvents.BidPlaced,
        {
          auctionId: auction,
          bidId: id(),
          bidderId: id(),
          ownerId: seller,
          amount: money(1300),
          endsAt: new Date(at.getTime() + 86_400_000).toISOString(),
        },
        at,
      ),
      ev(
        BiddingEvents.AuctionAwarded,
        {
          auctionId: auction,
          winningBidId: id(),
          kind: 'FORWARD',
          needId: null,
          listingId: id(),
          buyerId: buyer,
          sellerId: seller,
          mode: 'BUY',
          amount: money(1300),
          quantity: 1,
          terms: {},
        },
        at,
      ),
      ev(
        RentalEvents.BookingConfirmed,
        {
          bookingId: id(),
          listingId: id(),
          ownerId: seller,
          renterId: buyer,
          startAt: at.toISOString(),
          endAt: at.toISOString(),
          amount: money(5000),
          deposit: null,
          terms: {},
        },
        at,
      ),
      ev(
        LendingEvents.LoanApproved,
        {
          loanId: id(),
          itemId: id(),
          lenderId: seller,
          borrowerId: buyer,
          startAt: at.toISOString(),
          returnBy: at.toISOString(),
          deposit: null,
          terms: {},
        },
        at,
      ),
      ev(
        MessagingEvents.MessageSent,
        {
          messageId: id(),
          conversationId: id(),
          contextType: 'OFFER',
          contextId: id(),
          senderId: buyer,
          recipientIds: [seller],
        },
        at,
      ),
      ev(
        VerificationEvents.VerificationStatusChanged,
        { accountId: buyer, kind: 'NID', status: 'PENDING' },
        at,
      ),
      ev(
        VerificationEvents.VerificationStatusChanged,
        { accountId: buyer, kind: 'NID', status: 'VERIFIED' },
        new Date(at.getTime() + 1000),
      ),
    ];
    for (const e of events) expect(await deliver(e), e.type).toBe(true);

    const expected = {
      signups: 1,
      logins: 2,
      needs_published: 1,
      listings_published: 1,
      offers_submitted: 1,
      offers_accepted: 1,
      transactions_created: 2,
      'transactions_created|mode:BUY': 1,
      'transactions_created|mode:RENT': 1,
      'transactions_created|source:OFFER': 1,
      'transactions_created|source:BOOKING': 1,
      transactions_completed: 1,
      gmv_completed: 150_000,
      transactions_cancelled: 1,
      disputes_opened: 1,
      disputes_resolved: 1,
      'disputes_resolved|resolution:RELEASE': 1,
      reviews_created: 1,
      auctions_opened: 1,
      bids_placed: 2,
      auctions_awarded: 1,
      bookings_confirmed: 1,
      loans_approved: 1,
      messages_sent: 1,
      verifications: 2,
      'verifications|NID:PENDING': 1,
      'verifications|NID:VERIFIED': 1,
    };
    expect(await dayRows(day)).toEqual(expected);

    // Redelivery of every event changes nothing.
    for (const e of events) expect(await deliver(e)).toBe(false);
    expect(await dayRows(day)).toEqual(expected);
  });

  it('uses the Asia/Dhaka calendar day', async () => {
    // 19:30 UTC on the 1st is 01:30 on the 2nd in Dhaka.
    await deliver(
      ev(IdentityEvents.AccountCreated, { accountId: id() }, '2024-06-01T19:30:00.000Z'),
    );
    await deliver(
      ev(IdentityEvents.AccountCreated, { accountId: id() }, '2024-06-01T17:59:59.000Z'),
    );
    expect((await dayRows('2024-06-02')).signups).toBe(1);
    expect((await dayRows('2024-06-01')).signups).toBe(1);
  });

  it('counts GMV on the completion day even when completion arrives before creation', async () => {
    const [tx, b, s] = [id(), id(), id()];
    await deliver(txChanged(tx, b, s, 'DELIVERED', 'COMPLETED', noon('2024-07-03')));
    expect((await dayRows('2024-07-03')).gmv_completed).toBeUndefined();
    await deliver(txCreated(tx, b, s, 99_900, noon('2024-07-01')));
    expect(await dayRows('2024-07-03')).toMatchObject({
      transactions_completed: 1,
      gmv_completed: 99_900,
    });
    expect((await dayRows('2024-07-01')).gmv_completed).toBeUndefined();
  });

  it('counts a deal completed again after a dispute only once', async () => {
    const [tx, b, s] = [id(), id(), id()];
    const d = '2024-07-10';
    const t0 = noon(d).getTime();
    await deliver(txCreated(tx, b, s, 10_000, new Date(t0)));
    await deliver(txChanged(tx, b, s, 'DELIVERED', 'COMPLETED', new Date(t0 + 1000)));
    await deliver(txChanged(tx, b, s, 'COMPLETED', 'DISPUTED', new Date(t0 + 2000)));
    await deliver(txChanged(tx, b, s, 'DISPUTED', 'COMPLETED', new Date(t0 + 3000)));
    expect(await dayRows(d)).toMatchObject({ transactions_completed: 1, gmv_completed: 10_000 });
  });
});

function listing(sellerId: string, listingId = randomUUID()) {
  return {
    listingId,
    sellerId,
    categoryId: randomUUID(),
    kind: 'PRODUCT' as const,
    condition: null,
    title: 'Phone',
    price: money(1000),
    priceUnit: 'TOTAL' as const,
    quantityAvailable: 1,
    district: 'dhaka' as const,
    attributes: {},
    deliveryModes: ['BUYER_PICKUP' as const],
  };
}

describe('summary', () => {
  beforeEach(clearSummaryCache);

  const signupsOn = async (day: string, n: number) => {
    for (let i = 0; i < n; i++) {
      await deliver(ev(IdentityEvents.AccountCreated, { accountId: id() }, noon(day)));
    }
  };

  it('compares the last 1/7/30 days with the previous period (fixed clock)', async () => {
    await signupsOn(TODAY, 2); // in 1d, 7d, 30d
    await signupsOn('2025-06-12', 1); // in 7d, 30d
    await signupsOn('2025-06-05', 4); // previous 7d (06-02…06-08), current 30d
    await signupsOn('2025-05-01', 5); // previous 30d (04-17…05-16)

    const res = await get('/api/v1/admin/dashboard/summary');
    expect(res.statusCode).toBe(200);
    const s = res.json().data;
    expect(s.today).toBe(TODAY);
    expect(s.generatedAt).toBe(NOW.toISOString());
    const signups = (days: number) => {
      const p = s.periods.find((x: { days: number }) => x.days === days);
      return { window: p, m: p.metrics.find((m: { metric: string }) => m.metric === 'signups') };
    };
    expect(signups(1).m).toEqual({
      metric: 'signups',
      current: 2,
      previous: 0,
      change: 2,
      changePct: null,
    });
    expect(signups(7).window).toMatchObject({
      from: '2025-06-09',
      to: TODAY,
      previousFrom: '2025-06-02',
      previousTo: '2025-06-08',
    });
    expect(signups(7).m).toEqual({
      metric: 'signups',
      current: 3,
      previous: 4,
      change: -1,
      changePct: -25,
    });
    expect(signups(30).m).toEqual({
      metric: 'signups',
      current: 7,
      previous: 5,
      change: 2,
      changePct: 40,
    });
    // Every metric is reported, zero when nothing happened.
    expect(signups(30).window.metrics).toHaveLength(20);
    expect(
      signups(30).window.metrics.find((m: { metric: string }) => m.metric === 'bids_placed'),
    ).toMatchObject({ current: 0, previous: 0 });
  });

  it('reports gauges from the current-state projections', async () => {
    const [b, s] = [id(), id()];
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms);
    const before = (await get('/api/v1/admin/dashboard/summary')).json().data.gauges;
    await clearSummaryCache();

    const need = id();
    await deliver(
      ev(
        DemandEvents.NeedStatusChanged,
        { needId: need, requesterId: b, from: 'DRAFT', to: 'OPEN', reason: 'x' },
        at(0),
      ),
    );
    const l1 = id();
    await deliver(ev(CatalogEvents.ListingPublished, listing(s, l1), at(0)));
    await deliver(ev(CatalogEvents.ListingPublished, listing(s), at(0)));
    await deliver(
      ev(
        CatalogEvents.ListingUnavailable,
        { listingId: l1, sellerId: s, reason: 'SOLD_OUT' },
        at(1000),
      ),
    );
    const tx = id();
    await deliver(txCreated(tx, b, s, 70_000, at(0)));
    await deliver(
      ev(
        DisputeEvents.DisputeOpened,
        {
          disputeId: id(),
          transactionId: tx,
          buyerId: b,
          sellerId: s,
          openedBy: b,
          reason: 'OTHER',
          previousState: 'CREATED',
        },
        at(0),
      ),
    );
    await deliver(
      ev(
        VerificationEvents.VerificationStatusChanged,
        { accountId: b, kind: 'NID', status: 'PENDING' },
        at(0),
      ),
    );
    await deliver(
      ev(
        BiddingEvents.AuctionOpened,
        {
          auctionId: id(),
          kind: 'FORWARD',
          ownerId: s,
          subjectType: 'LISTING',
          subjectId: id(),
          categoryId: id(),
          title: 'x',
          district: 'dhaka',
          startPrice: money(1),
          startsAt: at(0).toISOString(),
          endsAt: at(86_400_000).toISOString(),
        },
        at(0),
      ),
    );
    await deliver(
      ev(
        RentalEvents.BookingStatusChanged,
        {
          bookingId: id(),
          listingId: id(),
          ownerId: s,
          renterId: b,
          from: 'CONFIRMED',
          to: 'ACTIVE',
          transactionId: null,
          reason: 'x',
        },
        at(0),
      ),
    );
    await deliver(
      ev(
        RentalEvents.BookingConfirmed,
        {
          bookingId: id(),
          listingId: id(),
          ownerId: s,
          renterId: b,
          startAt: at(0).toISOString(),
          endAt: at(1).toISOString(),
          amount: money(1),
          deposit: null,
          terms: {},
        },
        at(0),
      ),
    );
    await deliver(
      ev(
        LendingEvents.LoanStatusChanged,
        {
          loanId: id(),
          itemId: id(),
          lenderId: s,
          borrowerId: b,
          from: 'APPROVED',
          to: 'LENT',
          transactionId: null,
          reason: 'x',
        },
        at(0),
      ),
    );

    const g = (await get('/api/v1/admin/dashboard/summary')).json().data.gauges;
    const created = (x: typeof g) =>
      x.transactionsByState.find((r: { state: string }) => r.state === 'CREATED') ?? {
        count: 0,
        amount: { amount: 0 },
      };
    expect(g.needsByStatus.OPEN).toBe((before.needsByStatus.OPEN ?? 0) + 1);
    expect(g.activeListings).toBe(before.activeListings + 1);
    expect(created(g).count).toBe(created(before).count + 1);
    expect(created(g).amount.amount).toBe(created(before).amount.amount + 70_000);
    expect(g.openDisputes).toBe(before.openDisputes + 1);
    expect(g.pendingVerifications).toBe(before.pendingVerifications + 1);
    expect(g.liveAuctions).toBe(before.liveAuctions + 1);
    expect(g.activeBookings).toBe(before.activeBookings + 1);
    expect(g.upcomingBookings).toBe(before.upcomingBookings + 1);
    expect(g.activeLoans).toBe(before.activeLoans + 1);
  });

  it('is cached in Redis for DASHBOARD_CACHE_SECONDS', async () => {
    const first = (await get('/api/v1/admin/dashboard/summary')).json().data;
    const signups = (s: typeof first) =>
      s.periods[0].metrics.find((m: { metric: string }) => m.metric === 'signups').current;
    await signupsOn(TODAY, 1);
    // Served from the cache: the new signup is not visible yet.
    expect(signups((await get('/api/v1/admin/dashboard/summary')).json().data)).toBe(
      signups(first),
    );
    const ttl = await t.svc.runtime.redis.ttl(`summary:${t.schema}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
    // Once the entry expires, the next read recomputes.
    await clearSummaryCache();
    expect(signups((await get('/api/v1/admin/dashboard/summary')).json().data)).toBe(
      signups(first) + 1,
    );
  });
});

describe('timeseries', () => {
  it('zero-fills days and weeks', async () => {
    const msg = () => ({
      messageId: id(),
      conversationId: id(),
      contextType: 'OFFER' as const,
      contextId: id(),
      senderId: id(),
      recipientIds: [id()],
    });
    await deliver(ev(MessagingEvents.MessageSent, msg(), noon('2023-01-02')));
    await deliver(ev(MessagingEvents.MessageSent, msg(), noon('2023-01-02')));
    await deliver(ev(MessagingEvents.MessageSent, msg(), noon('2023-01-05')));

    const daily = await get(
      '/api/v1/admin/dashboard/timeseries?metric=messages_sent&from=2023-01-01&to=2023-01-07',
    );
    expect(daily.statusCode).toBe(200);
    expect(daily.json().data).toMatchObject({
      metric: 'messages_sent',
      dimension: '',
      interval: 'day',
      total: 3,
    });
    expect(daily.json().data.points).toEqual([
      { start: '2023-01-01', value: 0 },
      { start: '2023-01-02', value: 2 },
      { start: '2023-01-03', value: 0 },
      { start: '2023-01-04', value: 0 },
      { start: '2023-01-05', value: 1 },
      { start: '2023-01-06', value: 0 },
      { start: '2023-01-07', value: 0 },
    ]);

    // 2023-01-01 is a Sunday: its ISO week starts on 2022-12-26.
    const weekly = await get(
      '/api/v1/admin/dashboard/timeseries?metric=messages_sent&from=2023-01-01&to=2023-01-10&interval=week',
    );
    expect(weekly.json().data.points).toEqual([
      { start: '2022-12-26', value: 0 },
      { start: '2023-01-02', value: 3 },
      { start: '2023-01-09', value: 0 },
    ]);
  });

  it('filters by dimension', async () => {
    const [b, s] = [id(), id()];
    await deliver(txCreated(id(), b, s, 1, noon('2023-02-01')));
    const res = await get(
      '/api/v1/admin/dashboard/timeseries?metric=transactions_created&dimension=mode:BUY&from=2023-02-01&to=2023-02-01',
    );
    expect(res.json().data.points).toEqual([{ start: '2023-02-01', value: 1 }]);
    const none = await get(
      '/api/v1/admin/dashboard/timeseries?metric=transactions_created&dimension=mode:RENT&from=2023-02-01&to=2023-02-01',
    );
    expect(none.json().data.points).toEqual([{ start: '2023-02-01', value: 0 }]);
  });

  it('defaults to the last 30 days and validates the range', async () => {
    const res = await get('/api/v1/admin/dashboard/timeseries?metric=signups');
    expect(res.json().data).toMatchObject({ from: '2025-05-17', to: TODAY });
    expect(res.json().data.points).toHaveLength(30);
    expect(
      (await get('/api/v1/admin/dashboard/timeseries?metric=signups&from=2024-01-01&to=2024-12-31'))
        .statusCode,
    ).toBe(200); // 366 days
    expect(
      (await get('/api/v1/admin/dashboard/timeseries?metric=signups&from=2024-01-01&to=2025-01-01'))
        .statusCode,
    ).toBe(400);
    expect(
      (await get('/api/v1/admin/dashboard/timeseries?metric=signups&from=2024-02-01&to=2024-01-01'))
        .statusCode,
    ).toBe(400);
    expect((await get('/api/v1/admin/dashboard/timeseries?metric=nope')).statusCode).toBe(400);
    expect(
      (await get('/api/v1/admin/dashboard/timeseries?metric=signups&from=2024-1-1')).statusCode,
    ).toBe(400);
  });
});

describe('funnel', () => {
  it('needs published → got an offer → offers accepted → deals completed', async () => {
    const [b, s] = [id(), id()];
    const [n1, n2, n3, nOutside] = [id(), id(), id(), id()];
    const open = (needId: string, day: string) =>
      ev(
        DemandEvents.NeedStatusChanged,
        { needId, requesterId: b, from: 'DRAFT', to: 'OPEN', reason: 'x' },
        noon(day),
      );
    const offer = (needId: string, day: string) =>
      ev(
        OfferEvents.OfferSubmitted,
        { offerId: id(), needId, buyerId: b, sellerId: s, price: money(100), quantity: 1 },
        noon(day),
      );

    // An offer can arrive before the need's publish event is delivered.
    await deliver(offer(n1, '2023-03-04'));
    await deliver(open(n1, '2023-03-03'));
    await deliver(open(n2, '2023-03-04'));
    await deliver(offer(n2, '2023-03-05'));
    await deliver(offer(n2, '2023-03-06'));
    await deliver(open(n3, '2023-03-05'));
    await deliver(open(nOutside, '2023-04-01'));
    await deliver(offer(nOutside, '2023-04-01'));
    await deliver(
      ev(
        OfferEvents.OfferAccepted,
        {
          offerId: id(),
          needId: n1,
          buyerId: b,
          sellerId: s,
          listingId: null,
          mode: 'BUY',
          price: money(100),
          quantity: 1,
          terms: {},
        },
        noon('2023-03-07'),
      ),
    );
    const tx = id();
    await deliver(txCreated(tx, b, s, 100, noon('2023-03-07')));
    await deliver(txChanged(tx, b, s, 'DELIVERED', 'COMPLETED', noon('2023-03-09')));

    const res = await get('/api/v1/admin/dashboard/funnel?from=2023-03-01&to=2023-03-31');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      from: '2023-03-01',
      to: '2023-03-31',
      steps: [
        { step: 'needsPublished', count: 3, conversionPct: null },
        { step: 'needsWithOffer', count: 2, conversionPct: 66.7 },
        { step: 'offersAccepted', count: 1, conversionPct: 50 },
        { step: 'transactionsCompleted', count: 1, conversionPct: 100 },
      ],
    });
  });
});

describe('schema', () => {
  it('stores days as dates keyed by (day, metric, dimension)', async () => {
    const r = await sql<{
      data_type: string;
    }>`select data_type from information_schema.columns where table_schema = ${t.schema} and table_name = 'daily_metrics' and column_name = 'day'`.execute(
      t.svc.runtime.database.root,
    );
    expect(r.rows[0]?.data_type).toBe('date');
  });
});
