import type { Generated, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type { PolicyAction, PolicyScope, Requirement, Selector } from '../domain/policy';
import type { VerificationKind, VerificationStatus } from '../domain/verification';

type Json<T> = ColumnType<T, string, string>;

export interface VerificationDB extends KernelTables {
  verifications: {
    id: string;
    account_id: string;
    kind: VerificationKind;
    status: VerificationStatus;
    provider: string;
    provider_ref: string | null;
    nid_last4: string | null;
    /** HMAC-SHA256(PII_HASH_KEY, normalized NID), hex. Never the raw number. */
    nid_fingerprint: string | null;
    reviewed_by: string | null;
    review_note: string | null;
    submitted_at: Generated<Date>;
    verified_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  verification_history: {
    id: string;
    verification_id: string;
    from_status: VerificationStatus | null;
    to_status: VerificationStatus;
    actor_id: string | null;
    reason: string | null;
    occurred_at: Generated<Date>;
  };
  policies: {
    id: string;
    name: string;
    action: PolicyAction;
    scope: PolicyScope;
    selector: Json<Selector>;
    requirement: Requirement;
    kinds: VerificationKind[];
    active: boolean;
    priority: number;
    version: Generated<number>;
    updated_by: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
