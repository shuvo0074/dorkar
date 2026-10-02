import { randomUUID } from 'node:crypto';
import {
  BiddingEvents,
  BookingStatuses,
  DisputeEvents,
  DisputeStatuses,
  LendingEvents,
  LoanStatuses,
  MessagingEvents,
  RentalEvents,
  TransactionEvents,
} from '@dorkar/contracts';
import { describe, expect, it } from 'vitest';
import { notificationsFor } from '../../src/domain/rules';

const owner = randomUUID();
const a = randomUUID();
const b = randomUUID();
const c = randomUUID();
const names = new Map<string, string>([
  [owner, 'owner'],
  [a, 'a'],
  [b, 'b'],
  [c, 'c'],
]);
const who = (xs: { recipientId: string; type: string }[]) =>
  xs.map((x) => `${names.get(x.recipientId) ?? x.recipientId}:${x.type}`);

const money = { amount: 50_000, currency: 'BDT' as const };
const auctionId = randomUUID();
const auction = {
  auctionId,
  kind: 'FORWARD' as const,
  ownerId: owner,
  subjectType: 'LISTING' as const,
  subjectId: randomUUID(),
  categoryId: randomUUID(),
};

describe('bidding', () => {
  it('BidPlaced → owner, with the bid facts', () => {
    const bidId = randomUUID();
    const out = notificationsFor(BiddingEvents.BidPlaced, {
      auctionId,
      bidId,
      bidderId: a,
      ownerId: owner,
      amount: money,
      endsAt: new Date().toISOString(),
    });
    expect(out).toEqual([
      { recipientId: owner, type: 'BID_PLACED', payload: { auctionId, bidId, amount: money } },
    ]);
  });

  it('BidOutbid → the outbid bidder', () => {
    const out = notificationsFor(BiddingEvents.BidOutbid, {
      auctionId,
      bidId: randomUUID(),
      bidderId: a,
      leadingAmount: money,
    });
    expect(who(out)).toEqual(['a:BID_OUTBID']);
  });

  const closed = (
    outcome: 'AWARDED' | 'NO_WINNER' | 'CANCELLED',
    winnerId: string | null,
    bidderIds: string[],
  ) =>
    notificationsFor(BiddingEvents.AuctionClosed, {
      ...auction,
      outcome,
      winnerId,
      winningBidId: winnerId ? randomUUID() : null,
      amount: winnerId ? money : null,
      bidderIds,
    });

  it('AuctionClosed AWARDED → owner outcome, winner WON, each other bidder LOST once', () => {
    const out = closed('AWARDED', b, [a, b, c, a]);
    expect(who(out)).toEqual([
      'owner:AUCTION_CLOSED',
      'b:AUCTION_WON',
      'a:AUCTION_LOST',
      'c:AUCTION_LOST',
    ]);
    expect(out[0]!.payload).toEqual({ auctionId, outcome: 'AWARDED', amount: money });
    expect(out[3]!.payload).toEqual({ auctionId }); // losers never see the price
  });

  it('AuctionClosed NO_WINNER → owner and every bidder LOST', () => {
    expect(who(closed('NO_WINNER', null, [a, c]))).toEqual([
      'owner:AUCTION_CLOSED',
      'a:AUCTION_LOST',
      'c:AUCTION_LOST',
    ]);
  });

  it('AuctionClosed CANCELLED → owner and AUCTION_CANCELLED to the bidders', () => {
    expect(who(closed('CANCELLED', null, [a, b]))).toEqual([
      'owner:AUCTION_CLOSED',
      'a:AUCTION_CANCELLED',
      'b:AUCTION_CANCELLED',
    ]);
  });
});

describe('rental', () => {
  const booking = { bookingId: randomUUID(), listingId: randomUUID(), ownerId: owner, renterId: a };
  const changed = (to: (typeof BookingStatuses)[number], reason = 'x') =>
    who(
      notificationsFor(RentalEvents.BookingStatusChanged, {
        ...booking,
        from: 'HELD',
        to,
        transactionId: null,
        reason,
      }),
    );

  it('maps every target status to its recipients', () => {
    const expected: Record<(typeof BookingStatuses)[number], string[]> = {
      HELD: [],
      PENDING_APPROVAL: ['owner:BOOKING_REQUESTED'],
      CONFIRMED: ['a:BOOKING_CONFIRMED', 'owner:BOOKING_CONFIRMED'],
      ACTIVE: [],
      RETURNED: [],
      CLOSED: [],
      DECLINED: ['a:BOOKING_DECLINED'],
      CANCELLED: ['a:BOOKING_CANCELLED', 'owner:BOOKING_CANCELLED'],
      EXPIRED: ['a:BOOKING_EXPIRED'],
    };
    for (const to of BookingStatuses) expect(changed(to), to).toEqual(expected[to]);
  });

  it('CANCELLED goes to the other party when the reason names the canceller', () => {
    expect(changed('CANCELLED', 'RENTER_CANCELLED')).toEqual(['owner:BOOKING_CANCELLED']);
    expect(changed('CANCELLED', 'owner_cancelled')).toEqual(['a:BOOKING_CANCELLED']);
  });

  it('BookingOverdue → renter and owner, each told their role', () => {
    const out = notificationsFor(RentalEvents.BookingOverdue, {
      ...booking,
      transactionId: null,
      endAt: new Date().toISOString(),
    });
    expect(who(out)).toEqual(['a:BOOKING_OVERDUE', 'owner:BOOKING_OVERDUE']);
    expect(out.map((o) => o.payload['role'])).toEqual(['RENTER', 'OWNER']);
  });
});

describe('lending', () => {
  const loan = { loanId: randomUUID(), itemId: randomUUID(), lenderId: owner, borrowerId: a };
  const ts = new Date().toISOString();

  it('LoanRequested → lender', () => {
    expect(
      who(notificationsFor(LendingEvents.LoanRequested, { ...loan, startAt: ts, returnBy: ts })),
    ).toEqual(['owner:LOAN_REQUESTED']);
  });

  it('LoanStatusChanged: APPROVED/DECLINED/EXPIRED → borrower; others → nothing', () => {
    for (const to of LoanStatuses) {
      const out = who(
        notificationsFor(LendingEvents.LoanStatusChanged, {
          ...loan,
          from: 'REQUESTED',
          to,
          transactionId: null,
          reason: 'x',
        }),
      );
      const expected =
        to === 'APPROVED' || to === 'DECLINED' || to === 'EXPIRED' ? [`a:LOAN_${to}`] : [];
      expect(out, to).toEqual(expected);
    }
  });

  it('LoanOverdue → borrower and lender', () => {
    expect(
      who(
        notificationsFor(LendingEvents.LoanOverdue, { ...loan, transactionId: null, returnBy: ts }),
      ),
    ).toEqual(['a:LOAN_OVERDUE', 'owner:LOAN_OVERDUE']);
  });
});

describe('disputes', () => {
  const dispute = {
    disputeId: randomUUID(),
    transactionId: randomUUID(),
    buyerId: a,
    sellerId: b,
  };

  it('DisputeOpened → both parties; the other side is asked to respond', () => {
    const out = notificationsFor(DisputeEvents.DisputeOpened, {
      ...dispute,
      openedBy: a,
      reason: 'NOT_AS_DESCRIBED',
      previousState: 'DELIVERED',
    });
    expect(who(out)).toEqual(['a:DISPUTE_OPENED', 'b:DISPUTE_OPENED']);
    expect(out.map((o) => o.payload['role'])).toEqual(['OPENER', 'RESPONDENT']);

    const byOperator = notificationsFor(DisputeEvents.DisputeOpened, {
      ...dispute,
      openedBy: randomUUID(),
      reason: 'OTHER',
      previousState: 'DELIVERED',
    });
    expect(byOperator.map((o) => o.payload['role'])).toEqual(['PARTY', 'PARTY']);
  });

  it('DisputeStatusChanged → both parties, except RESOLVED/WITHDRAWN (own events)', () => {
    for (const to of DisputeStatuses) {
      const out = who(
        notificationsFor(DisputeEvents.DisputeStatusChanged, {
          ...dispute,
          from: 'OPEN',
          to,
          actorId: null,
        }),
      );
      const expected =
        to === 'RESOLVED' || to === 'WITHDRAWN' || to === 'OPEN'
          ? []
          : ['a:DISPUTE_UPDATED', 'b:DISPUTE_UPDATED'];
      expect(out, to).toEqual(expected);
    }
  });

  it('DisputeResolved → both parties, never copying the free-text note', () => {
    const out = notificationsFor(DisputeEvents.DisputeResolved, {
      ...dispute,
      resolution: 'REFUND',
      resolvedBy: randomUUID(),
      note: 'Seller phone 01712345678 said…',
    });
    expect(who(out)).toEqual(['a:DISPUTE_RESOLVED', 'b:DISPUTE_RESOLVED']);
    expect(JSON.stringify(out)).not.toContain('01712345678');
    expect(out[0]!.payload['resolution']).toBe('REFUND');
  });

  it('DisputeWithdrawn → both parties', () => {
    expect(
      who(
        notificationsFor(DisputeEvents.DisputeWithdrawn, {
          ...dispute,
          withdrawnBy: a,
          previousState: 'DELIVERED',
        }),
      ),
    ).toEqual(['a:DISPUTE_WITHDRAWN', 'b:DISPUTE_WITHDRAWN']);
  });
});

describe('messaging', () => {
  it('MessageSent → each recipient once (never the sender), coalesced by conversation', () => {
    const conversationId = randomUUID();
    const out = notificationsFor(MessagingEvents.MessageSent, {
      messageId: randomUUID(),
      conversationId,
      contextType: 'OFFER',
      contextId: randomUUID(),
      senderId: a,
      recipientIds: [b, c, b, a],
    });
    expect(who(out)).toEqual(['b:NEW_MESSAGE', 'c:NEW_MESSAGE']);
    expect(out.every((o) => o.coalesceKey === conversationId)).toBe(true);
    expect(out[0]!.payload['count']).toBe(1);
  });
});

describe('transactions (RENT/BORROW sub-flow)', () => {
  it('HANDED_OVER / RETURN_REPORTED / RETURNED → the other party, with the mode', () => {
    const tx = {
      transactionId: randomUUID(),
      needId: null,
      sourceType: 'BOOKING' as const,
      sourceId: randomUUID(),
      buyerId: a,
      sellerId: owner,
      mode: 'RENT' as const,
    };
    const steps = [
      ['CONFIRMED', 'HANDED_OVER', owner, ['a:TRANSACTION_UPDATED']],
      ['HANDED_OVER', 'RETURN_REPORTED', a, ['owner:TRANSACTION_UPDATED']],
      ['RETURN_REPORTED', 'RETURNED', owner, ['a:TRANSACTION_UPDATED']],
    ] as const;
    for (const [from, to, actorId, expected] of steps) {
      const out = notificationsFor(TransactionEvents.TransactionStateChanged, {
        ...tx,
        from,
        to,
        actorId,
      });
      expect(who(out), to).toEqual(expected);
      expect(out[0]!.payload).toEqual({ transactionId: tx.transactionId, from, to, mode: 'RENT' });
    }
  });
});
