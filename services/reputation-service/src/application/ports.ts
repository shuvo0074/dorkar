import type { EventEnvelope, NeedMode, TransactionState } from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { AuthorRole, Review, ReviewStatus, TransactionView } from '../domain/review';
import type { AccountStats, RatingInput, ReputationSignals } from '../domain/signals';

export interface NewReview {
  id: string;
  transactionId: string;
  authorId: string;
  subjectId: string;
  authorRole: AuthorRole;
  rating: number;
  comment: string | null;
}

export interface TransactionCreatedFact {
  id: string;
  buyerId: string;
  sellerId: string;
  mode: NeedMode;
  amount: number;
  currency: string;
  at: Date;
}

export interface TransactionStateFact {
  id: string;
  buyerId: string;
  sellerId: string;
  to: TransactionState;
  actorId: string | null;
  at: Date;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface ReputationStore {
  // ---- transaction projection
  recordTransactionCreated(f: TransactionCreatedFact): Promise<void>;
  recordStateChange(f: TransactionStateFact): Promise<void>;
  /** The transaction plus the database clock (deadlines compare against DB time). */
  transaction(id: string): Promise<{ tx: TransactionView | null; now: Date }>;

  // ---- reviews
  /** Returns null when this author already reviewed this transaction (race-safe). */
  insertReview(r: NewReview): Promise<Review | null>;
  reviewsForTransaction(transactionId: string): Promise<Review[]>;
  /** VISIBLE reviews about `subjectId`, newest first. Fetches `limit + 1`. */
  visibleReviewsAbout(subjectId: string, cursor: Cursor | null, limit: number): Promise<Review[]>;
  reviews(status: ReviewStatus | null, cursor: Cursor | null, limit: number): Promise<Review[]>;
  /** Sets status; returns the review (null when unknown). */
  setReviewStatus(id: string, status: ReviewStatus): Promise<Review | null>;

  // ---- signals
  /** Serializes recomputation per account until the transaction ends. Pass ids sorted. */
  lockAccounts(accountIds: readonly string[]): Promise<void>;
  /** Aggregates counters from the transaction projection. */
  computeStats(accountId: string): Promise<AccountStats>;
  saveStats(stats: AccountStats): Promise<void>;
  /** VISIBLE reviews about the subject, at most `pairCap` most recent per author. */
  ratingInputs(subjectId: string, pairCap: number): Promise<RatingInput[]>;
  saveSignals(accountId: string, signals: ReputationSignals): Promise<void>;
  signals(accountId: string): Promise<ReputationSignals>;

  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(
    ctx: Pick<RequestContext, 'requestId' | 'ipHash' | 'actor'>,
    entry: AuditEntry,
  ): Promise<void>;
}

export interface ReputationUnitOfWork {
  readonly store: ReputationStore;
  transaction<T>(fn: (store: ReputationStore) => Promise<T>): Promise<T>;
}
