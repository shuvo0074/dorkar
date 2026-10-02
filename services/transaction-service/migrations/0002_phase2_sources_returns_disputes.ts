import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

/**
 * Phase 2 (ADR-0008, ADR-0009): deals from auctions, bookings and loans; the RENT/BORROW
 * hand-over/return sub-flow; dispute categories and the state to restore on withdrawal;
 * informational deposits. Additive; existing rows keep their meaning.
 */
export const m0002Phase2: Migration = {
  name: '0002_phase2_sources_returns_disputes',
  async up(trx) {
    await sql`alter table transactions drop constraint transactions_source_type_check`.execute(trx);
    await sql`
      alter table transactions add constraint transactions_source_type_check
      check (source_type in ('OFFER','LISTING','AUCTION','BOOKING','LOAN'))`.execute(trx);

    await sql`alter table transactions drop constraint transactions_state_check`.execute(trx);
    await sql`
      alter table transactions add constraint transactions_state_check check (state in (
        'CREATED','CONFIRMED','DELIVERY_PENDING','DELIVERED','HANDED_OVER','RETURN_REPORTED',
        'RETURNED','COMPLETED','CANCELLED','DISPUTED','REFUNDED','EXPIRED'))`.execute(trx);

    await sql`
      alter table transactions
        add column handed_over_at timestamptz,
        add column return_reported_at timestamptz,
        add column returned_at timestamptz,
        add column dispute_category text check (dispute_category in (
          'NOT_RECEIVED','NOT_AS_DESCRIBED','DAMAGED','NOT_RETURNED','PAYMENT','NO_SHOW','OTHER')),
        add column pre_dispute_state text check (pre_dispute_state in (
          'CREATED','CONFIRMED','DELIVERY_PENDING','DELIVERED','HANDED_OVER','RETURN_REPORTED',
          'RETURNED'))`.execute(trx);

    // Disputes opened before this migration: recover the state to restore from the history.
    await sql`
      update transactions t set
        pre_dispute_state = (
          select h.from_state from transaction_transitions h
          where h.transaction_id = t.id and h.to_state = 'DISPUTED'
          order by h.at desc, h.id desc limit 1),
        dispute_category = 'OTHER'
      where t.state = 'DISPUTED'`.execute(trx);

    // Exactly one transaction per source, for every source except LISTING (bought many times).
    await sql`create unique index transactions_source_uq on transactions (source_type, source_id) where source_type <> 'LISTING'`.execute(
      trx,
    );
    await sql`drop index transactions_offer_source_uq`.execute(trx);

    await sql`create index transactions_return_autocomplete_idx on transactions (returned_at) where state = 'RETURNED'`.execute(
      trx,
    );

    // Rental/loan deposits: cash between the parties, recorded for information only.
    await sql`
      create table deposits (
        id uuid primary key,
        transaction_id uuid not null unique references transactions (id),
        amount bigint not null check (amount > 0),
        currency char(3) not null default 'BDT',
        status text not null check (status in ('HELD','RETURNED','FORFEITED')),
        note text check (char_length(note) <= 500),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`.execute(trx);
  },
  async down(trx) {
    await sql`drop table deposits`.execute(trx);
    await sql`drop index transactions_return_autocomplete_idx`.execute(trx);
    await sql`create unique index transactions_offer_source_uq on transactions (source_type, source_id) where source_type = 'OFFER'`.execute(
      trx,
    );
    await sql`drop index transactions_source_uq`.execute(trx);
    await sql`
      alter table transactions
        drop column pre_dispute_state,
        drop column dispute_category,
        drop column returned_at,
        drop column return_reported_at,
        drop column handed_over_at`.execute(trx);
    // Only reversible while no Phase 2 rows exist; the constraints fail loudly otherwise.
    await sql`alter table transactions drop constraint transactions_state_check`.execute(trx);
    await sql`
      alter table transactions add constraint transactions_state_check check (state in (
        'CREATED','CONFIRMED','DELIVERY_PENDING','DELIVERED','COMPLETED',
        'CANCELLED','DISPUTED','REFUNDED','EXPIRED'))`.execute(trx);
    await sql`alter table transactions drop constraint transactions_source_type_check`.execute(trx);
    await sql`
      alter table transactions add constraint transactions_source_type_check
      check (source_type in ('OFFER','LISTING'))`.execute(trx);
  },
};
