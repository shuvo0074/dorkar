import type { BookingStatus, District } from '@dorkar/contracts';
import type { Generated, IdempotencyTables, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type { ActorRole } from '../domain/booking-state-machine';
import type { PriceUnit } from '../domain/booking';

/** int8 comes back from pg as a string; written as a number. */
type BigIntColumn = ColumnType<string, number, number>;
type NullableBigInt = ColumnType<string | null, number | null, number | null>;
type Json = ColumnType<Record<string, unknown>, string, string>;
/** tstzrange: read as text, written through a `tstzrange(…)` expression. */
type Range = ColumnType<string, string, string>;

export interface RentalDB extends KernelTables, IdempotencyTables {
  listing_projection: {
    listing_id: string;
    seller_id: string;
    category_id: string;
    title: string;
    district: District;
    price_amount: BigIntColumn;
    currency: Generated<'BDT'>;
    price_unit: PriceUnit;
    available: Generated<boolean>;
    updated_at: Generated<Date>;
  };
  rental_terms: {
    listing_id: string;
    instant_book: boolean;
    min_duration_hours: number;
    max_duration_days: number;
    deposit_amount: NullableBigInt;
    deposit_currency: 'BDT' | null;
    advance_notice_hours: number;
    buffer_hours: number;
    cancellation_note: string | null;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  bookings: {
    id: string;
    listing_id: string;
    owner_id: string;
    renter_id: string;
    start_at: Date;
    end_at: Date;
    status: BookingStatus;
    hold_expires_at: Date | null;
    amount: BigIntColumn;
    currency: Generated<'BDT'>;
    deposit_amount: NullableBigInt;
    terms_snapshot: Json;
    note: string | null;
    decline_reason: Generated<string | null>;
    cancel_reason: Generated<string | null>;
    transaction_id: Generated<string | null>;
    transaction_state: Generated<string | null>;
    disputed: Generated<boolean>;
    overdue_notified_at: Generated<Date | null>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    version: Generated<number>;
  };
  booking_transitions: {
    id: string;
    booking_id: string;
    from_status: BookingStatus;
    to_status: BookingStatus;
    command: string;
    actor_id: string | null;
    actor_role: ActorRole;
    reason: string | null;
    at: Generated<Date>;
  };
  calendar_slots: {
    id: string;
    listing_id: string;
    period: Range;
    kind: 'BOOKING' | 'BLOCK';
    ref_id: string | null;
    reason: string | null;
    created_by: string | null;
    active: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
