import type {
  DisputeReason,
  DisputeResolution,
  DisputeStatus,
  NeedMode,
  TransactionSourceType,
  TransactionState,
} from '@dorkar/contracts';
import type { Generated, KernelTables } from '@dorkar/kernel';
import type { ColumnType, GeneratedAlways } from 'kysely';
import type {
  AuthorRole,
  EntryKind,
  PaymentProviderName,
  TargetParty,
  Visibility,
} from '../domain/dispute';

/** int8 columns come back from pg as strings; written as numbers. */
type Int8 = ColumnType<string, number, number>;
type NullableInt8 = ColumnType<string | null, number | null, number | null>;

export interface DisputeDB extends KernelTables {
  transaction_projection: {
    transaction_id: string;
    buyer_id: string;
    seller_id: string;
    mode: NeedMode | null;
    amount: NullableInt8;
    currency: string | null;
    source_type: TransactionSourceType;
    source_id: string;
    updated_at: Generated<Date>;
  };
  disputes: {
    id: string;
    transaction_id: string;
    buyer_id: string;
    seller_id: string;
    opened_by: string;
    respondent_id: string;
    previous_state: TransactionState;
    reason: DisputeReason;
    description: string | null;
    mode: NeedMode | null;
    amount: NullableInt8;
    currency: string | null;
    payment_provider: Generated<PaymentProviderName>;
    status: DisputeStatus;
    respond_by: Date;
    respondent_missed_deadline: Generated<boolean>;
    statement_submitted_at: Date | null;
    assigned_to: string | null;
    assigned_at: Date | null;
    escalated: Generated<boolean>;
    escalated_at: Date | null;
    resolution: DisputeResolution | null;
    resolution_note: string | null;
    resolved_by: string | null;
    resolved_at: Date | null;
    withdrawn_by: string | null;
    withdrawn_at: Date | null;
    applied_at: Date | null;
    final_transaction_state: TransactionState | null;
    opened_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  dispute_entries: {
    id: string;
    seq: GeneratedAlways<Int8>;
    dispute_id: string;
    kind: EntryKind;
    author_id: string | null;
    author_role: AuthorRole;
    visibility: Visibility;
    text: string | null;
    media_ids: Generated<string[]>;
    target_party: TargetParty | null;
    from_status: DisputeStatus | null;
    to_status: DisputeStatus | null;
    created_at: Generated<Date>;
  };
}
