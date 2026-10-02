import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Lending: Migration = {
  name: '0001_lending',
  async up(trx) {
    // Provisioned by infra (init.sh). Created here only where we may (dev/test databases);
    // concurrent creation by sibling services' migrations is tolerated.
    await sql`
      do $$ begin
        create extension if not exists btree_gist with schema public;
      exception when unique_violation or duplicate_object or insufficient_privilege then null;
      end $$`.execute(trx);

    await sql`
      create table lend_items (
        id uuid primary key,
        lender_id uuid not null,
        category_id uuid not null,
        title text not null check (char_length(title) between 3 and 120),
        description text not null default '' check (char_length(description) <= 2000),
        condition text not null check (condition in ('NEW','USED','REFURBISHED')),
        district text not null,
        media_ids uuid[] not null default '{}' check (cardinality(media_ids) <= 8),
        deposit_amount bigint check (deposit_amount between 0 and 100000000000),
        currency char(3) not null default 'BDT' check (currency = 'BDT'),
        max_loan_days int not null check (max_loan_days between 1 and 365),
        req_nid_verified boolean not null default false,
        req_min_completed_deals int not null default 0 check (req_min_completed_deals >= 0),
        req_min_rating numeric(3,2) check (req_min_rating between 1 and 5),
        active boolean not null default true,
        hidden boolean not null default false,
        search tsvector generated always as (
          setweight(to_tsvector('simple'::regconfig, title), 'A') ||
          setweight(to_tsvector('simple'::regconfig, description), 'B')
        ) stored,
        -- millisecond precision: the keyset cursor carries a JS ISO timestamp
        created_at timestamptz(3) not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0
      )`.execute(trx);
    // Public browse runs against listed, visible items only, so those indexes are partial.
    await sql`create index lend_items_browse_idx on lend_items (created_at desc, id desc) where active and not hidden`.execute(
      trx,
    );
    await sql`create index lend_items_category_idx on lend_items (category_id, created_at desc, id desc) where active and not hidden`.execute(
      trx,
    );
    await sql`create index lend_items_district_idx on lend_items (district, created_at desc, id desc) where active and not hidden`.execute(
      trx,
    );
    await sql`create index lend_items_search_idx on lend_items using gin (search)`.execute(trx);
    await sql`create index lend_items_lender_idx on lend_items (lender_id, created_at desc, id desc)`.execute(
      trx,
    );

    await sql`
      create table loans (
        id uuid primary key,
        item_id uuid not null references lend_items (id),
        lender_id uuid not null,
        borrower_id uuid not null,
        item_title text not null,
        category_id uuid not null,
        start_at timestamptz not null,
        return_by timestamptz not null,
        period tstzrange generated always as (tstzrange(start_at, return_by, '[)')) stored,
        message text check (char_length(message) <= 500),
        deposit_amount bigint check (deposit_amount between 0 and 100000000000),
        currency char(3) not null default 'BDT' check (currency = 'BDT'),
        status text not null default 'REQUESTED' check (status in (
          'REQUESTED','APPROVED','DECLINED','CANCELLED','EXPIRED',
          'LENT','RETURN_REPORTED','RETURNED','DISPUTED','CLOSED')),
        transaction_id uuid,
        decline_reason text check (char_length(decline_reason) <= 500),
        returned_at timestamptz,
        overdue_notified_at timestamptz,
        created_at timestamptz(3) not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check (borrower_id <> lender_id),
        check (return_by > start_at),
        -- An item cannot be promised twice for overlapping periods, even if the app has a bug.
        constraint loans_no_overlap exclude using gist (item_id with =, period with &&)
          where (status in ('APPROVED','LENT','RETURN_REPORTED'))
      )`.execute(trx);
    // At most one open request per (item, borrower).
    await sql`create unique index loans_open_request_uq on loans (item_id, borrower_id) where status = 'REQUESTED'`.execute(
      trx,
    );
    await sql`create unique index loans_transaction_uq on loans (transaction_id) where transaction_id is not null`.execute(
      trx,
    );
    await sql`create index loans_lender_idx on loans (lender_id, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index loans_borrower_idx on loans (borrower_id, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index loans_status_idx on loans (status, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index loans_expiry_idx on loans (created_at) where status = 'REQUESTED'`.execute(
      trx,
    );
    await sql`create index loans_overdue_idx on loans (return_by) where status in ('LENT','RETURN_REPORTED') and overdue_notified_at is null`.execute(
      trx,
    );

    await sql`
      create table loan_transitions (
        id uuid primary key,
        loan_id uuid not null references loans (id),
        from_status text,
        to_status text not null,
        command text not null,
        actor_id uuid,
        actor_role text not null check (actor_role in ('LENDER','BORROWER','SYSTEM')),
        reason text check (char_length(reason) <= 500),
        at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index loan_transitions_loan_idx on loan_transitions (loan_id, at, id)`.execute(
      trx,
    );
    // History is append-only.
    await sql`
      create function loan_transitions_immutable() returns trigger language plpgsql as $$
      begin raise exception 'loan_transitions is append-only'; end $$`.execute(trx);
    await sql`
      create trigger loan_transitions_no_change before update or delete on loan_transitions
      for each row execute function loan_transitions_immutable()`.execute(trx);

    // Projections owned by other services.
    await sql`
      create table category_projection (
        category_id uuid primary key,
        modes text[] not null,
        active boolean not null,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`
      create table reputation_projection (
        account_id uuid primary key,
        completed_count int not null default 0,
        rating_average numeric(3,2),
        rating_count int not null default 0,
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`
      create table verification_projection (
        account_id uuid primary key,
        nid_verified boolean not null,
        updated_at timestamptz not null default now()
      )`.execute(trx);
  },
  async down(trx) {
    await sql`drop table verification_projection`.execute(trx);
    await sql`drop table reputation_projection`.execute(trx);
    await sql`drop table category_projection`.execute(trx);
    await sql`drop table loan_transitions`.execute(trx);
    await sql`drop function loan_transitions_immutable`.execute(trx);
    await sql`drop table loans`.execute(trx);
    await sql`drop table lend_items`.execute(trx);
  },
};
