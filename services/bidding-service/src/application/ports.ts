import type {
  AuctionKind,
  AuctionStatus,
  EventEnvelope,
  Money,
  NeedMode,
  NeedStatus,
} from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type {
  Auction,
  AuctionDraft,
  Bid,
  BidStatus,
  ListingSnapshot,
  NeedSnapshot,
  SubjectType,
} from '../domain/auction';

export type NewAuction = AuctionDraft & {
  id: string;
  ownerId: string;
  status: AuctionStatus;
};

export interface NewBid {
  id: string;
  auctionId: string;
  bidderId: string;
  amount: Money;
  idempotencyKey: string | null;
  placedAt: Date;
}

/** Fields a guarded auction update may change together with (or without) the status. */
export type AuctionChange = Partial<
  Pick<
    Auction,
    | 'leadingBidId'
    | 'leadingAmount'
    | 'bidCount'
    | 'endsAt'
    | 'cancelReason'
    | 'closedAt'
    | 'transactionId'
  >
>;

export interface StatusHistoryEntry {
  from: AuctionStatus | null;
  to: AuctionStatus;
  reason: string;
  actorId: string | null;
  at: Date;
}

export interface BrowseQuery {
  status: AuctionStatus;
  kind?: AuctionKind | undefined;
  categoryId?: string | undefined;
  district?: string | undefined;
  cursor: Cursor | null;
  /** Rows to fetch (page size + 1). */
  take: number;
}

export interface ListQuery {
  status?: AuctionStatus | undefined;
  cursor: Cursor | null;
  take: number;
}

export interface BidListQuery {
  status?: BidStatus | undefined;
  cursor: Cursor | null;
  take: number;
}

/** A bid with the auction facts the bidder's own list needs. */
export interface MyBid {
  bid: Bid;
  auction: Pick<
    Auction,
    'id' | 'kind' | 'title' | 'status' | 'endsAt' | 'leadingAmount' | 'hidden' | 'ownerId'
  >;
}

/** Storage bound to one executor (autocommit or a transaction). */
export interface AuctionStore {
  /**
   * DB clock (`clock_timestamp()`), so a request that waited on a row lock is judged at the time
   * it actually holds the lock, not when its transaction began.
   */
  now(): Promise<Date>;

  // projections
  listing(listingId: string): Promise<ListingSnapshot | null>;
  upsertListing(l: ListingSnapshot): Promise<void>;
  setListingUnavailable(listingId: string): Promise<boolean>;
  need(needId: string): Promise<NeedSnapshot | null>;
  upsertNeed(n: Omit<NeedSnapshot, 'status'>, status?: NeedStatus): Promise<void>;
  setNeedStatus(needId: string, status: NeedStatus): Promise<boolean>;

  // auctions
  get(auctionId: string, opts?: { forUpdate?: boolean }): Promise<Auction | null>;
  /** Throws CONFLICT (rule AUCTION_ALREADY_LIVE) when the subject already has a live auction. */
  insert(a: NewAuction): Promise<Auction>;
  /** Guarded update: applies only if status and version are unchanged. Null if the guard lost. */
  update(
    a: Pick<Auction, 'id' | 'status' | 'version'>,
    to: AuctionStatus,
    change: AuctionChange,
  ): Promise<Auction | null>;
  setHidden(auctionId: string, hidden: boolean): Promise<boolean>;
  recordStatus(
    auctionId: string,
    from: AuctionStatus | null,
    to: AuctionStatus,
    reason: string,
    actorId: string | null,
  ): Promise<void>;
  history(auctionId: string): Promise<StatusHistoryEntry[]>;
  /** Live auctions on a subject, row-locked. */
  liveForSubject(subjectType: SubjectType, subjectId: string): Promise<Auction[]>;
  /** Due for opening / closing (DB clock), locked with SKIP LOCKED so jobs never block bids. */
  dueToOpen(limit: number): Promise<Auction[]>;
  dueToClose(limit: number): Promise<Auction[]>;
  browse(q: BrowseQuery): Promise<Auction[]>;
  listForOwner(ownerId: string, q: ListQuery): Promise<Auction[]>;
  listAll(q: ListQuery): Promise<Auction[]>;

  // bids
  getBid(bidId: string, opts?: { forUpdate?: boolean }): Promise<Bid | null>;
  /** Alias for this bidder in this auction, assigned on first bid (call under the auction lock). */
  ensureBidder(auctionId: string, bidderId: string): Promise<number>;
  /** Inserts a LEADING bid. Returns null if (auction, bidder, idempotencyKey) already exists. */
  insertBid(b: NewBid): Promise<Bid | null>;
  bidByKey(auctionId: string, bidderId: string, key: string): Promise<Bid | null>;
  setBidStatus(bidId: string, from: BidStatus, to: BidStatus): Promise<boolean>;
  /** Mark every LEADING/OUTBID bid of an auction as `to` (except one). */
  settleBids(auctionId: string, to: BidStatus, exceptBidId?: string | null): Promise<number>;
  /** Best OUTBID bid (FORWARD: highest; REVERSE: lowest; ties: earliest). */
  bestRemaining(auctionId: string, kind: AuctionKind): Promise<Bid | null>;
  distinctBidders(auctionId: string): Promise<string[]>;
  latestBidOf(auctionId: string, bidderId: string): Promise<Bid | null>;
  listBids(auctionId: string, q: BidListQuery): Promise<Bid[]>;
  listBidsOf(bidderId: string, q: BidListQuery): Promise<MyBid[]>;

  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
}

export interface AuctionUnitOfWork {
  readonly store: AuctionStore;
  transaction<T>(fn: (store: AuctionStore) => Promise<T>): Promise<T>;
}

export interface VerificationDecision {
  satisfied: boolean;
  missing: string[];
}

/** Port to verification-service's policy engine. Implementations fail CLOSED (throw 503). */
export interface VerificationGateway {
  evaluate(
    q: {
      accountId: string;
      action: 'AUCTION_CREATE' | 'BID_PLACE';
      categoryId: string;
      mode: NeedMode;
      amount: number;
    },
    ctx: RequestContext,
  ): Promise<VerificationDecision>;
}
