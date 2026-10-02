import type {
  ActorType,
  BookingStatus,
  DisputeStatus,
  LoanStatus,
  NeedMode,
  NeedStatus,
  OfferStatus,
  TransactionSourceType,
  TransactionState,
} from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { ActivityEntry, ActivityFilter } from '../domain/activity';
import type { IsoDay } from '../domain/calendar';
import type { Increment, Metric } from '../domain/metrics';

// ---------------------------------------------------------------- activity log

export interface NewActivity {
  id: string;
  service: string;
  occurredAt: Date;
  actorId: string | null;
  actorType: ActorType;
  action: string;
  targetType: string | null;
  targetId: string | null;
  requestId: string | null;
  ipHash: string | null;
  metadata: Record<string, unknown>;
}

export interface Facets {
  services: Array<{ service: string; count: number }>;
  actions: Array<{ action: string; count: number }>;
}

export interface ActivityStore {
  /** Insert-if-absent by audit id; false when it was already recorded. */
  record(a: NewActivity): Promise<boolean>;
  setActorName(accountId: string, displayName: string, at: Date): Promise<void>;
  forgetActorName(accountId: string): Promise<void>;
  /** Keyset page ordered by (occurredAt desc, id desc); returns up to `limit` rows. */
  list(filter: ActivityFilter, cursor: Cursor | null, limit: number): Promise<ActivityEntry[]>;
  /** Staff (ADMIN) actions whose target is the account itself. */
  listAboutAccount(
    accountId: string,
    cursor: Cursor | null,
    limit: number,
  ): Promise<ActivityEntry[]>;
  get(id: string): Promise<ActivityEntry | null>;
  facets(since: Date, maxActions: number): Promise<Facets>;
  /** Deletes up to `batchSize` rows older than `days` (DB clock); returns the number deleted. */
  purgeBatch(days: number, batchSize: number): Promise<number>;
  audit(ctx: Pick<RequestContext, 'requestId' | 'ipHash' | 'actor'>, e: AuditEntry): Promise<void>;
}

export interface ActivityUnitOfWork {
  readonly store: ActivityStore;
  transaction<T>(fn: (store: ActivityStore) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------- projections (event writes)

/** A status event for a projection row: `at` is the event time, `from` its from-state (if any). */
export interface StatusEvent<S extends string> {
  status: S;
  at: Date;
  from: S | null;
}

export interface ProjectionStore {
  increment(day: IsoDay, incs: readonly Increment[]): Promise<void>;

  upsertNeed(
    r: { needId: string; requesterId: string; publishedDay?: IsoDay; firstOfferAt?: Date },
    s: StatusEvent<NeedStatus> | null,
  ): Promise<void>;
  upsertOffer(
    r: { offerId: string; needId: string; buyerId: string; sellerId: string },
    s: StatusEvent<OfferStatus>,
  ): Promise<void>;
  upsertListing(
    r: { listingId: string; sellerId: string },
    s: StatusEvent<'ACTIVE' | 'UNAVAILABLE'>,
  ): Promise<void>;
  upsertTransaction(
    r: {
      transactionId: string;
      buyerId: string;
      sellerId: string;
      sourceType: TransactionSourceType;
      mode?: NeedMode | undefined;
      amount?: number;
    },
    s: StatusEvent<TransactionState>,
  ): Promise<void>;
  /** Sets completed_at the first time; true if this call did. */
  markCompleted(transactionId: string, at: Date): Promise<boolean>;
  /** Claims the GMV of a completed deal with a known amount, once. */
  claimGmv(transactionId: string): Promise<{ amount: number; completedAt: Date } | null>;
  upsertDispute(
    r: { disputeId: string; transactionId: string; buyerId: string; sellerId: string },
    s: StatusEvent<DisputeStatus>,
  ): Promise<void>;
  upsertVerification(
    r: { accountId: string; kind: string },
    s: StatusEvent<'PENDING' | 'VERIFIED' | 'REJECTED' | 'REVOKED' | 'EXPIRED'>,
  ): Promise<void>;
  upsertAuction(
    r: { auctionId: string; ownerId: string; endsAt?: Date },
    s: StatusEvent<'OPEN' | 'AWARDED' | 'NO_WINNER' | 'CANCELLED'>,
  ): Promise<void>;
  addBidders(auctionId: string, bidderIds: readonly string[]): Promise<void>;
  upsertBooking(
    r: {
      bookingId: string;
      listingId: string;
      ownerId: string;
      renterId: string;
      startAt?: Date;
      endAt?: Date;
    },
    s: StatusEvent<BookingStatus>,
  ): Promise<void>;
  upsertLoan(
    r: { loanId: string; itemId: string; lenderId: string; borrowerId: string; returnBy?: Date },
    s: StatusEvent<LoanStatus>,
  ): Promise<void>;
  setReputation(
    accountId: string,
    r: { ratingAverage: number | null; ratingCount: number; completedCount: number },
    at: Date,
  ): Promise<void>;
}

// ---------------------------------------------------------------- reads

export interface Money {
  amount: number;
  currency: 'BDT';
}

export interface Gauges {
  needsByStatus: Record<string, number>;
  activeListings: number;
  transactionsByState: Array<{ state: string; count: number; amount: Money }>;
  openDisputes: number;
  pendingVerifications: number;
  liveAuctions: number;
  upcomingBookings: number;
  activeBookings: number;
  activeLoans: number;
}

export interface Funnel {
  needsPublished: number;
  needsWithOffer: number;
  offersAccepted: number;
  transactionsCompleted: number;
}

export interface PersonalCounts {
  openNeeds: number;
  offersAwaitingResponse: number;
  buyerTransactions: Record<string, number>;
  totalSpent: number;
  offersSentByStatus: Record<string, number>;
  sellerTransactions: Record<string, number>;
  earnings: number;
  rating: { average: number | null; count: number; completedCount: number } | null;
  auctions: {
    owned: number;
    bidding: number;
    live: Array<{ auctionId: string; role: 'OWNER' | 'BIDDER'; endsAt: Date | null }>;
  };
  bookings: {
    asRenter: number;
    asOwner: number;
    items: Array<{
      bookingId: string;
      listingId: string;
      role: 'OWNER' | 'RENTER';
      status: string;
      startAt: Date | null;
      endAt: Date | null;
    }>;
  };
  loans: {
    asLender: number;
    asBorrower: number;
    items: Array<{
      loanId: string;
      itemId: string;
      role: 'LENDER' | 'BORROWER';
      status: string;
      returnBy: Date | null;
    }>;
  };
  disputes: {
    open: number;
    items: Array<{
      disputeId: string;
      transactionId: string;
      role: 'BUYER' | 'SELLER';
      status: string;
    }>;
  };
}

export interface DashboardReader {
  gauges(): Promise<Gauges>;
  /** Sum per metric (dimension '') over the inclusive day range. */
  totals(from: IsoDay, to: IsoDay): Promise<Partial<Record<Metric, number>>>;
  daily(
    metric: Metric,
    dimension: string,
    from: IsoDay,
    to: IsoDay,
  ): Promise<Array<{ day: IsoDay; value: number }>>;
  funnel(from: IsoDay, to: IsoDay): Promise<Funnel>;
  personal(accountId: string, listLimit: number): Promise<PersonalCounts>;
}

export interface SummaryCache<T> {
  get(): Promise<T | null>;
  set(value: T, ttlSeconds: number): Promise<void>;
}
