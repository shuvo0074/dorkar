import {
  BiddingEvents,
  DemandEvents,
  DisputeEvents,
  LendingEvents,
  MatchingEvents,
  MessagingEvents,
  OfferEvents,
  RentalEvents,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
} from '@dorkar/contracts';
import type { EventDefinition } from '@dorkar/kernel';
import type { z } from 'zod';
import type { NotificationIntent, NotificationPayload, NotificationType } from './notification';

/** One consumed event and who it notifies, about what. Pure: no I/O, no clock. */
export interface NotificationRule {
  readonly def: EventDefinition<z.ZodType>;
  /** Receives the payload already validated against `def.schema`. */
  map(payload: unknown): NotificationIntent[];
}

const rule = <S extends z.ZodType>(
  def: EventDefinition<S>,
  map: (p: z.output<S>) => NotificationIntent[],
): NotificationRule => ({ def, map: (p) => map(p as z.output<S>) });

const to = (
  recipientId: string,
  type: NotificationType,
  payload: NotificationPayload,
): NotificationIntent => ({ recipientId, type, payload });

/** Each id once, in first-seen order, minus `except`. */
const distinct = (ids: readonly string[], except: readonly (string | null)[] = []): string[] =>
  [...new Set(ids)].filter((id) => !except.includes(id));

/**
 * BookingStatusChanged has no actor; cancellations name the cancelling side in `reason`
 * (`RENTER_…` / `OWNER_…`). Unknown reasons (system, moderation) notify both parties.
 */
const bookingCancelledBy = (reason: string): 'RENTER' | 'OWNER' | null => {
  const r = reason.toUpperCase();
  if (r.startsWith('RENTER')) return 'RENTER';
  if (r.startsWith('OWNER')) return 'OWNER';
  return null;
};

export const notificationRules: readonly NotificationRule[] = [
  rule(MatchingEvents.MatchFound, (p) => [
    {
      recipientId: p.sellerId,
      type: 'NEED_MATCHED',
      payload: { needId: p.needId, matchId: p.matchId },
    },
  ]),

  rule(OfferEvents.OfferSubmitted, (p) => [
    {
      recipientId: p.buyerId,
      type: 'OFFER_RECEIVED',
      payload: { offerId: p.offerId, needId: p.needId, price: p.price },
    },
  ]),

  rule(OfferEvents.OfferCountered, (p) => [
    {
      // The counter goes to whoever did not make it.
      recipientId: p.by === 'BUYER' ? p.sellerId : p.buyerId,
      type: 'OFFER_COUNTERED',
      payload: {
        offerId: p.offerId,
        needId: p.needId,
        by: p.by,
        round: p.round,
        price: p.price,
      },
    },
  ]),

  rule(OfferEvents.OfferAccepted, (p) => [
    {
      recipientId: p.sellerId,
      type: 'OFFER_ACCEPTED',
      payload: { offerId: p.offerId, needId: p.needId, price: p.price },
    },
  ]),

  rule(OfferEvents.OfferStatusChanged, (p) => {
    if (p.to === 'REJECTED') {
      return [
        {
          recipientId: p.sellerId,
          type: 'OFFER_REJECTED',
          payload: { offerId: p.offerId, needId: p.needId },
        },
      ];
    }
    // The need went away (closed, expired, fulfilled elsewhere): tell the seller their offer is moot.
    if (p.to === 'EXPIRED' && p.reason.startsWith('NEED_')) {
      return [
        {
          recipientId: p.sellerId,
          type: 'OFFER_CLOSED',
          payload: { offerId: p.offerId, needId: p.needId, reason: p.reason },
        },
      ];
    }
    return [];
  }),

  rule(TransactionEvents.TransactionCreated, (p) =>
    (['BUYER', 'SELLER'] as const).map((role) => ({
      recipientId: role === 'BUYER' ? p.buyerId : p.sellerId,
      type: 'TRANSACTION_CREATED' as const,
      payload: { transactionId: p.transactionId, amount: p.amount, mode: p.mode, role },
    })),
  ),

  // Every state change, including the RENT/BORROW HANDED_OVER → RETURN_REPORTED → RETURNED
  // sub-flow, goes to the other party (both when the system moved it).
  rule(TransactionEvents.TransactionStateChanged, (p) =>
    [p.buyerId, p.sellerId]
      .filter((id) => id !== p.actorId) // the actor already knows
      .map((recipientId) => ({
        recipientId,
        type: 'TRANSACTION_UPDATED' as const,
        payload: {
          transactionId: p.transactionId,
          from: p.from,
          to: p.to,
          ...(p.mode ? { mode: p.mode } : {}),
        },
      })),
  ),

  rule(DemandEvents.NeedStatusChanged, (p) => {
    if (p.to === 'EXPIRED') {
      return [{ recipientId: p.requesterId, type: 'NEED_EXPIRED', payload: { needId: p.needId } }];
    }
    if (p.to === 'FULFILLING') {
      return [
        { recipientId: p.requesterId, type: 'NEED_FULFILLING', payload: { needId: p.needId } },
      ];
    }
    return [];
  }),

  rule(ReputationEvents.ReviewCreated, (p) => [
    {
      recipientId: p.subjectId,
      type: 'REVIEW_RECEIVED',
      payload: { reviewId: p.reviewId, transactionId: p.transactionId, rating: p.rating },
    },
  ]),

  rule(VerificationEvents.VerificationStatusChanged, (p) =>
    p.kind === 'NID' && (p.status === 'VERIFIED' || p.status === 'REJECTED')
      ? [
          {
            recipientId: p.accountId,
            type: 'VERIFICATION_UPDATED',
            payload: { kind: p.kind, status: p.status },
          },
        ]
      : [],
  ),

  // ------------------------------------------------------------------ bidding

  rule(BiddingEvents.BidPlaced, (p) =>
    p.bidderId === p.ownerId
      ? []
      : [to(p.ownerId, 'BID_PLACED', { auctionId: p.auctionId, bidId: p.bidId, amount: p.amount })],
  ),

  rule(BiddingEvents.BidOutbid, (p) => [
    to(p.bidderId, 'BID_OUTBID', {
      auctionId: p.auctionId,
      bidId: p.bidId,
      leadingAmount: p.leadingAmount,
    }),
  ]),

  rule(BiddingEvents.AuctionClosed, (p) => {
    const owner = to(p.ownerId, 'AUCTION_CLOSED', {
      auctionId: p.auctionId,
      outcome: p.outcome,
      ...(p.outcome === 'AWARDED' && p.amount ? { amount: p.amount } : {}),
    });
    const bidders = distinct(p.bidderIds, [p.ownerId]);
    if (p.outcome === 'CANCELLED') {
      return [
        owner,
        ...bidders.map((id) => to(id, 'AUCTION_CANCELLED', { auctionId: p.auctionId })),
      ];
    }
    const winner = p.outcome === 'AWARDED' ? p.winnerId : null;
    return [
      owner,
      ...(winner && winner !== p.ownerId
        ? [
            to(winner, 'AUCTION_WON', {
              auctionId: p.auctionId,
              ...(p.amount ? { amount: p.amount } : {}),
            }),
          ]
        : []),
      ...distinct(bidders, [winner]).map((id) =>
        to(id, 'AUCTION_LOST', { auctionId: p.auctionId }),
      ),
    ];
  }),

  // ------------------------------------------------------------------ rental

  rule(RentalEvents.BookingStatusChanged, (p) => {
    const facts = { bookingId: p.bookingId, listingId: p.listingId };
    switch (p.to) {
      case 'PENDING_APPROVAL':
        return [to(p.ownerId, 'BOOKING_REQUESTED', facts)];
      case 'CONFIRMED':
        return [
          to(p.renterId, 'BOOKING_CONFIRMED', { ...facts, role: 'RENTER' }),
          to(p.ownerId, 'BOOKING_CONFIRMED', { ...facts, role: 'OWNER' }),
        ];
      case 'DECLINED':
        return [to(p.renterId, 'BOOKING_DECLINED', facts)];
      case 'EXPIRED':
        return [to(p.renterId, 'BOOKING_EXPIRED', facts)];
      case 'CANCELLED': {
        const by = bookingCancelledBy(p.reason);
        return [
          ...(by !== 'RENTER'
            ? [to(p.renterId, 'BOOKING_CANCELLED', { ...facts, role: 'RENTER' })]
            : []),
          ...(by !== 'OWNER'
            ? [to(p.ownerId, 'BOOKING_CANCELLED', { ...facts, role: 'OWNER' })]
            : []),
        ];
      }
      default:
        // HELD is the renter's own checkout; ACTIVE/RETURNED/CLOSED reach people through the
        // transaction's HANDED_OVER/RETURNED notifications.
        return [];
    }
  }),

  rule(RentalEvents.BookingOverdue, (p) => [
    to(p.renterId, 'BOOKING_OVERDUE', { bookingId: p.bookingId, role: 'RENTER' }),
    to(p.ownerId, 'BOOKING_OVERDUE', { bookingId: p.bookingId, role: 'OWNER' }),
  ]),

  // ------------------------------------------------------------------ lending

  rule(LendingEvents.LoanRequested, (p) => [
    to(p.lenderId, 'LOAN_REQUESTED', { loanId: p.loanId, itemId: p.itemId }),
  ]),

  rule(LendingEvents.LoanStatusChanged, (p) => {
    const facts = { loanId: p.loanId, itemId: p.itemId };
    switch (p.to) {
      case 'APPROVED':
        return [to(p.borrowerId, 'LOAN_APPROVED', facts)];
      case 'DECLINED':
        return [to(p.borrowerId, 'LOAN_DECLINED', facts)];
      case 'EXPIRED':
        return [to(p.borrowerId, 'LOAN_EXPIRED', facts)];
      default:
        return [];
    }
  }),

  rule(LendingEvents.LoanOverdue, (p) => [
    to(p.borrowerId, 'LOAN_OVERDUE', { loanId: p.loanId, role: 'BORROWER' }),
    to(p.lenderId, 'LOAN_OVERDUE', { loanId: p.loanId, role: 'LENDER' }),
  ]),

  // ------------------------------------------------------------------ disputes

  rule(DisputeEvents.DisputeOpened, (p) =>
    distinct([p.buyerId, p.sellerId]).map((id) =>
      to(id, 'DISPUTE_OPENED', {
        disputeId: p.disputeId,
        transactionId: p.transactionId,
        reason: p.reason,
        // The party who did not open it is asked to respond (an operator may open on behalf).
        role:
          p.openedBy === id
            ? 'OPENER'
            : p.openedBy === p.buyerId || p.openedBy === p.sellerId
              ? 'RESPONDENT'
              : 'PARTY',
      }),
    ),
  ),

  rule(DisputeEvents.DisputeStatusChanged, (p) =>
    // RESOLVED and WITHDRAWN have their own events (and wording); avoid telling people twice.
    p.to === 'RESOLVED' || p.to === 'WITHDRAWN' || p.from === p.to
      ? []
      : distinct([p.buyerId, p.sellerId]).map((id) =>
          to(id, 'DISPUTE_UPDATED', {
            disputeId: p.disputeId,
            transactionId: p.transactionId,
            from: p.from,
            to: p.to,
          }),
        ),
  ),

  rule(DisputeEvents.DisputeResolved, (p) =>
    distinct([p.buyerId, p.sellerId]).map((id) =>
      // `note` is free text: never copied.
      to(id, 'DISPUTE_RESOLVED', {
        disputeId: p.disputeId,
        transactionId: p.transactionId,
        resolution: p.resolution,
      }),
    ),
  ),

  rule(DisputeEvents.DisputeWithdrawn, (p) =>
    distinct([p.buyerId, p.sellerId]).map((id) =>
      to(id, 'DISPUTE_WITHDRAWN', { disputeId: p.disputeId, transactionId: p.transactionId }),
    ),
  ),

  // ------------------------------------------------------------------ messaging

  rule(MessagingEvents.MessageSent, (p) =>
    distinct(p.recipientIds, [p.senderId]).map((id) => ({
      ...to(id, 'NEW_MESSAGE', {
        conversationId: p.conversationId,
        contextType: p.contextType,
        contextId: p.contextId,
        messageId: p.messageId,
        count: 1,
      }),
      coalesceKey: p.conversationId,
    })),
  ),
];

/** Typed entry point (tests, replays): the intents an event produces. */
export function notificationsFor<S extends z.ZodType>(
  def: EventDefinition<S>,
  payload: z.input<S>,
): NotificationIntent[] {
  const r = notificationRules.find((x) => x.def.type === def.type);
  return r ? r.map(def.schema.parse(payload)) : [];
}
