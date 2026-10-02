import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Catalog: Migration = {
  name: '0001_catalog',
  async up(trx) {
    await sql`
      create table categories (
        id uuid primary key,
        parent_id uuid references categories (id),
        slug text not null unique
          check (char_length(slug) <= 60 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
        name_en text not null check (char_length(name_en) between 1 and 80),
        name_bn text not null check (char_length(name_bn) between 1 and 80),
        modes text[] not null
          check (cardinality(modes) > 0 and modes <@ array['BUY','RENT','BORROW','HIRE','SOURCE']::text[]),
        attribute_schema jsonb not null default '{"properties":{},"required":[]}',
        sort int not null default 0,
        active boolean not null default true,
        version int not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check (parent_id is distinct from id)
      )`.execute(trx);
    await sql`create index categories_parent_idx on categories (parent_id, sort)`.execute(trx);

    await sql`
      create table listings (
        id uuid primary key,
        seller_id uuid not null,
        category_id uuid not null references categories (id),
        kind text not null check (kind in ('PRODUCT','SERVICE','RENTAL')),
        condition text check (condition in ('NEW','USED','REFURBISHED')),
        title text not null check (char_length(title) between 3 and 120),
        description text not null default '' check (char_length(description) <= 4000),
        price_amount bigint not null check (price_amount between 0 and 100000000000),
        currency char(3) not null default 'BDT' check (currency = 'BDT'),
        price_unit text not null check (price_unit in ('TOTAL','PER_UNIT','PER_HOUR','PER_DAY')),
        quantity_available int not null default 1 check (quantity_available >= 0),
        attributes jsonb not null default '{}',
        district text not null,
        area text check (char_length(area) <= 80),
        delivery_modes text[] not null default '{}',
        media_ids uuid[] not null default '{}' check (cardinality(media_ids) <= 10),
        status text not null default 'DRAFT'
          check (status in ('DRAFT','PUBLISHED','PAUSED','SOLD_OUT','WITHDRAWN','HIDDEN')),
        hidden_from text check (hidden_from in ('PUBLISHED','PAUSED','SOLD_OUT')),
        hidden_reason text check (char_length(hidden_reason) <= 500),
        search tsvector generated always as (
          setweight(to_tsvector('simple'::regconfig, title), 'A') ||
          setweight(to_tsvector('simple'::regconfig, description), 'B')
        ) stored,
        published_at timestamptz,
        created_at timestamptz not null default date_trunc('milliseconds', now()),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check ((status = 'HIDDEN') = (hidden_from is not null)),
        check (status = 'DRAFT' or status = 'WITHDRAWN' or published_at is not null)
      )`.execute(trx);

    // Public search: every filter runs against PUBLISHED rows only, so all indexes are partial.
    await sql`create index listings_pub_newest_idx on listings (published_at desc, id desc) where status = 'PUBLISHED'`.execute(
      trx,
    );
    await sql`create index listings_pub_price_idx on listings (price_amount, id) where status = 'PUBLISHED'`.execute(
      trx,
    );
    await sql`create index listings_pub_category_idx on listings (category_id, published_at desc, id desc) where status = 'PUBLISHED'`.execute(
      trx,
    );
    await sql`create index listings_pub_category_price_idx on listings (category_id, price_amount, id) where status = 'PUBLISHED'`.execute(
      trx,
    );
    await sql`create index listings_pub_district_idx on listings (district, published_at desc, id desc) where status = 'PUBLISHED'`.execute(
      trx,
    );
    await sql`create index listings_pub_kind_idx on listings (kind, condition, published_at desc, id desc) where status = 'PUBLISHED'`.execute(
      trx,
    );
    await sql`create index listings_search_idx on listings using gin (search)`.execute(trx);
    await sql`create index listings_attributes_idx on listings using gin (attributes jsonb_path_ops)`.execute(
      trx,
    );
    // Owner's "my listings".
    await sql`create index listings_seller_idx on listings (seller_id, created_at desc, id desc)`.execute(
      trx,
    );

    await sql`
      create table listing_status_history (
        id uuid primary key,
        listing_id uuid not null references listings (id),
        from_status text,
        to_status text not null,
        actor_id uuid,
        actor_type text not null check (actor_type in ('USER','ADMIN','SYSTEM')),
        reason text,
        occurred_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index listing_status_history_listing_idx on listing_status_history (listing_id, occurred_at)`.execute(
      trx,
    );
    await sql`
      create function listing_status_history_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'listing_status_history is append-only';
      end $$`.execute(trx);
    await sql`
      create trigger listing_status_history_no_update_delete
        before update or delete or truncate on listing_status_history
        for each statement execute function listing_status_history_append_only()`.execute(trx);
  },
  async down(trx) {
    await sql`drop table listing_status_history`.execute(trx);
    await sql`drop function listing_status_history_append_only()`.execute(trx);
    await sql`drop table listings`.execute(trx);
    await sql`drop table categories`.execute(trx);
  },
};
