import type {
  BiddingEvents,
  CatalogEvents,
  DemandEvents,
  DisputeEvents,
  EventEnvelope,
  IdentityEvents,
  LendingEvents,
  MessagingEvents,
  OfferEvents,
  RentalEvents,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
} from '@dorkar/contracts';
import type { z } from 'zod';
import { dhakaDay } from '../domain/calendar';
import { count } from '../domain/metrics';
import type { ProjectionStore } from './ports';

type P<D extends { schema: z.ZodType }> = z.output<D['schema']>;
type Env = Pick<EventEnvelope, 'occurredAt'>;

/**
 * Domain events → daily counters and small state projections. Every handler runs inside the
 * inbox transaction, so each event counts exactly once; projections are guarded by event time
 * and from-state so out-of-order deliveries cannot move an aggregate backwards.
 */
export class Projector {
  // ---------------------------------------------------------------- identity
  async onAccountCreated(s: ProjectionStore, _p: P<typeof IdentityEvents.AccountCreated>, e: Env) {
    await s.increment(dhakaDay(e.occurredAt), count('signups'));
  }

  async onUserLoggedIn(s: ProjectionStore, _p: P<typeof IdentityEvents.UserLoggedIn>, e: Env) {
    await s.increment(dhakaDay(e.occurredAt), count('logins'));
  }

  // ---------------------------------------------------------------- verification
  async onVerificationStatusChanged(
    s: ProjectionStore,
    p: P<typeof VerificationEvents.VerificationStatusChanged>,
    e: Env,
  ) {
    const at = new Date(e.occurredAt);
    await s.upsertVerification(
      { accountId: p.accountId, kind: p.kind },
      { status: p.status, at, from: null },
    );
    await s.increment(dhakaDay(at), count('verifications', [`${p.kind}:${p.status}`]));
  }

  // ---------------------------------------------------------------- demand / catalog
  async onNeedStatusChanged(
    s: ProjectionStore,
    p: P<typeof DemandEvents.NeedStatusChanged>,
    e: Env,
  ) {
    const at = new Date(e.occurredAt);
    const day = dhakaDay(at);
    const firstPublish = p.from === 'DRAFT' && p.to === 'OPEN';
    await s.upsertNeed(
      {
        needId: p.needId,
        requesterId: p.requesterId,
        ...(firstPublish ? { publishedDay: day } : {}),
      },
      { status: p.to, at, from: p.from },
    );
    if (firstPublish) await s.increment(day, count('needs_published'));
  }

  async onListingPublished(
    s: ProjectionStore,
    p: P<typeof CatalogEvents.ListingPublished>,
    e: Env,
  ) {
    const at = new Date(e.occurredAt);
    await s.upsertListing(
      { listingId: p.listingId, sellerId: p.sellerId },
      { status: 'ACTIVE', at, from: null },
    );
    await s.increment(dhakaDay(at), count('listings_published'));
  }

  async onListingUnavailable(
    s: ProjectionStore,
    p: P<typeof CatalogEvents.ListingUnavailable>,
    e: Env,
  ) {
    await s.upsertListing(
      { listingId: p.listingId, sellerId: p.sellerId },
      { status: 'UNAVAILABLE', at: new Date(e.occurredAt), from: null },
    );
  }

  // ---------------------------------------------------------------- offers
  async onOfferSubmitted(s: ProjectionStore, p: P<typeof OfferEvents.OfferSubmitted>, e: Env) {
    const at = new Date(e.occurredAt);
    await s.upsertOffer(
      { offerId: p.offerId, needId: p.needId, buyerId: p.buyerId, sellerId: p.sellerId },
      { status: 'SUBMITTED', at, from: null },
    );
    // The need's requester is the offer's buyer; the stub is completed by NeedStatusChanged.
    await s.upsertNeed({ needId: p.needId, requesterId: p.buyerId, firstOfferAt: at }, null);
    await s.increment(dhakaDay(at), count('offers_submitted'));
  }

  async onOfferCountered(s: ProjectionStore, p: P<typeof OfferEvents.OfferCountered>, e: Env) {
    await s.upsertOffer(
      { offerId: p.offerId, needId: p.needId, buyerId: p.buyerId, sellerId: p.sellerId },
      {
        status: p.by === 'BUYER' ? 'COUNTERED_BY_BUYER' : 'COUNTERED_BY_SELLER',
        at: new Date(e.occurredAt),
        from: null,
      },
    );
  }

  async onOfferAccepted(s: ProjectionStore, p: P<typeof OfferEvents.OfferAccepted>, e: Env) {
    const at = new Date(e.occurredAt);
    await s.upsertOffer(
      { offerId: p.offerId, needId: p.needId, buyerId: p.buyerId, sellerId: p.sellerId },
      { status: 'ACCEPTED', at, from: null },
    );
    await s.increment(dhakaDay(at), count('offers_accepted'));
  }

  async onOfferStatusChanged(
    s: ProjectionStore,
    p: P<typeof OfferEvents.OfferStatusChanged>,
    e: Env,
  ) {
    await s.upsertOffer(
      { offerId: p.offerId, needId: p.needId, buyerId: p.buyerId, sellerId: p.sellerId },
      { status: p.to, at: new Date(e.occurredAt), from: p.from },
    );
  }

  // ---------------------------------------------------------------- transactions
  async onTransactionCreated(
    s: ProjectionStore,
    p: P<typeof TransactionEvents.TransactionCreated>,
    e: Env,
  ) {
    const at = new Date(e.occurredAt);
    await s.upsertTransaction(
      {
        transactionId: p.transactionId,
        buyerId: p.buyerId,
        sellerId: p.sellerId,
        sourceType: p.sourceType,
        mode: p.mode,
        amount: p.amount.amount,
      },
      { status: 'CREATED', at, from: null },
    );
    await s.increment(
      dhakaDay(at),
      count('transactions_created', [`mode:${p.mode}`, `source:${p.sourceType}`]),
    );
    // A completion that arrived before this event could not know the amount.
    await this.claimGmv(s, p.transactionId);
  }

  async onTransactionStateChanged(
    s: ProjectionStore,
    p: P<typeof TransactionEvents.TransactionStateChanged>,
    e: Env,
  ) {
    const at = new Date(e.occurredAt);
    const day = dhakaDay(at);
    await s.upsertTransaction(
      {
        transactionId: p.transactionId,
        buyerId: p.buyerId,
        sellerId: p.sellerId,
        sourceType: p.sourceType,
        mode: p.mode,
      },
      { status: p.to, at, from: p.from },
    );
    if (p.to === 'COMPLETED' && (await s.markCompleted(p.transactionId, at))) {
      // Counted once per deal, even if it is later disputed and completed again.
      await s.increment(day, count('transactions_completed'));
      await this.claimGmv(s, p.transactionId);
    }
    if (p.to === 'CANCELLED') await s.increment(day, count('transactions_cancelled'));
  }

  private async claimGmv(s: ProjectionStore, transactionId: string) {
    const gmv = await s.claimGmv(transactionId);
    if (gmv && gmv.amount > 0) {
      await s.increment(dhakaDay(gmv.completedAt), count('gmv_completed', [], gmv.amount));
    }
  }

  // ---------------------------------------------------------------- disputes
  async onDisputeOpened(s: ProjectionStore, p: P<typeof DisputeEvents.DisputeOpened>, e: Env) {
    const at = new Date(e.occurredAt);
    await s.upsertDispute(disputeFacts(p), { status: 'OPEN', at, from: null });
    await s.increment(dhakaDay(at), count('disputes_opened'));
  }

  async onDisputeStatusChanged(
    s: ProjectionStore,
    p: P<typeof DisputeEvents.DisputeStatusChanged>,
    e: Env,
  ) {
    await s.upsertDispute(disputeFacts(p), {
      status: p.to,
      at: new Date(e.occurredAt),
      from: p.from,
    });
  }

  async onDisputeResolved(s: ProjectionStore, p: P<typeof DisputeEvents.DisputeResolved>, e: Env) {
    const at = new Date(e.occurredAt);
    await s.upsertDispute(disputeFacts(p), { status: 'RESOLVED', at, from: null });
    await s.increment(dhakaDay(at), count('disputes_resolved', [`resolution:${p.resolution}`]));
  }

  async onDisputeWithdrawn(
    s: ProjectionStore,
    p: P<typeof DisputeEvents.DisputeWithdrawn>,
    e: Env,
  ) {
    await s.upsertDispute(disputeFacts(p), {
      status: 'WITHDRAWN',
      at: new Date(e.occurredAt),
      from: null,
    });
  }

  // ---------------------------------------------------------------- reputation
  async onReviewCreated(s: ProjectionStore, _p: P<typeof ReputationEvents.ReviewCreated>, e: Env) {
    await s.increment(dhakaDay(e.occurredAt), count('reviews_created'));
  }

  async onReputationUpdated(
    s: ProjectionStore,
    p: P<typeof ReputationEvents.ReputationUpdated>,
    e: Env,
  ) {
    await s.setReputation(
      p.accountId,
      {
        ratingAverage: p.ratingAverage,
        ratingCount: p.ratingCount,
        completedCount: p.completedCount,
      },
      new Date(e.occurredAt),
    );
  }

  // ---------------------------------------------------------------- bidding
  async onAuctionOpened(s: ProjectionStore, p: P<typeof BiddingEvents.AuctionOpened>, e: Env) {
    const at = new Date(e.occurredAt);
    await s.upsertAuction(
      { auctionId: p.auctionId, ownerId: p.ownerId, endsAt: new Date(p.endsAt) },
      { status: 'OPEN', at, from: null },
    );
    await s.increment(dhakaDay(at), count('auctions_opened'));
  }

  async onBidPlaced(s: ProjectionStore, p: P<typeof BiddingEvents.BidPlaced>, e: Env) {
    const at = new Date(e.occurredAt);
    // A bid proves the auction is open; a later close (newer event time) still wins.
    await s.upsertAuction(
      { auctionId: p.auctionId, ownerId: p.ownerId, endsAt: new Date(p.endsAt) },
      { status: 'OPEN', at, from: null },
    );
    await s.addBidders(p.auctionId, [p.bidderId]);
    await s.increment(dhakaDay(at), count('bids_placed'));
  }

  async onAuctionClosed(s: ProjectionStore, p: P<typeof BiddingEvents.AuctionClosed>, e: Env) {
    await s.upsertAuction(
      { auctionId: p.auctionId, ownerId: p.ownerId },
      { status: p.outcome, at: new Date(e.occurredAt), from: 'OPEN' },
    );
    await s.addBidders(p.auctionId, p.bidderIds);
  }

  async onAuctionAwarded(s: ProjectionStore, _p: P<typeof BiddingEvents.AuctionAwarded>, e: Env) {
    await s.increment(dhakaDay(e.occurredAt), count('auctions_awarded'));
  }

  // ---------------------------------------------------------------- rental
  async onBookingConfirmed(s: ProjectionStore, p: P<typeof RentalEvents.BookingConfirmed>, e: Env) {
    const at = new Date(e.occurredAt);
    await s.upsertBooking(
      { ...bookingFacts(p), startAt: new Date(p.startAt), endAt: new Date(p.endAt) },
      { status: 'CONFIRMED', at, from: null },
    );
    await s.increment(dhakaDay(at), count('bookings_confirmed'));
  }

  async onBookingStatusChanged(
    s: ProjectionStore,
    p: P<typeof RentalEvents.BookingStatusChanged>,
    e: Env,
  ) {
    await s.upsertBooking(bookingFacts(p), {
      status: p.to,
      at: new Date(e.occurredAt),
      from: p.from,
    });
  }

  // ---------------------------------------------------------------- lending
  async onLoanRequested(s: ProjectionStore, p: P<typeof LendingEvents.LoanRequested>, e: Env) {
    await s.upsertLoan(
      { ...loanFacts(p), returnBy: new Date(p.returnBy) },
      { status: 'REQUESTED', at: new Date(e.occurredAt), from: null },
    );
  }

  async onLoanApproved(s: ProjectionStore, p: P<typeof LendingEvents.LoanApproved>, e: Env) {
    const at = new Date(e.occurredAt);
    await s.upsertLoan(
      { ...loanFacts(p), returnBy: new Date(p.returnBy) },
      { status: 'APPROVED', at, from: 'REQUESTED' },
    );
    await s.increment(dhakaDay(at), count('loans_approved'));
  }

  async onLoanStatusChanged(
    s: ProjectionStore,
    p: P<typeof LendingEvents.LoanStatusChanged>,
    e: Env,
  ) {
    await s.upsertLoan(loanFacts(p), { status: p.to, at: new Date(e.occurredAt), from: p.from });
  }

  // ---------------------------------------------------------------- messaging
  async onMessageSent(s: ProjectionStore, _p: P<typeof MessagingEvents.MessageSent>, e: Env) {
    await s.increment(dhakaDay(e.occurredAt), count('messages_sent'));
  }
}

const disputeFacts = (p: {
  disputeId: string;
  transactionId: string;
  buyerId: string;
  sellerId: string;
}) => ({
  disputeId: p.disputeId,
  transactionId: p.transactionId,
  buyerId: p.buyerId,
  sellerId: p.sellerId,
});

const bookingFacts = (p: {
  bookingId: string;
  listingId: string;
  ownerId: string;
  renterId: string;
}) => ({
  bookingId: p.bookingId,
  listingId: p.listingId,
  ownerId: p.ownerId,
  renterId: p.renterId,
});

const loanFacts = (p: {
  loanId: string;
  itemId: string;
  lenderId: string;
  borrowerId: string;
}) => ({
  loanId: p.loanId,
  itemId: p.itemId,
  lenderId: p.lenderId,
  borrowerId: p.borrowerId,
});
