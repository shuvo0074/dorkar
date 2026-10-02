import type { EventEnvelope, NeedMode, NeedStatus, OfferStatus } from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { ListingSnapshot, NeedSnapshot, Offer, OfferRound, Party } from '../domain/offer';

export interface NeedFacts {
  needId: string;
  requesterId: string;
  mode: NeedMode;
  categoryId: string;
  title: string;
  quantity: number;
  maxOffers: number;
  expiresAt: Date;
}

export type NewOffer = Omit<Offer, 'createdAt' | 'updatedAt' | 'version' | 'hidden'>;

/** Fields a status change may rewrite together with the status (a counter updates the terms). */
export type OfferChange = Partial<
  Pick<
    Offer,
    | 'awaiting'
    | 'price'
    | 'quantity'
    | 'deliveryTerms'
    | 'modeTerms'
    | 'condition'
    | 'availabilityFrom'
    | 'currentRound'
  >
>;

export interface StatusHistoryEntry {
  from: OfferStatus | null;
  to: OfferStatus;
  reason: string;
  actorId: string | null;
  at: Date;
}

export type OfferSort = 'price_asc' | 'newest';

export interface OfferListQuery {
  status?: OfferStatus | undefined;
  cursor: Cursor | null;
  /** Rows to fetch (page size + 1). */
  take: number;
}

/** Storage bound to one executor (autocommit or a transaction). */
export interface OfferStore {
  /** DB clock: deadlines are compared against Postgres time, not the app server's. */
  now(): Promise<Date>;

  // need / listing projections
  need(needId: string): Promise<NeedSnapshot | null>;
  /** `SELECT … FOR UPDATE`: serializes submissions and acceptances on one need. */
  lockNeed(needId: string): Promise<NeedSnapshot | null>;
  upsertNeedFacts(f: NeedFacts, status?: NeedStatus): Promise<void>;
  setNeedStatus(needId: string, status: NeedStatus): Promise<boolean>;
  addAcceptedQuantity(needId: string, delta: number): Promise<void>;
  listing(listingId: string): Promise<ListingSnapshot | null>;
  upsertListing(l: ListingSnapshot): Promise<void>;

  // offers
  get(offerId: string, opts?: { forUpdate?: boolean }): Promise<Offer | null>;
  insert(offer: NewOffer, round: Omit<OfferRound, 'createdAt'>): Promise<Offer>;
  countActiveOnNeed(needId: string): Promise<number>;
  hasLiveOffer(needId: string, sellerId: string): Promise<boolean>;
  /** Guarded update: applies only if status and version are unchanged. Null if the guard lost. */
  transition(
    offer: Pick<Offer, 'id' | 'status' | 'version'>,
    to: OfferStatus,
    change: OfferChange,
  ): Promise<Offer | null>;
  addRound(round: Omit<OfferRound, 'createdAt'>): Promise<void>;
  rounds(offerId: string): Promise<OfferRound[]>;
  latestRound(offerId: string): Promise<OfferRound>;
  recordStatus(
    offerId: string,
    from: OfferStatus | null,
    to: OfferStatus,
    reason: string,
    actorId: string | null,
  ): Promise<void>;
  history(offerId: string): Promise<StatusHistoryEntry[]>;
  /** Live offers on a need, row-locked (excluding one id). */
  liveOnNeed(needId: string, exceptId?: string): Promise<Offer[]>;
  /** Live offers past expires_at, locked with SKIP LOCKED so sweeps never block requests. */
  dueForExpiry(limit: number): Promise<Offer[]>;
  setHidden(offerId: string, hidden: boolean): Promise<boolean>;
  listForNeed(needId: string, sort: OfferSort, q: OfferListQuery): Promise<Offer[]>;
  listForSeller(sellerId: string, q: OfferListQuery): Promise<Offer[]>;

  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
}

export interface OfferUnitOfWork {
  readonly store: OfferStore;
  transaction<T>(fn: (store: OfferStore) => Promise<T>): Promise<T>;
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
      action: 'OFFER_SUBMIT';
      categoryId: string;
      mode: NeedMode;
      amount: number;
    },
    ctx: RequestContext,
  ): Promise<VerificationDecision>;
}

/** Port to profile-service public cards. Implementations fail OPEN (return an empty map). */
export interface ProfileDirectory {
  displayNames(ids: readonly string[], ctx: RequestContext): Promise<Map<string, string>>;
}

export type { Party };
