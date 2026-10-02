import type { EventEnvelope } from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { Policy, PolicyAction, PolicyScope, Requirement, Selector } from '../domain/policy';
import type { Verification, VerificationKind, VerificationStatus } from '../domain/verification';

/** Fields written when a record (re)enters a status. */
export interface VerificationWrite {
  status: VerificationStatus;
  provider: string;
  providerRef: string | null;
  nidLast4?: string | null;
  /** HMAC of the normalized NID; null clears it. */
  nidFingerprint?: string | null;
  reviewedBy?: string | null;
  reviewNote?: string | null;
  verified: boolean;
  /** True for a new submission (resets submitted_at). */
  submitted: boolean;
}

export interface PolicyInput {
  name: string;
  action: PolicyAction;
  scope: PolicyScope;
  selector: Selector;
  requirement: Requirement;
  kinds: VerificationKind[];
  active: boolean;
  priority: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface VerificationStore {
  mine(accountId: string): Promise<Verification[]>;
  byId(id: string): Promise<Verification | null>;
  /** Current record for (account, kind), row-locked when inside a transaction. */
  current(accountId: string, kind: VerificationKind, lock?: boolean): Promise<Verification | null>;
  /** True if another account holds a VERIFIED NID with this fingerprint. */
  nidVerifiedElsewhere(fingerprint: string, accountId: string): Promise<boolean>;
  fingerprintOf(id: string): Promise<string | null>;
  insert(
    id: string,
    accountId: string,
    kind: VerificationKind,
    w: VerificationWrite,
  ): Promise<Verification>;
  /** Guarded update: only applies if status and version still match. Null if it lost the race. */
  transition(
    v: Pick<Verification, 'id' | 'status' | 'version'>,
    w: VerificationWrite,
  ): Promise<Verification | null>;
  history(
    verificationId: string,
    from: VerificationStatus | null,
    to: VerificationStatus,
    actorId: string | null,
    reason: string | null,
  ): Promise<void>;
  list(
    filter: { status: VerificationStatus; kind?: VerificationKind | undefined },
    after: Cursor | null,
    limit: number,
  ): Promise<Page<Verification>>;
  verifiedKinds(accountId: string): Promise<VerificationKind[]>;

  policies(after: Cursor | null, limit: number): Promise<Page<Policy>>;
  /** Active policies that can apply to `action` (its own and ANY). */
  activePoliciesFor(action: PolicyAction): Promise<Policy[]>;
  policy(id: string, lock?: boolean): Promise<Policy | null>;
  insertPolicy(id: string, p: PolicyInput, actorId: string): Promise<Policy>;
  /** Guarded by version; null if it changed meanwhile. */
  updatePolicy(
    id: string,
    version: number,
    p: PolicyInput,
    actorId: string,
  ): Promise<Policy | null>;

  /** Clears fingerprints of NID records rejected more than `days` ago. */
  purgeRejectedFingerprints(days: number): Promise<number>;

  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(
    ctx: Pick<RequestContext, 'requestId' | 'ipHash' | 'actor'>,
    entry: AuditEntry,
  ): Promise<void>;
}

export interface VerificationUnitOfWork {
  readonly store: VerificationStore;
  transaction<T>(fn: (store: VerificationStore) => Promise<T>): Promise<T>;
}

/**
 * NID check at an external authority (EC/porichoy) or a manual review queue. Receives the raw
 * data; the service keeps only last4 and a keyed fingerprint.
 */
export interface NidProvider {
  readonly name: string;
  check(input: {
    accountId: string;
    nid: string;
    dateOfBirth: string;
    fullName: string;
  }): Promise<{ outcome: 'PENDING' | 'VERIFIED' | 'REJECTED'; providerRef: string | null }>;
}

/** Keyed hash for duplicate detection; never reversible without the key. */
export type Fingerprinter = (normalizedNid: string) => string;

export interface Clock {
  now(): Date;
}
