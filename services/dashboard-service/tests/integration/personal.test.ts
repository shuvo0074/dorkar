import { randomUUID } from 'node:crypto';
import {
  BiddingEvents,
  DemandEvents,
  DisputeEvents,
  LendingEvents,
  OfferEvents,
  RentalEvents,
  ReputationEvents,
  TransactionEvents,
  type EventEnvelope,
  type TransactionState,
} from '@dorkar/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ev, money, start, type T } from '../helpers';

let t: T;
const deliver = (e: EventEnvelope) => t.svc.runtime.deliver(e);
const id = () => randomUUID();

beforeAll(async () => {
  t = await start();
});
afterAll(() => t.close());

const dashboard = async (accountId: string) => {
  const res = await t.svc.runtime.app.inject({
    url: '/api/v1/me/dashboard',
    headers: await t.auth.as(accountId),
  });
  expect(res.statusCode).toBe(200);
  return res.json().data;
};

const t0 = Date.now() - 60 * 60 * 1000;
const at = (s: number) => new Date(t0 + s * 1000);

const txCreated = (tx: string, buyerId: string, sellerId: string, amount: number, s: number) =>
  ev(
    TransactionEvents.TransactionCreated,
    {
      transactionId: tx,
      sourceType: 'OFFER',
      sourceId: id(),
      needId: null,
      buyerId,
      sellerId,
      amount: money(amount),
      quantity: 1,
      mode: 'BUY',
    },
    at(s),
    tx,
  );
const txChanged = (
  tx: string,
  buyerId: string,
  sellerId: string,
  from: TransactionState,
  to: TransactionState,
  s: number,
) =>
  ev(
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
    },
    at(s),
    tx,
  );

describe('personal dashboard', () => {
  it('is empty for a new member and requires authentication', async () => {
    const d = await dashboard(id());
    expect(d).toEqual({
      buyer: {
        openNeeds: 0,
        offersAwaitingResponse: 0,
        transactionsByState: {},
        totalSpent: { amount: 0, currency: 'BDT' },
      },
      seller: {
        offersByStatus: {},
        transactionsByState: {},
        earnings: { amount: 0, currency: 'BDT' },
        rating: null,
      },
      auctions: { owned: 0, bidding: 0, live: [] },
      bookings: { asRenter: 0, asOwner: 0, items: [] },
      loans: { asLender: 0, asBorrower: 0, items: [] },
      disputes: { open: 0, items: [] },
    });
    expect((await t.svc.runtime.app.inject({ url: '/api/v1/me/dashboard' })).statusCode).toBe(401);
  });

  it('adds up a sequence of events, in and out of order, for buyer and seller', async () => {
    const me = id(); // buyer in most deals
    const seller = id();
    const other = id();

    const events: EventEnvelope[] = [];
    const push = (...e: EventEnvelope[]) => events.push(...e);

    // ---- needs: one open, one closed, one paused (the pause arrives before the publish)
    const [n1, n2, n3] = [id(), id(), id()];
    const need = (needId: string, from: string, to: string, s: number) =>
      ev(
        DemandEvents.NeedStatusChanged,
        { needId, requesterId: me, from: from as 'DRAFT', to: to as 'OPEN', reason: 'x' },
        at(s),
      );
    push(need(n1, 'DRAFT', 'OPEN', 1));
    push(need(n2, 'DRAFT', 'OPEN', 1), need(n2, 'OPEN', 'CLOSED', 2));
    push(need(n3, 'OPEN', 'PAUSED', 3), need(n3, 'DRAFT', 'OPEN', 2));

    // ---- offers I received (as buyer) and sent (as seller of someone else's need)
    const offer = (offerId: string, buyerId: string, sellerId: string, s: number) =>
      ev(
        OfferEvents.OfferSubmitted,
        { offerId, needId: n1, buyerId, sellerId, price: money(500), quantity: 1 },
        at(s),
      );
    const [o1, o2, o3, o4] = [id(), id(), id(), id()];
    push(offer(o1, me, seller, 5)); // awaiting me
    push(
      offer(o2, me, other, 5),
      ev(
        OfferEvents.OfferStatusChanged,
        {
          offerId: o2,
          needId: n1,
          buyerId: me,
          sellerId: other,
          from: 'SUBMITTED',
          to: 'REJECTED',
          reason: 'x',
        },
        at(6),
      ),
    );
    push(
      offer(o3, me, seller, 5),
      ev(
        OfferEvents.OfferCountered,
        {
          offerId: o3,
          needId: n1,
          buyerId: me,
          sellerId: seller,
          by: 'SELLER',
          round: 2,
          price: money(450),
          quantity: 1,
        },
        at(7),
      ),
    ); // countered by the seller: awaiting me
    push(offer(o4, other, me, 5)); // I am the seller

    // ---- transactions
    const [t1, t2, t3, t4] = [id(), id(), id(), id()];
    push(
      txCreated(t1, me, seller, 100_000, 10),
      txChanged(t1, me, seller, 'DELIVERED', 'COMPLETED', 12),
    );
    push(
      txCreated(t2, me, seller, 50_000, 10),
      txChanged(t2, me, seller, 'CREATED', 'CONFIRMED', 11),
    );
    // Out of order: the confirmation arrives before the creation; creation must not reset it.
    push(
      txChanged(t3, me, seller, 'CREATED', 'CONFIRMED', 11),
      txCreated(t3, me, seller, 20_000, 10),
    );
    // I sold something: a completed deal, and a stale event delivered after the completion.
    push(
      txCreated(t4, other, me, 30_000, 10),
      txChanged(t4, other, me, 'DELIVERED', 'COMPLETED', 13),
      txChanged(t4, other, me, 'CONFIRMED', 'DELIVERED', 12),
    );

    // ---- my rating (a late, older update is ignored)
    const rep = (avg: number, n: number, s: number) =>
      ev(
        ReputationEvents.ReputationUpdated,
        {
          accountId: me,
          ratingAverage: avg,
          ratingCount: n,
          completedCount: n,
          cancelledCount: 0,
          disputedCount: 0,
        },
        at(s),
      );
    push(rep(4.5, 2, 20), rep(3, 1, 15));

    // ---- auctions: one I own, one I bid in, one I bid in that closed
    const [a1, a2, a3] = [id(), id(), id()];
    const opened = (auctionId: string, ownerId: string, endsIn: number) =>
      ev(
        BiddingEvents.AuctionOpened,
        {
          auctionId,
          kind: 'FORWARD',
          ownerId,
          subjectType: 'LISTING',
          subjectId: id(),
          categoryId: id(),
          title: 'x',
          district: 'dhaka',
          startPrice: money(100),
          startsAt: at(0).toISOString(),
          endsAt: at(endsIn).toISOString(),
        },
        at(1),
      );
    const bid = (auctionId: string, ownerId: string, s: number, endsIn: number) =>
      ev(
        BiddingEvents.BidPlaced,
        {
          auctionId,
          bidId: id(),
          bidderId: me,
          ownerId,
          amount: money(200),
          endsAt: at(endsIn).toISOString(),
        },
        at(s),
      );
    push(opened(a1, me, 9_000));
    push(opened(a2, other, 5_000), bid(a2, other, 2, 5_000));
    // Closed before (in delivery order) the open: stays closed.
    push(
      ev(
        BiddingEvents.AuctionClosed,
        {
          auctionId: a3,
          kind: 'FORWARD',
          ownerId: other,
          subjectType: 'LISTING',
          subjectId: id(),
          categoryId: id(),
          outcome: 'NO_WINNER',
          winnerId: null,
          winningBidId: null,
          amount: null,
          bidderIds: [me],
        },
        at(30),
      ),
      opened(a3, other, 20),
      bid(a3, other, 2, 20),
    );

    // ---- bookings: upcoming as renter, active as owner, cancelled as renter
    const [k1, k2, k3] = [id(), id(), id()];
    const confirmed = (bookingId: string, ownerId: string, renterId: string, startIn: number) =>
      ev(
        RentalEvents.BookingConfirmed,
        {
          bookingId,
          listingId: id(),
          ownerId,
          renterId,
          startAt: at(startIn).toISOString(),
          endAt: at(startIn + 86_400).toISOString(),
          amount: money(1_000),
          deposit: null,
          terms: {},
        },
        at(1),
      );
    const booking = (
      bookingId: string,
      ownerId: string,
      renterId: string,
      from: string,
      to: string,
      s: number,
    ) =>
      ev(
        RentalEvents.BookingStatusChanged,
        {
          bookingId,
          listingId: id(),
          ownerId,
          renterId,
          from: from as 'CONFIRMED',
          to: to as 'ACTIVE',
          transactionId: null,
          reason: 'x',
        },
        at(s),
      );
    push(confirmed(k1, other, me, 7_200));
    push(confirmed(k2, me, other, 60), booking(k2, me, other, 'CONFIRMED', 'ACTIVE', 2));
    push(confirmed(k3, other, me, 3_600), booking(k3, other, me, 'CONFIRMED', 'CANCELLED', 2));

    // ---- loans: borrowing (approved), lending (lent), one closed
    const [l1, l2, l3] = [id(), id(), id()];
    const approved = (loanId: string, lenderId: string, borrowerId: string, returnIn: number) =>
      ev(
        LendingEvents.LoanApproved,
        {
          loanId,
          itemId: id(),
          lenderId,
          borrowerId,
          startAt: at(0).toISOString(),
          returnBy: at(returnIn).toISOString(),
          deposit: null,
          terms: {},
        },
        at(1),
      );
    const loan = (
      loanId: string,
      lenderId: string,
      borrowerId: string,
      from: string,
      to: string,
      s: number,
    ) =>
      ev(
        LendingEvents.LoanStatusChanged,
        {
          loanId,
          itemId: id(),
          lenderId,
          borrowerId,
          from: from as 'APPROVED',
          to: to as 'LENT',
          transactionId: null,
          reason: 'x',
        },
        at(s),
      );
    push(approved(l1, other, me, 5_000));
    push(approved(l2, me, other, 3_000), loan(l2, me, other, 'APPROVED', 'LENT', 2));
    push(approved(l3, me, other, 1_000), loan(l3, me, other, 'APPROVED', 'CLOSED', 2));

    // ---- disputes: one open (I'm the buyer), one resolved
    const [d1, d2] = [id(), id()];
    const facts = (disputeId: string, tx: string) => ({
      disputeId,
      transactionId: tx,
      buyerId: me,
      sellerId: seller,
    });
    push(
      ev(
        DisputeEvents.DisputeOpened,
        { ...facts(d1, t2), openedBy: me, reason: 'NOT_RECEIVED', previousState: 'CONFIRMED' },
        at(20),
      ),
      ev(
        DisputeEvents.DisputeStatusChanged,
        { ...facts(d1, t2), from: 'OPEN', to: 'AWAITING_RESPONSE', actorId: null },
        at(21),
      ),
    );
    push(
      ev(
        DisputeEvents.DisputeOpened,
        { ...facts(d2, t3), openedBy: me, reason: 'OTHER', previousState: 'CONFIRMED' },
        at(20),
      ),
      ev(
        DisputeEvents.DisputeResolved,
        { ...facts(d2, t3), resolution: 'CANCEL', resolvedBy: id(), note: 'x' },
        at(22),
      ),
    );

    for (const e of events) expect(await deliver(e), e.type).toBe(true);
    // Redelivering everything changes nothing.
    for (const e of events) expect(await deliver(e)).toBe(false);

    const d = await dashboard(me);
    expect(d.buyer).toEqual({
      openNeeds: 1,
      offersAwaitingResponse: 2,
      transactionsByState: { COMPLETED: 1, CONFIRMED: 2 },
      totalSpent: { amount: 100_000, currency: 'BDT' },
    });
    expect(d.seller).toEqual({
      offersByStatus: { SUBMITTED: 1 },
      transactionsByState: { COMPLETED: 1 },
      earnings: { amount: 30_000, currency: 'BDT' },
      rating: { average: 4.5, count: 2, completedCount: 2 },
    });
    expect(d.auctions).toEqual({
      owned: 1,
      bidding: 1,
      live: [
        { auctionId: a2, role: 'BIDDER', endsAt: at(5_000).toISOString() },
        { auctionId: a1, role: 'OWNER', endsAt: at(9_000).toISOString() },
      ],
    });
    expect(d.bookings.asRenter).toBe(1);
    expect(d.bookings.asOwner).toBe(1);
    expect(
      d.bookings.items.map((b: { bookingId: string; role: string; status: string }) => [
        b.bookingId,
        b.role,
        b.status,
      ]),
    ).toEqual([
      [k2, 'OWNER', 'ACTIVE'],
      [k1, 'RENTER', 'CONFIRMED'],
    ]);
    expect(d.loans.asLender).toBe(1);
    expect(d.loans.asBorrower).toBe(1);
    expect(
      d.loans.items.map((l: { loanId: string; role: string; status: string }) => [
        l.loanId,
        l.role,
        l.status,
      ]),
    ).toEqual([
      [l2, 'LENDER', 'LENT'],
      [l1, 'BORROWER', 'APPROVED'],
    ]);
    expect(d.disputes).toEqual({
      open: 1,
      items: [{ disputeId: d1, transactionId: t2, role: 'BUYER', status: 'AWAITING_RESPONSE' }],
    });

    // The counterpart sees the same deals from the other side.
    const s = await dashboard(seller);
    expect(s.seller.transactionsByState).toEqual({ COMPLETED: 1, CONFIRMED: 2 });
    expect(s.seller.earnings.amount).toBe(100_000);
    expect(s.seller.offersByStatus).toEqual({ SUBMITTED: 1, COUNTERED_BY_SELLER: 1 });
    expect(s.disputes.items[0]).toMatchObject({ disputeId: d1, role: 'SELLER' });
  });
});
