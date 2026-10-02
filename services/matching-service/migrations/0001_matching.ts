import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Matching: Migration = {
  name: '0001_matching',
  async up(trx) {
    // ---- read models built from other services' events (only what matching needs)
    await sql`
      create table categories (
        id uuid primary key,
        parent_id uuid,
        modes text[] not null default '{}',
        active boolean not null default true,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index categories_parent_idx on categories (parent_id)`.execute(trx);

    await sql`
      create table needs (
        need_id uuid primary key,
        requester_id uuid not null,
        mode text not null check (mode in ('BUY','RENT','BORROW','HIRE','SOURCE')),
        category_id uuid not null,
        title text not null,
        quantity int not null check (quantity >= 1),
        budget_min_amount bigint,
        budget_max_amount bigint,
        currency char(3) not null default 'BDT',
        conditions text[] not null default '{}',
        district text not null,
        attributes jsonb not null default '{}',
        expires_at timestamptz not null,
        status text not null default 'OPEN' check (status in
          ('DRAFT','OPEN','PAUSED','FULFILLING','FULFILLED','CLOSED','EXPIRED','HIDDEN')),
        published_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`.execute(trx);
    // Reverse scan: newest OPEN needs per category.
    await sql`create index needs_open_category_idx on needs (category_id, published_at desc, need_id desc) where status = 'OPEN'`.execute(
      trx,
    );

    await sql`
      create table listings (
        listing_id uuid primary key,
        seller_id uuid not null,
        category_id uuid not null,
        kind text not null check (kind in ('PRODUCT','SERVICE','RENTAL')),
        condition text check (condition in ('NEW','USED','REFURBISHED')),
        price_amount bigint not null check (price_amount >= 0),
        currency char(3) not null default 'BDT',
        price_unit text not null check (price_unit in ('TOTAL','PER_UNIT','PER_HOUR','PER_DAY')),
        quantity_available int not null,
        district text not null,
        attributes jsonb not null default '{}',
        delivery_modes text[] not null default '{}',
        available boolean not null default true,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index listings_available_category_idx on listings (category_id) where available`.execute(
      trx,
    );

    await sql`
      create table sellers (
        account_id uuid primary key,
        roles text[] not null default '{}',
        category_ids uuid[] not null default '{}',
        service_districts text[] not null default '{}',
        delivery_modes text[] not null default '{}',
        active boolean not null default false,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index sellers_active_categories_idx on sellers using gin (category_ids) where active`.execute(
      trx,
    );

    await sql`
      create table seller_signals (
        account_id uuid primary key,
        rating_average numeric(3,2),
        rating_count int not null default 0,
        completed_count int not null default 0,
        nid_verified boolean not null default false,
        updated_at timestamptz not null default now()
      )`.execute(trx);

    // ---- owned state
    await sql`
      create table matches (
        id uuid primary key,
        need_id uuid not null,
        seller_id uuid not null,
        listing_id uuid,
        candidate_type text not null check (candidate_type in ('LISTING','SELLER')),
        score numeric(5,2) not null check (score between 0 and 100),
        reasons jsonb not null,
        scorer text not null,
        status text not null default 'NEW' check (status in ('NEW','DISMISSED','RESPONDED','CLOSED')),
        responded_at timestamptz,
        dismissed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check ((candidate_type = 'LISTING') = (listing_id is not null)),
        -- One match per seller per need: the row holds the seller's best candidate.
        unique (need_id, seller_id)
      )`.execute(trx);
    await sql`create index matches_need_score_idx on matches (need_id, score desc, id desc)`.execute(
      trx,
    );
    await sql`create index matches_seller_feed_idx on matches (seller_id, created_at desc, id desc) where status in ('NEW','RESPONDED')`.execute(
      trx,
    );
  },
  async down(trx) {
    await sql`drop table matches`.execute(trx);
    await sql`drop table seller_signals`.execute(trx);
    await sql`drop table sellers`.execute(trx);
    await sql`drop table listings`.execute(trx);
    await sql`drop table needs`.execute(trx);
    await sql`drop table categories`.execute(trx);
  },
};
