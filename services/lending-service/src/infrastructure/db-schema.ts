import type { Condition, District, LoanStatus, NeedMode } from '@dorkar/contracts';
import type { Generated, IdempotencyTables, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type { ActorRole } from '../domain/loan';

/** int8 comes back from pg as a string; written as a number. */
type NullableBigInt = ColumnType<string | null, number | null, number | null>;
/** numeric comes back as a string. */
type Numeric = ColumnType<string | null, string | null, string | null>;

export interface LendingDB extends KernelTables, IdempotencyTables {
  lend_items: {
    id: string;
    lender_id: string;
    category_id: string;
    title: string;
    description: Generated<string>;
    condition: Condition;
    district: District;
    media_ids: Generated<string[]>;
    deposit_amount: NullableBigInt;
    currency: Generated<'BDT'>;
    max_loan_days: number;
    req_nid_verified: Generated<boolean>;
    req_min_completed_deals: Generated<number>;
    req_min_rating: Numeric;
    active: Generated<boolean>;
    hidden: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  loans: {
    id: string;
    item_id: string;
    lender_id: string;
    borrower_id: string;
    item_title: string;
    category_id: string;
    start_at: Date;
    return_by: Date;
    message: string | null;
    deposit_amount: NullableBigInt;
    currency: Generated<'BDT'>;
    status: Generated<LoanStatus>;
    transaction_id: string | null;
    decline_reason: string | null;
    returned_at: Date | null;
    overdue_notified_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  loan_transitions: {
    id: string;
    loan_id: string;
    from_status: LoanStatus | null;
    to_status: LoanStatus;
    command: string;
    actor_id: string | null;
    actor_role: ActorRole;
    reason: string | null;
    at: Generated<Date>;
  };
  category_projection: {
    category_id: string;
    modes: NeedMode[];
    active: boolean;
    updated_at: Generated<Date>;
  };
  reputation_projection: {
    account_id: string;
    completed_count: number;
    rating_average: Numeric;
    rating_count: number;
    updated_at: Generated<Date>;
  };
  verification_projection: {
    account_id: string;
    nid_verified: boolean;
    updated_at: Generated<Date>;
  };
}
