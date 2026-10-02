import type {
  AttributeSchema,
  Condition,
  District,
  EventEnvelope,
  NeedMode,
} from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { Category } from '../domain/category';
import type {
  HideableStatus,
  Listing,
  ListingContent,
  ListingKind,
  ListingStatus,
} from '../domain/listing';

export interface NewCategory {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameBn: string;
  modes: NeedMode[];
  attributeSchema: AttributeSchema;
  sort: number;
  active: boolean;
}

export type CategoryPatch = { [K in keyof Omit<NewCategory, 'id'>]?: NewCategory[K] | undefined };

export type ListingSort = 'newest' | 'price_asc' | 'price_desc';

export interface ListingSearch {
  q?: string | undefined;
  categoryId?: string | undefined;
  district?: District | undefined;
  kind?: ListingKind | undefined;
  condition?: Condition | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  sort: ListingSort;
  limit: number;
  cursor: Cursor | null;
}

export interface StatusChange {
  id: string;
  /** Guards: the update only applies if the row is still in this state at this version. */
  expectedStatus: ListingStatus;
  expectedVersion: number;
  to: ListingStatus;
  hiddenFrom: HideableStatus | null;
  hiddenReason: string | null;
}

export interface HistoryEntry {
  listingId: string;
  from: ListingStatus | null;
  to: ListingStatus;
  actorId: string | null;
  actorType: 'USER' | 'ADMIN' | 'SYSTEM';
  reason: string | null;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface CatalogStore {
  // categories
  allCategories(): Promise<Category[]>;
  category(id: string): Promise<Category | null>;
  /** Locks the row for the rest of the transaction. */
  categoryForUpdate(id: string): Promise<Category | null>;
  /** `id` followed by its ancestors up to the root (empty if `id` does not exist). */
  categoryChain(id: string): Promise<string[]>;
  /** Throws 409 CONFLICT on a duplicate slug. */
  insertCategory(c: NewCategory): Promise<Category>;
  updateCategory(id: string, patch: CategoryPatch): Promise<Category>;

  // listings
  insertListing(l: { id: string; sellerId: string } & ListingContent): Promise<Listing>;
  listing(id: string): Promise<Listing | null>;
  ownedListing(id: string, sellerId: string): Promise<Listing | null>;
  /** Guarded content update; null if the listing changed meanwhile (version/status moved). */
  updateListingContent(
    id: string,
    expected: { status: ListingStatus; version: number },
    content: ListingContent,
  ): Promise<Listing | null>;
  /** Guarded state change; null if another transition won the race. */
  changeStatus(change: StatusChange): Promise<Listing | null>;
  appendHistory(entry: HistoryEntry): Promise<void>;
  searchListings(s: ListingSearch): Promise<Listing[]>;
  listingsBySeller(
    sellerId: string,
    opts: { status?: ListingStatus | undefined; limit: number; cursor: Cursor | null },
  ): Promise<Listing[]>;

  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(
    ctx: Pick<RequestContext, 'requestId' | 'ipHash' | 'actor'>,
    entry: AuditEntry,
  ): Promise<void>;
}

export interface CatalogUnitOfWork {
  readonly store: CatalogStore;
  transaction<T>(fn: (store: CatalogStore) => Promise<T>): Promise<T>;
}

export interface VerificationDecision {
  satisfied: boolean;
  /** Verification kinds still missing, e.g. ['NID']. */
  missing: string[];
}

/**
 * Port to verification's policy engine. Implementations must fail closed: if the decision
 * cannot be obtained they throw 503 UNAVAILABLE, never "satisfied".
 */
export interface VerificationGateway {
  evaluate(
    q: { accountId: string; action: 'LISTING_PUBLISH'; categoryId: string; amount: number },
    ctx: Pick<RequestContext, 'requestId' | 'correlationId'> & {
      actor?: RequestContext['actor'] | undefined;
    },
  ): Promise<VerificationDecision>;
}
