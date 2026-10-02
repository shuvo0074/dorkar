import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

const BOOKING_STATUSES = sql.raw(
  `'HELD','PENDING_APPROVAL','CONFIRMED','ACTIVE','RETURNED','CLOSED','DECLINED','CANCELLED','EXPIRED'`,
);

export const m0001Rental: Migration = {
  name: '0001_rental',
  async up(trx) {
    // The extension is installed by infra (init.sh). `if not exists` on an installed extension
    // is a no-op that needs no privilege; on a bare test database it installs it. Concurrent
    // test files may race to create it, hence the exception guard.
    await sql`
      do $$ begin
        create extension if not exists btree_gist with schema public;
      exception when unique_violation or duplicate_object then null;
      end $$`.execute(trx);

    // Projection of catalog RENTAL listings.
    await sql`
      create table listing_projection (
        listing_id uuid primary key,
        seller_id uuid not null,
        category_id uuid not null,
        title text not null,
        district text not null,
        price_amount bigint not null check (price_amount >= 0),
        currency char(3) not null default 'BDT',
        price_unit text not null check (price_unit in ('TOTAL','PER_UNIT','PER_HOUR','PER_DAY')),
        available boolean not null default true,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index listing_projection_seller_idx on listing_projection (seller_id)`.execute(
      trx,
    );

    // One row per rental listing; defaults apply when there is none.
    await sql`
      create table rental_terms (
        listing_id uuid primary key,
        instant_book boolean not null default false,
        min_duration_hours int not null default 24 check (min_duration_hours between 1 and 8760),
        max_duration_days int not null default 30 check (max_duration_days between 1 and 365),
        deposit_amount bigint check (deposit_amount >= 0),
        deposit_currency char(3),
        advance_notice_hours int not null default 12 check (advance_notice_hours between 0 and 720),
        buffer_hours int not null default 0 check (buffer_hours between 0 and 168),
        cancellation_note text check (char_length(cancellation_note) <= 500),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check ((deposit_amount is null) = (deposit_currency is null)),
        check (min_duration_hours <= max_duration_days * 24)
      )`.execute(trx);

    await sql`
      create table bookings (
        id uuid primary key,
        listing_id uuid not null,
        owner_id uuid not null,
        renter_id uuid not null,
        start_at timestamptz not null,
        end_at timestamptz not null,
        status text not null check (status in (${BOOKING_STATUSES})),
        hold_expires_at timestamptz,
        amount bigint not null check (amount >= 0),
        currency char(3) not null default 'BDT',
        deposit_amount bigint check (deposit_amount >= 0),
        terms_snapshot jsonb not null default '{}',
        note text check (char_length(note) <= 500),
        decline_reason text check (char_length(decline_reason) <= 500),
        cancel_reason text check (char_length(cancel_reason) <= 500),
        transaction_id uuid,
        transaction_state text,
        disputed boolean not null default false,
        overdue_notified_at timestamptz,
        -- millisecond precision: the keyset cursor carries a JS ISO timestamp
        created_at timestamptz(3) not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check (end_at > start_at),
        check (owner_id <> renter_id),
        check (status not in ('HELD','PENDING_APPROVAL') or hold_expires_at is not null)
      )`.execute(trx);
    await sql`create index bookings_renter_idx on bookings (renter_id, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index bookings_owner_idx on bookings (owner_id, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index bookings_status_idx on bookings (status, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index bookings_all_idx on bookings (created_at desc, id desc)`.execute(trx);
    await sql`create index bookings_hold_expiry_idx on bookings (hold_expires_at) where status in ('HELD','PENDING_APPROVAL')`.execute(
      trx,
    );
    await sql`create index bookings_overdue_idx on bookings (end_at) where status = 'ACTIVE' and overdue_notified_at is null`.execute(
      trx,
    );
    await sql`create unique index bookings_transaction_uq on bookings (transaction_id) where transaction_id is not null`.execute(
      trx,
    );

    await sql`
      create table booking_transitions (
        id uuid primary key,
        booking_id uuid not null references bookings (id),
        from_status text not null check (from_status in (${BOOKING_STATUSES})),
        to_status text not null check (to_status in (${BOOKING_STATUSES})),
        command text not null,
        actor_id uuid,
        actor_role text not null check (actor_role in ('RENTER','OWNER','SYSTEM','TRANSACTION')),
        reason text check (char_length(reason) <= 500),
        at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index booking_transitions_booking_idx on booking_transitions (booking_id, at, id)`.execute(
      trx,
    );
    await sql`
      create function booking_transitions_immutable() returns trigger language plpgsql as $$
      begin raise exception 'booking_transitions is append-only'; end $$`.execute(trx);
    await sql`
      create trigger booking_transitions_no_change before update or delete on booking_transitions
      for each row execute function booking_transitions_immutable()`.execute(trx);

    // The calendar. Bookings (period widened by the buffer) and owner blocks share one table so
    // a single exclusion constraint makes overlaps impossible, whatever the application does.
    await sql`
      create table calendar_slots (
        id uuid primary key,
        listing_id uuid not null,
        period tstzrange not null,
        kind text not null check (kind in ('BOOKING','BLOCK')),
        ref_id uuid,
        reason text check (char_length(reason) <= 200),
        created_by uuid,
        active boolean not null default true,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check (not isempty(period) and not lower_inf(period) and not upper_inf(period)),
        check (lower_inc(period) and not upper_inc(period)),
        check (kind = 'BLOCK' or ref_id is not null),
        exclude using gist (listing_id with =, period with &&) where (active)
      )`.execute(trx);
    await sql`create unique index calendar_slots_booking_uq on calendar_slots (ref_id) where kind = 'BOOKING'`.execute(
      trx,
    );
    await sql`create index calendar_slots_blocks_idx on calendar_slots (listing_id, lower(period)) where kind = 'BLOCK' and active`.execute(
      trx,
    );
  },
  async down(trx) {
    await sql`drop table calendar_slots`.execute(trx);
    await sql`drop table booking_transitions`.execute(trx);
    await sql`drop function booking_transitions_immutable`.execute(trx);
    await sql`drop table bookings`.execute(trx);
    await sql`drop table rental_terms`.execute(trx);
    await sql`drop table listing_projection`.execute(trx);
  },
};
