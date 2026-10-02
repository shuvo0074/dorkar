import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

const STATUSES = sql.raw(
  `'DRAFT','OPEN','PAUSED','FULFILLING','FULFILLED','CLOSED','EXPIRED','HIDDEN'`,
);

export const m0001Demand: Migration = {
  name: '0001_demand',
  async up(trx) {
    // Projection of catalog categories (CatalogEvents.CategoryUpserted).
    await sql`
      create table categories (
        id uuid primary key,
        parent_id uuid,
        slug text not null,
        name_en text not null,
        name_bn text not null,
        modes text[] not null default '{}',
        attribute_schema jsonb not null default '{"properties":{},"required":[]}',
        active boolean not null default true,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index categories_parent_idx on categories (parent_id)`.execute(trx);

    await sql`
      create table needs (
        id uuid primary key,
        requester_id uuid not null,
        mode text not null check (mode in ('BUY','RENT','BORROW','HIRE','SOURCE')),
        category_id uuid not null,
        title text not null check (char_length(title) between 5 and 120),
        description text check (char_length(description) <= 2000),
        quantity int not null check (quantity >= 1),
        budget_min_amount bigint check (budget_min_amount >= 0),
        budget_max_amount bigint check (budget_max_amount >= 0),
        currency char(3) not null default 'BDT' check (currency = 'BDT'),
        budget_flexible boolean not null default false,
        conditions text[] not null default '{}',
        attributes jsonb not null default '{}',
        mode_terms jsonb not null default '{}',
        district text not null,
        area text check (char_length(area) <= 80),
        delivery_pref text not null default 'EITHER' check (delivery_pref in ('PICKUP','DELIVERY','EITHER')),
        required_by date,
        ttl_days int check (ttl_days >= 1),
        expires_at timestamptz,
        renewals int not null default 0 check (renewals >= 0),
        max_offers int not null check (max_offers >= 1),
        visibility text not null default 'PUBLIC' check (visibility in ('PUBLIC','MATCHED_ONLY')),
        status text not null default 'DRAFT' check (status in (${STATUSES})),
        status_before_hidden text check (status_before_hidden in (${STATUSES})),
        offer_count int not null default 0 check (offer_count >= 0),
        accepted_quantity int not null default 0 check (accepted_quantity >= 0),
        search tsvector generated always as (
          setweight(to_tsvector('simple', title), 'A') ||
          setweight(to_tsvector('simple', coalesce(description, '')), 'B')
        ) stored,
        published_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check (budget_min_amount is null or budget_max_amount is null or budget_min_amount <= budget_max_amount),
        check (status = 'DRAFT' or expires_at is not null)
      )`.execute(trx);

    // Public feed: OPEN + PUBLIC, newest first, with the common filters.
    await sql`
      create index needs_feed_idx on needs (published_at desc, id desc)
      where status = 'OPEN' and visibility = 'PUBLIC'`.execute(trx);
    await sql`
      create index needs_feed_category_idx on needs (category_id, published_at desc, id desc)
      where status = 'OPEN' and visibility = 'PUBLIC'`.execute(trx);
    await sql`
      create index needs_feed_district_idx on needs (district, published_at desc, id desc)
      where status = 'OPEN' and visibility = 'PUBLIC'`.execute(trx);
    await sql`
      create index needs_feed_mode_idx on needs (mode, published_at desc, id desc)
      where status = 'OPEN' and visibility = 'PUBLIC'`.execute(trx);
    await sql`
      create index needs_feed_budget_idx on needs (budget_max_amount)
      where status = 'OPEN' and visibility = 'PUBLIC'`.execute(trx);
    await sql`create index needs_search_idx on needs using gin (search)`.execute(trx);
    await sql`create index needs_attributes_idx on needs using gin (attributes jsonb_path_ops)`.execute(
      trx,
    );
    // Owner lists and the open-need limit.
    await sql`create index needs_requester_idx on needs (requester_id, id desc)`.execute(trx);
    await sql`create index needs_requester_status_idx on needs (requester_id, status)`.execute(trx);
    // Expiry job.
    await sql`
      create index needs_expiry_idx on needs (status, expires_at)
      where status in ('OPEN','PAUSED')`.execute(trx);

    await sql`
      create table need_status_history (
        id bigint generated always as identity primary key,
        need_id uuid not null references needs (id),
        from_status text check (from_status in (${STATUSES})),
        to_status text not null check (to_status in (${STATUSES})),
        actor_id uuid,
        reason text not null,
        at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index need_status_history_need_idx on need_status_history (need_id, id)`.execute(
      trx,
    );
    // Append-only.
    await sql`
      create function need_status_history_immutable() returns trigger language plpgsql as $$
      begin raise exception 'need_status_history is append-only'; end $$`.execute(trx);
    await sql`
      create trigger need_status_history_no_change before update or delete on need_status_history
      for each row execute function need_status_history_immutable()`.execute(trx);

    // Accepted offers (from offer events) so cancellations and completions can be reconciled.
    await sql`
      create table accepted_offers (
        offer_id uuid primary key,
        need_id uuid not null,
        quantity int not null check (quantity >= 1),
        status text not null default 'ACCEPTED' check (status in ('ACCEPTED','CANCELLED')),
        completed boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index accepted_offers_need_idx on accepted_offers (need_id)`.execute(trx);

    // Sellers matched to a need (MatchingEvents.MatchFound): who may see MATCHED_ONLY needs.
    await sql`
      create table need_matches (
        need_id uuid not null,
        seller_id uuid not null,
        created_at timestamptz not null default now(),
        primary key (need_id, seller_id)
      )`.execute(trx);
  },
  async down(trx) {
    await sql`drop table need_matches`.execute(trx);
    await sql`drop table accepted_offers`.execute(trx);
    await sql`drop table need_status_history`.execute(trx);
    await sql`drop function need_status_history_immutable()`.execute(trx);
    await sql`drop table needs`.execute(trx);
    await sql`drop table categories`.execute(trx);
  },
};
