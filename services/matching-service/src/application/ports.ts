import type {
  DeliveryMode,
  District,
  EventEnvelope,
  NeedMode,
  NeedStatus,
  SellerRole,
} from '@dorkar/contracts';
import type { Cursor } from '@dorkar/kernel';
import type {
  CandidateType,
  ListingCandidate,
  ListingKind,
  MatchAction,
  MatchStatus,
  ScoringNeed,
  SellerCandidate,
  SellerSignals,
} from '../domain/matching';

export type { MatchScorer, MatchScore } from '../domain/scoring';

export interface CategoryRecord {
  id: string;
  parentId: string | null;
  modes: NeedMode[];
  active: boolean;
}

/** Need facts as published by demand (amounts in poisha). */
export interface NeedFacts {
  needId: string;
  requesterId: string;
  mode: NeedMode;
  categoryId: string;
  title: string;
  quantity: number;
  budgetMin: number | null;
  budgetMax: number | null;
  conditions: ScoringNeed['conditions'];
  district: District;
  attributes: Record<string, unknown>;
  expiresAt: string;
}

export interface OpenNeed extends ScoringNeed {
  status: NeedStatus;
  /** expires_at already passed (by DB clock). */
  expired: boolean;
}

export type ListingFacts = Omit<ListingCandidate, 'type' | 'categoryParentId' | 'available'>;

export interface MatchRecord {
  id: string;
  needId: string;
  sellerId: string;
  listingId: string | null;
  candidateType: CandidateType;
  score: number;
  reasons: Record<string, number>;
  scorer: string;
  status: MatchStatus;
  respondedAt: Date | null;
  dismissedAt: Date | null;
  createdAt: Date;
}

export interface MatchWrite {
  listingId: string | null;
  candidateType: CandidateType;
  score: number;
  reasons: Record<string, number>;
  scorer: string;
  status: MatchStatus;
}

export interface MatchedNeed {
  match: MatchRecord;
  need: {
    needId: string;
    title: string;
    mode: NeedMode;
    categoryId: string;
    quantity: number;
    district: District;
    budgetMin: number | null;
    budgetMax: number | null;
    expiresAt: Date;
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface OpenNeedQuery {
  /** Need's category is one of these … */
  categoryIds: string[];
  /** … or the need's category's parent is one of these. */
  parentCategoryIds: string[];
  modes: NeedMode[];
  /** Need district within these; null = anywhere (candidate delivers). */
  districts: District[] | null;
  excludeRequesterId: string;
  limit: number;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface MatchingStore {
  // ---- projections
  upsertCategory(c: CategoryRecord): Promise<void>;
  /** `publishedAt` set: the need (re)became OPEN; otherwise facts only, status kept. */
  upsertNeed(n: NeedFacts, publishedAt: string | null): Promise<void>;
  setNeedStatus(needId: string, status: NeedStatus): Promise<void>;
  need(needId: string): Promise<OpenNeed | null>;
  upsertListing(l: ListingFacts): Promise<void>;
  setListingUnavailable(listingId: string): Promise<void>;
  listing(listingId: string): Promise<ListingCandidate | null>;
  upsertSeller(s: {
    accountId: string;
    roles: SellerRole[];
    categoryIds: string[];
    serviceDistricts: District[];
    deliveryModes: DeliveryMode[];
    active: boolean;
  }): Promise<void>;
  seller(accountId: string): Promise<SellerCandidate | null>;
  setReputation(
    accountId: string,
    r: { ratingAverage: number | null; ratingCount: number; completedCount: number },
  ): Promise<void>;
  setNidVerified(accountId: string, verified: boolean): Promise<void>;
  signals(sellerIds: readonly string[]): Promise<Map<string, SellerSignals>>;

  // ---- candidate prefilters (category, mode, division)
  listingCandidates(
    need: ScoringNeed,
    q: { kinds: readonly ListingKind[]; districts: District[]; limit: number },
  ): Promise<ListingCandidate[]>;
  sellerCandidates(
    need: ScoringNeed,
    q: { roles: readonly SellerRole[]; districts: District[]; limit: number },
  ): Promise<SellerCandidate[]>;
  openNeeds(q: OpenNeedQuery): Promise<ScoringNeed[]>;

  // ---- matches
  matchesForNeed(needId: string): Promise<MatchRecord[]>;
  matchesOfSeller(sellerId: string, needIds: readonly string[]): Promise<MatchRecord[]>;
  liveMatchCount(needId: string): Promise<number>;
  /** Insert-if-absent on (need, seller); false when a match already exists. */
  insertMatch(m: MatchWrite & { id: string; needId: string; sellerId: string }): Promise<boolean>;
  updateMatch(id: string, m: MatchWrite): Promise<void>;
  /** Guarded bulk transition: only rows in a state that allows `action` change. */
  applyToMatches(
    action: MatchAction,
    where: { id?: string; needId?: string; sellerId?: string; ids?: readonly string[] },
  ): Promise<number>;
  match(id: string): Promise<MatchRecord | null>;
  pageForNeed(needId: string, after: Cursor | null, limit: number): Promise<Page<MatchRecord>>;
  pageForSeller(sellerId: string, after: Cursor | null, limit: number): Promise<Page<MatchedNeed>>;

  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
}

export interface MatchingUnitOfWork {
  readonly store: MatchingStore;
  transaction<T>(fn: (store: MatchingStore) => Promise<T>): Promise<T>;
}

export interface MatchingSettings {
  minScore: number;
  maxPerNeed: number;
  reverseScanLimit: number;
}
