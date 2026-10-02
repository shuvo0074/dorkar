import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

/**
 * Read models only (ADR-0010): everything here is rebuildable by replaying the event streams.
 * State projections carry `status_at` (the event's occurredAt) so out-of-order deliveries
 * never move an aggregate backwards.
 */
export const m0001Dashboard: Migration = {
  name: '0001_dashboard',
  async up(trx) {
    // ---------------------------------------------------------------- activity log
    await sql`
      create table activity_log (
        id uuid primary key,
        service text not null,
        occurred_at timestamptz not null,
        actor_id uuid,
        actor_type text not null check (actor_type in ('USER','ADMIN','SYSTEM','ANONYMOUS')),
        action text not null,
        target_type text,
        target_id text,
        request_id text,
        ip_hash text,
        metadata jsonb not null default '{}',
        recorded_at timestamptz not null default now()
      )`.execute(trx);
    // Unfiltered keyset list + retention sweep.
    await sql`create index activity_log_time_idx on activity_log (occurred_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index activity_log_actor_idx on activity_log (actor_id, occurred_at desc, id desc) where actor_id is not null`.execute(
      trx,
    );
    // targetId (with or without targetType) and the user's "about me" view.
    await sql`create index activity_log_target_idx on activity_log (target_id, target_type, occurred_at desc, id desc) where target_id is not null`.execute(
      trx,
    );
    await sql`create index activity_log_target_type_idx on activity_log (target_type, occurred_at desc, id desc) where target_type is not null`.execute(
      trx,
    );
    await sql`create index activity_log_service_idx on activity_log (service, occurred_at desc, id desc)`.execute(
      trx,
    );
    // Action prefix (`transaction.`) as a byte-wise range scan.
    await sql`create index activity_log_action_prefix_idx on activity_log (action text_pattern_ops)`.execute(
      trx,
    );
    await sql`create index activity_log_actor_type_idx on activity_log (actor_type, occurred_at desc, id desc)`.execute(
      trx,
    );

    // Display names for actors (profile.ProfileUpdated). Never phone numbers.
    await sql`
      create table actor_names (
        account_id uuid primary key,
        display_name text not null,
        updated_at timestamptz not null
      )`.execute(trx);

    // ---------------------------------------------------------------- metrics
    await sql`
      create table daily_metrics (
        day date not null,
        metric text not null,
        dimension text not null default '',
        value bigint not null default 0,
        primary key (day, metric, dimension)
      )`.execute(trx);
    await sql`create index daily_metrics_series_idx on daily_metrics (metric, dimension, day)`.execute(
      trx,
    );

    // ---------------------------------------------------------------- state projections
    await sql`
      create table needs (
        need_id uuid primary key,
        requester_id uuid not null,
        status text check (status in (
          'DRAFT','OPEN','PAUSED','FULFILLING','FULFILLED','CLOSED','EXPIRED','HIDDEN')),
        status_at timestamptz,
        published_day date,
        first_offer_at timestamptz
      )`.execute(trx);
    await sql`create index needs_status_idx on needs (status)`.execute(trx);
    await sql`create index needs_requester_open_idx on needs (requester_id) where status = 'OPEN'`.execute(
      trx,
    );
    await sql`create index needs_published_day_idx on needs (published_day) where published_day is not null`.execute(
      trx,
    );

    await sql`
      create table offers (
        offer_id uuid primary key,
        need_id uuid not null,
        buyer_id uuid not null,
        seller_id uuid not null,
        status text check (status in (
          'SUBMITTED','COUNTERED_BY_BUYER','COUNTERED_BY_SELLER','ACCEPTED',
          'REJECTED','WITHDRAWN','EXPIRED','CANCELLED')),
        status_at timestamptz
      )`.execute(trx);
    await sql`create index offers_buyer_idx on offers (buyer_id, status)`.execute(trx);
    await sql`create index offers_seller_idx on offers (seller_id, status)`.execute(trx);

    await sql`
      create table listings (
        listing_id uuid primary key,
        seller_id uuid not null,
        status text check (status in ('ACTIVE','UNAVAILABLE')),
        status_at timestamptz
      )`.execute(trx);
    await sql`create index listings_active_idx on listings (status) where status = 'ACTIVE'`.execute(
      trx,
    );

    await sql`
      create table transactions (
        transaction_id uuid primary key,
        buyer_id uuid not null,
        seller_id uuid not null,
        mode text,
        source_type text not null,
        amount bigint check (amount >= 0),
        status text check (status in (
          'CREATED','CONFIRMED','DELIVERY_PENDING','DELIVERED','HANDED_OVER','RETURN_REPORTED',
          'RETURNED','COMPLETED','CANCELLED','DISPUTED','REFUNDED','EXPIRED')),
        status_at timestamptz,
        completed_at timestamptz,
        gmv_counted boolean not null default false
      )`.execute(trx);
    await sql`create index transactions_status_idx on transactions (status)`.execute(trx);
    await sql`create index transactions_buyer_idx on transactions (buyer_id, status)`.execute(trx);
    await sql`create index transactions_seller_idx on transactions (seller_id, status)`.execute(
      trx,
    );

    await sql`
      create table disputes (
        dispute_id uuid primary key,
        transaction_id uuid not null,
        buyer_id uuid not null,
        seller_id uuid not null,
        status text check (status in (
          'OPEN','AWAITING_RESPONSE','UNDER_REVIEW','RESOLVED','WITHDRAWN')),
        status_at timestamptz
      )`.execute(trx);
    await sql`create index disputes_status_idx on disputes (status)`.execute(trx);
    await sql`create index disputes_buyer_idx on disputes (buyer_id)`.execute(trx);
    await sql`create index disputes_seller_idx on disputes (seller_id)`.execute(trx);

    await sql`
      create table verifications (
        account_id uuid not null,
        kind text not null,
        status text check (status in ('PENDING','VERIFIED','REJECTED','REVOKED','EXPIRED')),
        status_at timestamptz,
        primary key (account_id, kind)
      )`.execute(trx);
    await sql`create index verifications_pending_idx on verifications (kind) where status = 'PENDING'`.execute(
      trx,
    );

    await sql`
      create table auctions (
        auction_id uuid primary key,
        owner_id uuid not null,
        status text check (status in ('OPEN','AWARDED','NO_WINNER','CANCELLED')),
        status_at timestamptz,
        ends_at timestamptz
      )`.execute(trx);
    await sql`create index auctions_status_idx on auctions (status)`.execute(trx);
    await sql`create index auctions_owner_live_idx on auctions (owner_id) where status = 'OPEN'`.execute(
      trx,
    );
    await sql`
      create table auction_bidders (
        auction_id uuid not null,
        bidder_id uuid not null,
        primary key (auction_id, bidder_id)
      )`.execute(trx);
    await sql`create index auction_bidders_bidder_idx on auction_bidders (bidder_id)`.execute(trx);

    await sql`
      create table bookings (
        booking_id uuid primary key,
        listing_id uuid not null,
        owner_id uuid not null,
        renter_id uuid not null,
        status text check (status in (
          'HELD','PENDING_APPROVAL','CONFIRMED','ACTIVE','RETURNED','CLOSED',
          'DECLINED','CANCELLED','EXPIRED')),
        status_at timestamptz,
        start_at timestamptz,
        end_at timestamptz
      )`.execute(trx);
    await sql`create index bookings_status_idx on bookings (status)`.execute(trx);
    await sql`create index bookings_owner_idx on bookings (owner_id, status)`.execute(trx);
    await sql`create index bookings_renter_idx on bookings (renter_id, status)`.execute(trx);

    await sql`
      create table loans (
        loan_id uuid primary key,
        item_id uuid not null,
        lender_id uuid not null,
        borrower_id uuid not null,
        status text check (status in (
          'REQUESTED','APPROVED','DECLINED','CANCELLED','EXPIRED','LENT',
          'RETURN_REPORTED','RETURNED','DISPUTED','CLOSED')),
        status_at timestamptz,
        return_by timestamptz
      )`.execute(trx);
    await sql`create index loans_status_idx on loans (status)`.execute(trx);
    await sql`create index loans_lender_idx on loans (lender_id, status)`.execute(trx);
    await sql`create index loans_borrower_idx on loans (borrower_id, status)`.execute(trx);

    await sql`
      create table reputations (
        account_id uuid primary key,
        rating_average numeric(3,2),
        rating_count int not null default 0,
        completed_count int not null default 0,
        updated_at timestamptz not null
      )`.execute(trx);
  },
  async down(trx) {
    for (const t of [
      'reputations',
      'loans',
      'bookings',
      'auction_bidders',
      'auctions',
      'verifications',
      'disputes',
      'transactions',
      'listings',
      'offers',
      'needs',
      'daily_metrics',
      'actor_names',
      'activity_log',
    ]) {
      await sql`drop table ${sql.id(t)}`.execute(trx);
    }
  },
};
