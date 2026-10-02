import type {
  DisputeReason,
  DisputeResolution,
  DisputeStatus,
  EventEnvelope,
  NeedMode,
  TransactionSourceType,
  TransactionState,
} from '@dorkar/contracts';
import type { AuditEntry, RequestContext } from '@dorkar/kernel';
import type {
  AuthorRole,
  Dispute,
  Entry,
  EntryKind,
  TargetParty,
  Visibility,
} from '../domain/dispute';

export interface DealProjection {
  transactionId: string;
  buyerId: string;
  sellerId: string;
  mode: NeedMode | null;
  amount: number | null;
  currency: string | null;
  sourceType: TransactionSourceType;
  sourceId: string;
}

export interface NewDispute {
  id: string;
  transactionId: string;
  buyerId: string;
  sellerId: string;
  openedBy: string;
  respondentId: string;
  previousState: TransactionState;
  reason: DisputeReason;
  description: string | null;
  mode: NeedMode | null;
  amount: number | null;
  currency: string | null;
  respondWithinHours: number;
}

export interface NewEntry {
  disputeId: string;
  kind: EntryKind;
  authorId: string | null;
  authorRole: AuthorRole;
  visibility: Visibility;
  text?: string | null;
  mediaIds?: string[];
  targetParty?: TargetParty | null;
  fromStatus?: DisputeStatus | null;
  toStatus?: DisputeStatus | null;
}

/** Fields a status transition sets alongside the status (timestamps come from the DB clock). */
export interface TransitionPatch {
  statementSubmitted?: boolean;
  respondentMissedDeadline?: boolean;
  resolution?: { resolution: DisputeResolution; note: string; by: string };
  withdrawnBy?: string | null;
  applied?: { finalState: TransactionState };
}

export interface PageCursor {
  k: string | number;
  id: string;
}

export interface PartyListQuery {
  status?: DisputeStatus | undefined;
  cursor: PageCursor | null;
  limit: number;
}

export interface AdminListQuery extends PartyListQuery {
  /** An account id, or 'none' for unassigned. */
  assignee?: string | undefined;
  escalated?: boolean | undefined;
}

export interface Loaded {
  dispute: Dispute;
  /** Database clock at read time. */
  now: Date;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface DisputeStore {
  upsertDeal(p: DealProjection): Promise<void>;
  deal(transactionId: string): Promise<DealProjection | null>;
  /** Back-fills mode/amount on cases opened before the deal projection arrived. */
  fillDealFacts(p: DealProjection): Promise<void>;

  /** Null when a live case for the transaction already exists. */
  insert(d: NewDispute): Promise<Dispute | null>;
  load(id: string): Promise<Loaded | null>;
  /** The newest case for a transaction whose outcome has not been applied yet (row locked). */
  unappliedForTransaction(transactionId: string): Promise<Dispute | null>;
  /** Guarded `UPDATE … WHERE status = from AND version = v`; null when someone else won. */
  transition(
    id: string,
    guard: { from: DisputeStatus; version: number },
    to: DisputeStatus,
    patch: TransitionPatch,
  ): Promise<Dispute | null>;
  markApplied(id: string, finalState: TransactionState): Promise<void>;
  /** Assigns a live case; null if it is no longer live. */
  assign(id: string, assigneeId: string): Promise<Dispute | null>;

  appendEntry(e: NewEntry): Promise<Entry>;
  entries(disputeId: string, includeStaffOnly: boolean): Promise<Entry[]>;

  listForParty(accountId: string, q: PartyListQuery): Promise<Dispute[]>;
  listAdmin(q: AdminListQuery): Promise<Dispute[]>;

  /** AWAITING_RESPONSE cases past respond_by (rows locked, skip locked). */
  dueForDeadline(limit: number): Promise<string[]>;
  /** Marks live cases unassigned for longer than `hours` as escalated; returns their ids. */
  escalateUnassigned(hours: number, limit: number): Promise<string[]>;

  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
}

export interface DisputeUnitOfWork {
  readonly store: DisputeStore;
  transaction<T>(fn: (store: DisputeStore) => Promise<T>): Promise<T>;
}

/** Lets the other side read private attachments (media-service read grants). */
export interface MediaAccess {
  grant(
    input: {
      ownerId: string;
      mediaIds: string[];
      accountIds: string[];
      purpose: 'MESSAGE' | 'DISPUTE';
    },
    ctx: Pick<RequestContext, 'requestId' | 'correlationId'>,
  ): Promise<void>;
}
