import type { NeedMode, TransactionState } from '@dorkar/contracts';
import type { Generated, KernelTables } from '@dorkar/kernel';
import type { AuthorRole, ReviewStatus } from '../domain/review';

export interface ReputationDB extends KernelTables {
  transactions: {
    id: string;
    buyer_id: string;
    seller_id: string;
    mode: NeedMode | null;
    amount: string | number | null; // int8 → string from pg
    currency: string | null;
    state: TransactionState;
    state_at: Date;
    completed_at: Date | null;
    cancelled_by: string | null;
    disputed_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  account_stats: {
    account_id: string;
    completed_count: number;
    cancelled_count: number;
    disputed_count: number;
    as_seller_completed: number;
    as_buyer_completed: number;
    updated_at: Generated<Date>;
  };
  reviews: {
    id: string;
    transaction_id: string;
    author_id: string;
    subject_id: string;
    author_role: AuthorRole;
    rating: number;
    comment: string | null;
    status: Generated<ReviewStatus>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  reputation_signals: {
    account_id: string;
    signal: string;
    value: string | null; // numeric → string from pg
    computed_at: Generated<Date>;
  };
}
