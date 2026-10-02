import { z } from 'zod';
import { DistrictSchema } from './locations';
import { MoneySchema, NeedModes } from './marketplace';
import { DisputeReasons, TransactionStates } from './marketplace-events';

/**
 * Phase 2 integration events: bidding, rental, lending, disputes, messaging.
 * Same rules as marketplace-events.ts: IDs and facts only, never PII or message bodies;
 * adding optional fields is compatible, anything else is a new `version`.
 *
 * Deals converge on the transaction service (03-lifecycles §4): an awarded auction, a confirmed
 * booking and an approved loan each create exactly one transaction, which then owns the
 * hand-over/return/completion lifecycle, payment, delivery and disputes. Reviews, notifications
 * and dashboards therefore work the same for every kind of deal.
 */

const id = z.uuid();
const ts = z.iso.datetime();

// ---------------------------------------------------------------- bidding

export const AuctionKinds = ['FORWARD', 'REVERSE'] as const;
export type AuctionKind = (typeof AuctionKinds)[number];
/** FORWARD auctions sell a LISTING (bids go up); REVERSE auctions source a NEED (bids go down). */
export const AuctionSubjects = ['LISTING', 'NEED'] as const;
export const AuctionStatuses = [
  'SCHEDULED',
  'OPEN',
  'CLOSING',
  'AWARDED',
  'SETTLED',
  'NO_WINNER',
  'CANCELLED',
] as const;
export type AuctionStatus = (typeof AuctionStatuses)[number];
export const BidStatuses = ['LEADING', 'OUTBID', 'RETRACTED', 'WON', 'LOST'] as const;

const auctionFacts = {
  auctionId: id,
  kind: z.enum(AuctionKinds),
  ownerId: id,
  subjectType: z.enum(AuctionSubjects),
  subjectId: id,
  categoryId: id,
};

export const BiddingEvents = {
  AuctionOpened: {
    type: 'bidding.AuctionOpened',
    version: 1,
    schema: z.object({
      ...auctionFacts,
      title: z.string(),
      district: DistrictSchema,
      startPrice: MoneySchema,
      startsAt: ts,
      endsAt: ts,
    }),
  },
  BidPlaced: {
    type: 'bidding.BidPlaced',
    version: 1,
    schema: z.object({
      auctionId: id,
      bidId: id,
      bidderId: id,
      ownerId: id,
      amount: MoneySchema,
      /** After any anti-sniping extension. */
      endsAt: ts,
    }),
  },
  BidOutbid: {
    type: 'bidding.BidOutbid',
    version: 1,
    schema: z.object({
      auctionId: id,
      bidId: id,
      bidderId: id,
      leadingAmount: MoneySchema,
    }),
  },
  AuctionClosed: {
    type: 'bidding.AuctionClosed',
    version: 1,
    schema: z.object({
      ...auctionFacts,
      outcome: z.enum(['AWARDED', 'NO_WINNER', 'CANCELLED']),
      winnerId: id.nullable(),
      winningBidId: id.nullable(),
      amount: MoneySchema.nullable(),
      bidderIds: z.array(id),
    }),
  },
  /** Creates the deal: transaction-service consumes it (sourceType AUCTION, sourceId auctionId). */
  AuctionAwarded: {
    type: 'bidding.AuctionAwarded',
    version: 1,
    schema: z.object({
      auctionId: id,
      winningBidId: id,
      kind: z.enum(AuctionKinds),
      needId: id.nullable(),
      listingId: id.nullable(),
      buyerId: id,
      sellerId: id,
      mode: z.enum(NeedModes),
      amount: MoneySchema,
      quantity: z.number().int().min(1),
      terms: z.record(z.string(), z.unknown()),
    }),
  },
} as const;

// ---------------------------------------------------------------- rental

export const BookingStatuses = [
  'HELD',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'ACTIVE',
  'RETURNED',
  'CLOSED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type BookingStatus = (typeof BookingStatuses)[number];

const bookingFacts = {
  bookingId: id,
  listingId: id,
  ownerId: id,
  renterId: id,
};

export const RentalEvents = {
  /** Creates the deal: transaction-service consumes it (mode RENT, sourceType BOOKING). */
  BookingConfirmed: {
    type: 'rental.BookingConfirmed',
    version: 1,
    schema: z.object({
      ...bookingFacts,
      startAt: ts,
      endAt: ts,
      /** Total rent for the period. */
      amount: MoneySchema,
      deposit: MoneySchema.nullable(),
      terms: z.record(z.string(), z.unknown()),
    }),
  },
  BookingStatusChanged: {
    type: 'rental.BookingStatusChanged',
    version: 1,
    schema: z.object({
      ...bookingFacts,
      from: z.enum(BookingStatuses),
      to: z.enum(BookingStatuses),
      transactionId: id.nullable(),
      reason: z.string(),
    }),
  },
  /** End of the booking passed and the item is not back. Emitted once per booking. */
  BookingOverdue: {
    type: 'rental.BookingOverdue',
    version: 1,
    schema: z.object({ ...bookingFacts, transactionId: id.nullable(), endAt: ts }),
  },
} as const;

// ---------------------------------------------------------------- lending

export const LoanStatuses = [
  'REQUESTED',
  'APPROVED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
  'LENT',
  'RETURN_REPORTED',
  'RETURNED',
  'DISPUTED',
  'CLOSED',
] as const;
export type LoanStatus = (typeof LoanStatuses)[number];

const loanFacts = { loanId: id, itemId: id, lenderId: id, borrowerId: id };

export const LendingEvents = {
  LendItemPublished: {
    type: 'lending.LendItemPublished',
    version: 1,
    schema: z.object({
      itemId: id,
      lenderId: id,
      categoryId: id,
      title: z.string(),
      district: DistrictSchema,
      active: z.boolean(),
    }),
  },
  LoanRequested: {
    type: 'lending.LoanRequested',
    version: 1,
    schema: z.object({ ...loanFacts, startAt: ts, returnBy: ts }),
  },
  /** Creates the deal: transaction-service consumes it (mode BORROW, amount 0, sourceType LOAN). */
  LoanApproved: {
    type: 'lending.LoanApproved',
    version: 1,
    schema: z.object({
      ...loanFacts,
      startAt: ts,
      returnBy: ts,
      deposit: MoneySchema.nullable(),
      terms: z.record(z.string(), z.unknown()),
    }),
  },
  LoanStatusChanged: {
    type: 'lending.LoanStatusChanged',
    version: 1,
    schema: z.object({
      ...loanFacts,
      from: z.enum(LoanStatuses),
      to: z.enum(LoanStatuses),
      transactionId: id.nullable(),
      reason: z.string(),
    }),
  },
  LoanOverdue: {
    type: 'lending.LoanOverdue',
    version: 1,
    schema: z.object({ ...loanFacts, transactionId: id.nullable(), returnBy: ts }),
  },
} as const;

// ---------------------------------------------------------------- dispute

export const DisputeStatuses = [
  'OPEN',
  'AWAITING_RESPONSE',
  'UNDER_REVIEW',
  'RESOLVED',
  'WITHDRAWN',
] as const;
export type DisputeStatus = (typeof DisputeStatuses)[number];
/** RELEASE completes the deal, CANCEL cancels it, REFUND refunds (non-cash providers only). */
export const DisputeResolutions = ['RELEASE', 'CANCEL', 'REFUND'] as const;
export type DisputeResolution = (typeof DisputeResolutions)[number];

const disputeFacts = {
  disputeId: id,
  transactionId: id,
  buyerId: id,
  sellerId: id,
};

export const DisputeEvents = {
  DisputeOpened: {
    type: 'dispute.DisputeOpened',
    version: 1,
    schema: z.object({
      ...disputeFacts,
      openedBy: id,
      reason: z.enum(DisputeReasons),
      /** Transaction state before it became DISPUTED (restored if the dispute is withdrawn). */
      previousState: z.enum(TransactionStates),
    }),
  },
  DisputeStatusChanged: {
    type: 'dispute.DisputeStatusChanged',
    version: 1,
    schema: z.object({
      ...disputeFacts,
      from: z.enum(DisputeStatuses),
      to: z.enum(DisputeStatuses),
      actorId: id.nullable(),
    }),
  },
  /** Command to transaction-service: apply the resolution transition. */
  DisputeResolved: {
    type: 'dispute.DisputeResolved',
    version: 1,
    schema: z.object({
      ...disputeFacts,
      resolution: z.enum(DisputeResolutions),
      resolvedBy: id,
      note: z.string(),
    }),
  },
  /** Command to transaction-service: leave DISPUTED, back to `previousState`. */
  DisputeWithdrawn: {
    type: 'dispute.DisputeWithdrawn',
    version: 1,
    schema: z.object({
      ...disputeFacts,
      withdrawnBy: id,
      previousState: z.enum(TransactionStates),
    }),
  },
} as const;

// ---------------------------------------------------------------- messaging

/** A conversation is always about something; participants are derived from that context. */
export const ConversationContexts = ['LISTING', 'OFFER', 'TRANSACTION', 'LEND_ITEM'] as const;
export type ConversationContext = (typeof ConversationContexts)[number];

export const MessagingEvents = {
  /** No body: the text stays in messaging. Recipients get a notification. */
  MessageSent: {
    type: 'messaging.MessageSent',
    version: 1,
    schema: z.object({
      messageId: id,
      conversationId: id,
      contextType: z.enum(ConversationContexts),
      contextId: id,
      senderId: id,
      recipientIds: z.array(id),
    }),
  },
} as const;
