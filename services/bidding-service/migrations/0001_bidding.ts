import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

const AUCTION_STATUSES = sql.raw(
  `('SCHEDULED','OPEN','CLOSING','AWARDED','SETTLED','NO_WINNER','CANCELLED')`,
);
const LIVE = sql.raw(`('SCHEDULED','OPEN','CLOSING')`);
const BID_STATUSES = sql.raw(`('LEADING','OUTBID','RETRACTED','WON','LOST')`);
const MODES = sql.raw(`('BUY','RENT','BORROW','HIRE','SOURCE')`);

export const m0001Bidding: Migration = {
  name: '0001_bidding',
  async up(trx) {
    // ------------------------------------------------------------ projections
    // catalog's listings (FORWARD auction subjects).
    await sql`
      create table listing_projection (
        listing_id uuid primary key,
        seller_id uuid not null,
        category_id uuid not null,
        kind text not null check (kind in ('PRODUCT','SERVICE','RENTAL')),
        title text not null,
        district text not null,
        price_amount bigint not null,
        quantity_available int not null,
        available boolean not null,
        updated_at timestamptz not null default now()
      )`.execute(trx);

    // demand's needs (REVERSE auction subjects).
    await sql`
      create table need_projection (
        need_id uuid primary key,
        requester_id uuid not null,
        mode text not null check (mode in ${MODES}),
        category_id uuid not null,
        title text not null,
        district text not null,
        budget_max_amount bigint,
        quantity int not null check (quantity >= 1),
        status text not null check (status in
          ('DRAFT','OPEN','PAUSED','FULFILLING','FULFILLED','CLOSED','EXPIRED','HIDDEN')),
        updated_at timestamptz not null default now()
      )`.execute(trx);

    // ------------------------------------------------------------ auctions
    await sql`
      create table auctions (
        id uuid primary key,
        kind text not null check (kind in ('FORWARD','REVERSE')),
        owner_id uuid not null,
        subject_type text not null check (subject_type in ('LISTING','NEED')),
        subject_id uuid not null,
        category_id uuid not null,
        title text not null,
        district text not null,
        -- FORWARD sells (BUY); REVERSE inherits the need's mode (SOURCE or BUY).
        mode text not null check (mode in ${MODES}),
        quantity int not null check (quantity >= 1),
        currency char(3) not null default 'BDT',
        start_price_amount bigint not null check (start_price_amount >= 0),
        -- Never shown to bidders; only whether it is met.
        reserve_price_amount bigint check (reserve_price_amount >= 0),
        min_increment_amount bigint not null check (min_increment_amount > 0),
        starts_at timestamptz not null,
        ends_at timestamptz(3) not null,
        anti_snipe_seconds int not null check (anti_snipe_seconds between 0 and 600),
        status text not null check (status in ${AUCTION_STATUSES}),
        leading_bid_id uuid,
        leading_amount bigint,
        bid_count int not null default 0 check (bid_count >= 0),
        hidden boolean not null default false,
        cancel_reason text check (char_length(cancel_reason) <= 500),
        closed_at timestamptz,
        transaction_id uuid,
        -- millisecond precision: the keyset cursor carries a JS Date
        created_at timestamptz not null default date_trunc('milliseconds', now()),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check (ends_at > starts_at),
        check ((kind = 'FORWARD' and subject_type = 'LISTING')
            or (kind = 'REVERSE' and subject_type = 'NEED')),
        check ((leading_bid_id is null) = (leading_amount is null))
      )`.execute(trx);
    // At most one live auction per subject.
    await sql`create unique index auctions_one_live_per_subject on auctions (subject_type, subject_id) where status in ${LIVE}`.execute(
      trx,
    );
    // Public browse: ending soonest, filtered by status / kind / category / district.
    await sql`create index auctions_browse_idx on auctions (status, ends_at, id) where hidden = false`.execute(
      trx,
    );
    await sql`create index auctions_browse_category_idx on auctions (category_id, status, ends_at, id) where hidden = false`.execute(
      trx,
    );
    await sql`create index auctions_browse_district_idx on auctions (district, status, ends_at, id) where hidden = false`.execute(
      trx,
    );
    // Owner's and admin lists (newest first).
    await sql`create index auctions_owner_idx on auctions (owner_id, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index auctions_admin_idx on auctions (status, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index auctions_created_idx on auctions (created_at desc, id desc)`.execute(
      trx,
    );
    // Jobs: open due / close due.
    await sql`create index auctions_due_open_idx on auctions (starts_at) where status = 'SCHEDULED'`.execute(
      trx,
    );
    await sql`create index auctions_due_close_idx on auctions (ends_at) where status = 'OPEN'`.execute(
      trx,
    );
    // Subject lookups (cancel on subject gone).
    await sql`create index auctions_subject_idx on auctions (subject_type, subject_id)`.execute(
      trx,
    );

    // Stable per-auction bidder aliases ("Bidder 3"), so bids never reveal account ids.
    await sql`
      create table auction_bidders (
        auction_id uuid not null references auctions (id) on delete cascade,
        bidder_id uuid not null,
        alias int not null check (alias >= 1),
        created_at timestamptz not null default now(),
        primary key (auction_id, bidder_id),
        unique (auction_id, alias)
      )`.execute(trx);

    // ------------------------------------------------------------ bids
    await sql`
      create table bids (
        id uuid primary key,
        -- Placement order: assigned under the auction row lock, so it is the serialization order.
        seq bigint generated always as identity unique,
        auction_id uuid not null references auctions (id) on delete cascade,
        bidder_id uuid not null,
        amount bigint not null check (amount >= 0),
        currency char(3) not null default 'BDT',
        status text not null check (status in ${BID_STATUSES}),
        idempotency_key text,
        placed_at timestamptz not null,
        retracted_at timestamptz,
        updated_at timestamptz not null default now(),
        unique (auction_id, bidder_id, idempotency_key)
      )`.execute(trx);
    // Exactly one leader per auction, enforced by the database.
    await sql`create unique index bids_one_leader on bids (auction_id) where status = 'LEADING'`.execute(
      trx,
    );
    await sql`create index bids_auction_seq_idx on bids (auction_id, seq desc)`.execute(trx);
    await sql`create index bids_bidder_seq_idx on bids (bidder_id, seq desc)`.execute(trx);
    // Re-electing a leader after a retraction.
    await sql`create index bids_auction_outbid_idx on bids (auction_id, amount) where status = 'OUTBID'`.execute(
      trx,
    );

    // ------------------------------------------------------------ history (append-only)
    await sql`
      create table auction_status_history (
        id uuid primary key,
        auction_id uuid not null,
        from_status text check (from_status in ${AUCTION_STATUSES}),
        to_status text not null check (to_status in ${AUCTION_STATUSES}),
        reason text not null,
        actor_id uuid,
        created_at timestamptz not null default clock_timestamp()
      )`.execute(trx);
    await sql`create index auction_status_history_auction_idx on auction_status_history (auction_id, created_at)`.execute(
      trx,
    );
    await sql`
      create function auction_status_history_append_only() returns trigger
      language plpgsql as $$
      begin
        raise exception 'auction_status_history is append-only';
      end $$`.execute(trx);
    await sql`
      create trigger auction_status_history_no_mutation
      before update or delete on auction_status_history
      for each row execute function auction_status_history_append_only()`.execute(trx);
  },
  async down(trx) {
    await sql`drop table auction_status_history`.execute(trx);
    await sql`drop function auction_status_history_append_only()`.execute(trx);
    await sql`drop table bids`.execute(trx);
    await sql`drop table auction_bidders`.execute(trx);
    await sql`drop table auctions`.execute(trx);
    await sql`drop table need_projection`.execute(trx);
    await sql`drop table listing_projection`.execute(trx);
  },
};
