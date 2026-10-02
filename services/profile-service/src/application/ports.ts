import type { EventEnvelope } from '@dorkar/contracts';
import type { Badge, Profile, ReputationSummary, SellerCapabilities } from '../domain/profile';

export interface ProfilePatch {
  displayName?: string | undefined;
  userType?: Profile['userType'] | undefined;
  bio?: string | null | undefined;
  district?: Profile['district'] | undefined;
  area?: string | null | undefined;
  locale?: Profile['locale'] | undefined;
  avatarMediaId?: string | null | undefined;
}

export interface PublicCard {
  accountId: string;
  displayName: string;
  userType: Profile['userType'];
  district: Profile['district'];
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface ProfileStore {
  get(accountId: string): Promise<Profile | null>;
  /** Insert-if-missing; race-safe with the AccountCreated consumer. */
  ensure(accountId: string, displayName: string): Promise<Profile>;
  update(accountId: string, patch: ProfilePatch): Promise<Profile>;
  setHidden(accountId: string, hidden: boolean): Promise<void>;
  capabilities(accountId: string): Promise<SellerCapabilities | null>;
  setCapabilities(c: SellerCapabilities): Promise<void>;
  reputation(accountId: string): Promise<ReputationSummary | null>;
  setReputation(accountId: string, r: ReputationSummary): Promise<void>;
  badges(accountId: string): Promise<Badge[]>;
  setVerification(accountId: string, kind: string, status: string): Promise<void>;
  cards(accountIds: readonly string[]): Promise<PublicCard[]>;
  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
}

export interface ProfileUnitOfWork {
  readonly store: ProfileStore;
  transaction<T>(fn: (store: ProfileStore) => Promise<T>): Promise<T>;
}
