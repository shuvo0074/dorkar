import type { Condition, District, EventEnvelope, LoanStatus, NeedMode } from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { CategoryFacts, LenderStats, LendItem, Requirements } from '../domain/lend-item';
import type { ActorRole, BorrowerFacts, Loan, LoanTransition } from '../domain/loan';

// ---------------------------------------------------------------- outbound

export interface VerificationDecision {
  satisfied: boolean;
  missing: string[];
}

/** verification-service policy engine (fails closed). */
export interface VerificationGateway {
  evaluate(
    q: {
      accountId: string;
      action: 'LEND_ITEM_PUBLISH' | 'LOAN_REQUEST';
      categoryId: string;
      mode: NeedMode;
      amount: number;
    },
    ctx: RequestContext,
  ): Promise<VerificationDecision>;
}

// ---------------------------------------------------------------- storage

export interface NewLendItem {
  id: string;
  lenderId: string;
  categoryId: string;
  title: string;
  description: string;
  condition: Condition;
  district: District;
  mediaIds: string[];
  depositAmount: number | null;
  maxLoanDays: number;
  requirements: Requirements;
}

export type LendItemPatch = {
  [K in Exclude<keyof NewLendItem, 'id' | 'lenderId'>]?: NewLendItem[K] | undefined;
} & { active?: boolean | undefined };

export interface ItemSearch {
  q?: string | undefined;
  categoryId?: string | undefined;
  district?: District | undefined;
  cursor: Cursor | null;
  limit: number;
}

export interface NewLoan {
  id: string;
  itemId: string;
  lenderId: string;
  borrowerId: string;
  itemTitle: string;
  categoryId: string;
  startAt: Date;
  returnBy: Date;
  message: string | null;
  depositAmount: number | null;
}

export interface LoanPatch {
  declineReason?: string;
  transactionId?: string;
}

export interface TransitionRecord {
  loanId: string;
  from: LoanStatus | null;
  to: LoanStatus;
  command: string;
  actorId: string | null;
  actorRole: ActorRole;
  reason: string | null;
}

export interface LoanListQuery {
  status?: LoanStatus | undefined;
  cursor: Cursor | null;
  limit: number;
}

export interface Loaded<T> {
  value: T;
  /** Database clock at read time. */
  now: Date;
}

export interface LendingStore {
  now(): Promise<Date>;

  // items
  item(id: string, opts?: { forUpdate?: boolean }): Promise<LendItem | null>;
  insertItem(i: NewLendItem): Promise<LendItem>;
  updateItem(id: string, patch: LendItemPatch): Promise<LendItem>;
  setItemHidden(id: string, hidden: boolean): Promise<LendItem | null>;
  searchItems(s: ItemSearch): Promise<LendItem[]>;
  itemsOf(lenderId: string, q: { cursor: Cursor | null; limit: number }): Promise<LendItem[]>;
  lenderStats(lenderId: string): Promise<LenderStats>;

  // loans
  loan(id: string, opts?: { forUpdate?: boolean }): Promise<Loaded<Loan> | null>;
  /** Throws 409 when the borrower already has an open request for the item. */
  insertLoan(l: NewLoan): Promise<Loan>;
  /**
   * Guarded `UPDATE … WHERE status = from AND version = v`; null when someone else won.
   * Throws 409 LOAN_CONFLICT when the period overlaps another active loan of the item.
   */
  transitionLoan(
    id: string,
    guard: { from: LoanStatus; version: number },
    to: LoanStatus,
    patch: LoanPatch,
  ): Promise<Loan | null>;
  /** Whether another loan of the item holds an overlapping period in a blocking status. */
  hasBlockingOverlap(loan: Loan): Promise<boolean>;
  setTransactionId(loanId: string, transactionId: string): Promise<Loan | null>;
  /** Guarded stamp; false when already notified. */
  markOverdueNotified(loanId: string): Promise<boolean>;
  appendTransition(t: TransitionRecord): Promise<void>;
  transitions(loanId: string): Promise<LoanTransition[]>;
  loansForParty(
    accountId: string,
    role: 'lender' | 'borrower' | undefined,
    q: LoanListQuery,
  ): Promise<Loan[]>;
  allLoans(q: LoanListQuery): Promise<Loan[]>;
  /** REQUESTED loans older than the TTL (rows locked, skip locked). */
  dueForExpiry(ttlMs: number, limit: number): Promise<string[]>;
  /** LENT/RETURN_REPORTED past returnBy and not yet notified (rows locked, skip locked). */
  dueForOverdue(limit: number): Promise<string[]>;

  // projections
  category(id: string): Promise<CategoryFacts | null>;
  upsertCategory(c: CategoryFacts): Promise<void>;
  borrowerFacts(accountId: string): Promise<BorrowerFacts>;
  setReputation(
    accountId: string,
    r: { completedCount: number; ratingAverage: number | null; ratingCount: number },
  ): Promise<void>;
  setNidVerified(accountId: string, verified: boolean): Promise<void>;

  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
}

export interface LendingUnitOfWork {
  readonly store: LendingStore;
  transaction<T>(fn: (store: LendingStore) => Promise<T>): Promise<T>;
}
