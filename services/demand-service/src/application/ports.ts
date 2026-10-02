import type {
  AttributeSchema,
  AttributeValues,
  Condition,
  District,
  EventEnvelope,
  NeedMode,
  NeedStatus,
} from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { Category, DeliveryPreference, ModeTerms, Need, Visibility } from '../domain/need';

export interface CategoryUpsert {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameBn: string;
  modes: NeedMode[];
  attributeSchema: AttributeSchema;
  active: boolean;
}

export interface NewNeed {
  id: string;
  requesterId: string;
  mode: NeedMode;
  categoryId: string;
  title: string;
  description: string | null;
  quantity: number;
  budgetMin: number | null;
  budgetMax: number | null;
  budgetFlexible: boolean;
  conditions: Condition[];
  attributes: AttributeValues;
  modeTerms: ModeTerms;
  district: District;
  area: string | null;
  deliveryPref: DeliveryPreference;
  requiredBy: string | null;
  ttlDays: number | null;
  maxOffers: number;
  visibility: Visibility;
}

/** Fields an owner edit may change (already validated and merged by the use case). */
export type NeedEdit = Omit<NewNeed, 'id' | 'requesterId' | 'maxOffers' | 'ttlDays'>;

/** Columns a transition may set alongside the status. */
export interface TransitionChanges {
  expiresAt?: Date;
  publishedAt?: Date;
  renewals?: number;
  statusBeforeHidden?: NeedStatus | null;
}

export interface HistoryEntry {
  from: NeedStatus | null;
  to: NeedStatus;
  actorId: string | null;
  reason: string;
  at: Date;
}

export interface FeedFilter {
  q?: string | undefined;
  categoryId?: string | undefined;
  mode?: NeedMode | undefined;
  district?: District | undefined;
  budgetMaxAtLeast?: number | undefined;
}

/** Storage for the demand context, bound to one executor (autocommit or a transaction). */
export interface NeedStore {
  /** Database clock: deadlines are always compared with the DB's now(). */
  now(): Promise<Date>;

  category(id: string): Promise<Category | null>;
  upsertCategory(c: CategoryUpsert): Promise<void>;

  insert(n: NewNeed): Promise<Need>;
  get(id: string): Promise<Need | null>;
  /** Row-locks the need for the rest of the transaction. */
  getForUpdate(id: string): Promise<Need | null>;
  /** Guarded by version; null when the need changed concurrently. */
  update(id: string, version: number, edit: NeedEdit): Promise<Need | null>;
  /** Guarded `UPDATE … WHERE status = from AND version = v`; null when it lost a race. */
  setStatus(
    id: string,
    from: NeedStatus,
    version: number,
    to: NeedStatus,
    changes: TransitionChanges,
  ): Promise<Need | null>;
  appendHistory(needId: string, e: Omit<HistoryEntry, 'at'>): Promise<void>;
  history(needId: string): Promise<HistoryEntry[]>;

  /** Serializes the open-need limit check per requester (transaction-scoped lock). */
  lockRequester(requesterId: string): Promise<void>;
  countActive(requesterId: string): Promise<number>;

  feed(f: FeedFilter, cursor: Cursor | null, limit: number): Promise<Need[]>;
  listByRequester(
    requesterId: string,
    status: NeedStatus | undefined,
    cursor: Cursor | null,
    limit: number,
  ): Promise<Need[]>;

  /** Expiry job: due OPEN/PAUSED needs, locked with SKIP LOCKED. */
  dueForExpiry(limit: number): Promise<Need[]>;

  // projections from offer / transaction / matching events
  incrementOfferCount(needId: string): Promise<void>;
  /** Records an accepted offer; false when it was already recorded. */
  addAcceptedOffer(offerId: string, needId: string, quantity: number): Promise<boolean>;
  /** Marks an accepted offer cancelled; returns it, or null if unknown / already cancelled. */
  cancelAcceptedOffer(offerId: string): Promise<{ needId: string; quantity: number } | null>;
  /** Marks an accepted offer's transaction completed; returns its need id or null. */
  completeAcceptedOffer(offerId: string): Promise<string | null>;
  /** True when every live accepted offer of the need has a completed transaction. */
  allAcceptedOffersCompleted(needId: string): Promise<boolean>;
  /** Adds `delta` to accepted_quantity (floored at 0) and returns the locked row. */
  adjustAcceptedQuantity(needId: string, delta: number): Promise<Need | null>;
  addMatch(needId: string, sellerId: string): Promise<void>;
  isMatched(needId: string, sellerId: string): Promise<boolean>;

  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(ctx: Pick<RequestContext, 'requestId' | 'ipHash' | 'actor'>, e: AuditEntry): Promise<void>;
}

export interface NeedUnitOfWork {
  readonly store: NeedStore;
  transaction<T>(fn: (store: NeedStore) => Promise<T>): Promise<T>;
}

/** Verification policy (verification-service). Fails closed: unreachable → 503. */
export interface VerificationGateway {
  evaluate(
    q: {
      accountId: string;
      action: 'NEED_PUBLISH';
      categoryId: string;
      mode: NeedMode;
      /** Budget max in poisha, when known. */
      amount: number | null;
    },
    ctx: Pick<RequestContext, 'requestId' | 'correlationId'> & {
      actor?: RequestContext['actor'] | undefined;
    },
  ): Promise<{ satisfied: boolean; missing: string[] }>;
}
