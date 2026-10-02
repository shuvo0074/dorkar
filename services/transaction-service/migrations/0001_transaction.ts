import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Transaction: Migration = {
  name: '0001_transaction',
  async up(trx) {
    await sql`
      create table transactions (
        id uuid primary key,
        source_type text not null check (source_type in ('OFFER','LISTING')),
        source_id uuid not null,
        listing_id uuid,
        need_id uuid,
        buyer_id uuid not null,
        seller_id uuid not null,
        mode text not null check (mode in ('BUY','RENT','BORROW','HIRE','SOURCE')),
        amount bigint not null check (amount >= 0),
        currency char(3) not null default 'BDT',
        quantity int not null check (quantity >= 1),
        terms_snapshot jsonb not null default '{}',
        state text not null default 'CREATED' check (state in (
          'CREATED','CONFIRMED','DELIVERY_PENDING','DELIVERED','COMPLETED',
          'CANCELLED','DISPUTED','REFUNDED','EXPIRED')),
        buyer_confirmed_at timestamptz,
        seller_confirmed_at timestamptz,
        delivered_at timestamptz,
        completed_at timestamptz,
        cancel_reason text check (char_length(cancel_reason) <= 500),
        dispute_reason text check (char_length(dispute_reason) <= 500),
        -- millisecond precision: the keyset cursor carries a JS ISO timestamp
        created_at timestamptz(3) not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check (buyer_id <> seller_id)
      )`.execute(trx);
    // Exactly one transaction per accepted offer. A listing can be bought many times (stock),
    // so the uniqueness is scoped to OFFER-sourced rows.
    await sql`create unique index transactions_offer_source_uq on transactions (source_type, source_id) where source_type = 'OFFER'`.execute(
      trx,
    );
    await sql`create index transactions_buyer_idx on transactions (buyer_id, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index transactions_seller_idx on transactions (seller_id, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index transactions_state_idx on transactions (state, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index transactions_expiry_idx on transactions (created_at) where state = 'CREATED'`.execute(
      trx,
    );
    await sql`create index transactions_autocomplete_idx on transactions (delivered_at) where state = 'DELIVERED'`.execute(
      trx,
    );

    await sql`
      create table transaction_transitions (
        id uuid primary key,
        transaction_id uuid not null references transactions (id),
        from_state text not null,
        to_state text not null,
        command text not null,
        actor_id uuid,
        actor_role text not null check (actor_role in ('BUYER','SELLER','ADMIN','SYSTEM')),
        reason text check (char_length(reason) <= 500),
        at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index transaction_transitions_tx_idx on transaction_transitions (transaction_id, at, id)`.execute(
      trx,
    );
    // History is append-only.
    await sql`
      create function transaction_transitions_immutable() returns trigger language plpgsql as $$
      begin raise exception 'transaction_transitions is append-only'; end $$`.execute(trx);
    await sql`
      create trigger transaction_transitions_no_change before update or delete on transaction_transitions
      for each row execute function transaction_transitions_immutable()`.execute(trx);

    await sql`
      create table payments (
        id uuid primary key,
        transaction_id uuid not null unique references transactions (id),
        provider text not null check (provider in ('CASH')),
        status text not null check (status in ('PENDING','PAID','REFUNDED','FAILED')),
        amount bigint not null check (amount >= 0),
        currency char(3) not null default 'BDT',
        provider_ref text,
        note text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`.execute(trx);

    await sql`
      create table deliveries (
        id uuid primary key,
        transaction_id uuid not null unique references transactions (id),
        method text not null check (method in ('BUYER_PICKUP','SELLER_DELIVERY','SELF_ARRANGED','ON_SITE')),
        status text not null check (status in ('ARRANGED','DELIVERED','CANCELLED')),
        notes text check (char_length(notes) <= 500),
        scheduled_for timestamptz,
        provider text not null check (provider in ('SELF_ARRANGED')),
        provider_ref text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`.execute(trx);

    // Projection of catalog listings, for direct purchases.
    await sql`
      create table listing_projection (
        listing_id uuid primary key,
        seller_id uuid not null,
        kind text not null check (kind in ('PRODUCT','SERVICE','RENTAL')),
        title text not null,
        price_amount bigint not null,
        currency char(3) not null default 'BDT',
        price_unit text not null check (price_unit in ('TOTAL','PER_UNIT','PER_HOUR','PER_DAY')),
        quantity_available int not null,
        delivery_modes text[] not null default '{}',
        available boolean not null default true,
        updated_at timestamptz not null default now()
      )`.execute(trx);
  },
  async down(trx) {
    await sql`drop table listing_projection`.execute(trx);
    await sql`drop table deliveries`.execute(trx);
    await sql`drop table payments`.execute(trx);
    await sql`drop table transaction_transitions`.execute(trx);
    await sql`drop function transaction_transitions_immutable`.execute(trx);
    await sql`drop table transactions`.execute(trx);
  },
};
