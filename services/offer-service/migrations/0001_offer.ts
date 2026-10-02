import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

const LIVE = sql.raw(`('SUBMITTED','COUNTERED_BY_BUYER','COUNTERED_BY_SELLER')`);
const OFFER_STATUSES = sql.raw(
  `('SUBMITTED','COUNTERED_BY_BUYER','COUNTERED_BY_SELLER','ACCEPTED','REJECTED','WITHDRAWN','EXPIRED','CANCELLED')`,
);

export const m0001Offer: Migration = {
  name: '0001_offer',
  async up(trx) {
    // Projection of demand's needs. accepted_quantity is maintained HERE by this service's own
    // acceptances and is the authority for exclusive acceptance (row-locked on accept).
    await sql`
      create table need_projection (
        need_id uuid primary key,
        requester_id uuid not null,
        mode text not null check (mode in ('BUY','RENT','BORROW','HIRE','SOURCE')),
        category_id uuid not null,
        title text not null,
        quantity int not null check (quantity >= 1),
        max_offers int not null check (max_offers >= 1),
        expires_at timestamptz not null,
        status text not null check (status in
          ('DRAFT','OPEN','PAUSED','FULFILLING','FULFILLED','CLOSED','EXPIRED','HIDDEN')),
        accepted_quantity int not null default 0 check (accepted_quantity >= 0),
        updated_at timestamptz not null default now()
      )`.execute(trx);

    await sql`
      create table listing_projection (
        listing_id uuid primary key,
        seller_id uuid not null,
        available boolean not null,
        updated_at timestamptz not null default now()
      )`.execute(trx);

    await sql`
      create table offers (
        id uuid primary key,
        need_id uuid not null,
        buyer_id uuid not null,
        seller_id uuid not null,
        listing_id uuid,
        status text not null check (status in ${OFFER_STATUSES}),
        price_amount bigint not null check (price_amount >= 0),
        currency char(3) not null default 'BDT',
        quantity int not null check (quantity >= 1),
        condition text check (condition in ('NEW','USED','REFURBISHED')),
        availability_from date,
        delivery_terms jsonb not null,
        mode_terms jsonb not null,
        description text check (char_length(description) <= 2000),
        attachment_media_ids uuid[] not null default '{}'
          check (cardinality(attachment_media_ids) <= 5),
        expires_at timestamptz not null,
        current_round int not null default 1 check (current_round >= 1),
        awaiting text not null check (awaiting in ('BUYER','SELLER')),
        hidden boolean not null default false,
        -- millisecond precision: the keyset cursor carries a JS Date
        created_at timestamptz not null default date_trunc('milliseconds', now()),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check (buyer_id <> seller_id)
      )`.execute(trx);
    // One live offer per seller per need.
    await sql`create unique index offers_one_live_per_seller on offers (need_id, seller_id) where status in ${LIVE}`.execute(
      trx,
    );
    // Compare view (newest / cheapest) and counting live+accepted offers on a need.
    await sql`create index offers_need_newest_idx on offers (need_id, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index offers_need_price_idx on offers (need_id, price_amount, id)`.execute(
      trx,
    );
    await sql`create index offers_need_status_idx on offers (need_id, status)`.execute(trx);
    // Seller's own list.
    await sql`create index offers_seller_newest_idx on offers (seller_id, created_at desc, id desc)`.execute(
      trx,
    );
    // Expiry sweep.
    await sql`create index offers_live_expiry_idx on offers (expires_at) where status in ${LIVE}`.execute(
      trx,
    );

    // Immutable negotiation history: one row per proposal (round 1 is the submission).
    await sql`
      create table offer_rounds (
        offer_id uuid not null references offers (id) on delete cascade,
        round int not null check (round >= 1),
        proposed_by text not null check (proposed_by in ('BUYER','SELLER')),
        price_amount bigint not null check (price_amount >= 0),
        currency char(3) not null default 'BDT',
        quantity int not null check (quantity >= 1),
        terms jsonb not null,
        message text check (char_length(message) <= 1000),
        created_at timestamptz not null default now(),
        primary key (offer_id, round)
      )`.execute(trx);

    await sql`
      create table offer_status_history (
        id uuid primary key,
        offer_id uuid not null references offers (id) on delete cascade,
        from_status text check (from_status in ${OFFER_STATUSES}),
        to_status text not null check (to_status in ${OFFER_STATUSES}),
        reason text not null,
        actor_id uuid,
        created_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index offer_status_history_offer_idx on offer_status_history (offer_id, created_at)`.execute(
      trx,
    );
  },
  async down(trx) {
    await sql`drop table offer_status_history`.execute(trx);
    await sql`drop table offer_rounds`.execute(trx);
    await sql`drop table offers`.execute(trx);
    await sql`drop table listing_projection`.execute(trx);
    await sql`drop table need_projection`.execute(trx);
  },
};
