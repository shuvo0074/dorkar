import type { DeliveryMode, DisputeReason, NeedMode, TransactionState } from '@dorkar/contracts';
import type { Generated, IdempotencyTables, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type {
  DeliveryProviderName,
  DeliveryStatus,
  DepositStatus,
  ListingKind,
  PaymentProviderName,
  PaymentStatus,
  PriceUnit,
  SourceType,
} from '../domain/transaction';

/** int8 comes back from pg as a string; written as a number. */
type BigIntColumn = ColumnType<string, number, number>;
type Json = ColumnType<Record<string, unknown>, string, string>;

export interface TransactionDB extends KernelTables, IdempotencyTables {
  transactions: {
    id: string;
    source_type: SourceType;
    source_id: string;
    listing_id: string | null;
    need_id: string | null;
    buyer_id: string;
    seller_id: string;
    mode: NeedMode;
    amount: BigIntColumn;
    currency: Generated<'BDT'>;
    quantity: number;
    terms_snapshot: Json;
    state: Generated<TransactionState>;
    buyer_confirmed_at: Date | null;
    seller_confirmed_at: Date | null;
    delivered_at: Date | null;
    handed_over_at: Date | null;
    return_reported_at: Date | null;
    returned_at: Date | null;
    completed_at: Date | null;
    cancel_reason: string | null;
    dispute_reason: string | null;
    dispute_category: DisputeReason | null;
    pre_dispute_state: TransactionState | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  transaction_transitions: {
    id: string;
    transaction_id: string;
    from_state: TransactionState;
    to_state: TransactionState;
    command: string;
    actor_id: string | null;
    actor_role: string;
    reason: string | null;
    at: Generated<Date>;
  };
  payments: {
    id: string;
    transaction_id: string;
    provider: PaymentProviderName;
    status: PaymentStatus;
    amount: BigIntColumn;
    currency: Generated<'BDT'>;
    provider_ref: string | null;
    note: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  deposits: {
    id: string;
    transaction_id: string;
    amount: BigIntColumn;
    currency: Generated<'BDT'>;
    status: DepositStatus;
    note: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  deliveries: {
    id: string;
    transaction_id: string;
    method: DeliveryMode;
    status: DeliveryStatus;
    notes: string | null;
    scheduled_for: Date | null;
    provider: DeliveryProviderName;
    provider_ref: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  listing_projection: {
    listing_id: string;
    seller_id: string;
    kind: ListingKind;
    title: string;
    price_amount: BigIntColumn;
    currency: Generated<'BDT'>;
    price_unit: PriceUnit;
    quantity_available: number;
    delivery_modes: DeliveryMode[];
    available: Generated<boolean>;
    updated_at: Generated<Date>;
  };
}
