import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

const MVP_TYPES = `'NEED_MATCHED','OFFER_RECEIVED','OFFER_COUNTERED','OFFER_ACCEPTED','OFFER_REJECTED',
  'OFFER_CLOSED','TRANSACTION_CREATED','TRANSACTION_UPDATED','NEED_EXPIRED',
  'NEED_FULFILLING','REVIEW_RECEIVED','VERIFICATION_UPDATED'`;

const PHASE2_TYPES = `'BID_PLACED','BID_OUTBID','AUCTION_CLOSED','AUCTION_WON','AUCTION_LOST','AUCTION_CANCELLED',
  'BOOKING_REQUESTED','BOOKING_CONFIRMED','BOOKING_DECLINED','BOOKING_EXPIRED','BOOKING_CANCELLED',
  'BOOKING_OVERDUE','LOAN_REQUESTED','LOAN_APPROVED','LOAN_DECLINED','LOAN_EXPIRED','LOAN_OVERDUE',
  'DISPUTE_OPENED','DISPUTE_UPDATED','DISPUTE_RESOLVED','DISPUTE_WITHDRAWN','NEW_MESSAGE'`;

export const m0002PushAndPhase2: Migration = {
  name: '0002_push_and_phase2',
  async up(trx) {
    await sql`alter table notifications drop constraint notifications_type_check`.execute(trx);
    await sql`
      alter table notifications add constraint notifications_type_check
        check (type in (${sql.raw(MVP_TYPES)}, ${sql.raw(PHASE2_TYPES)}))`.execute(trx);

    // Coalescing (NEW_MESSAGE per conversation): at most one unread in-app row per key, so two
    // concurrent events cannot both create one (the loser's inbox transaction retries and merges).
    await sql`alter table notifications add column coalesce_key text check (char_length(coalesce_key) <= 100)`.execute(
      trx,
    );
    await sql`
      create unique index notifications_coalesce_idx
        on notifications (recipient_id, type, coalesce_key)
        where in_app and read_at is null and coalesce_key is not null`.execute(trx);
    // Events merged into an existing notification: keeps them idempotent per (event, recipient, type).
    await sql`
      create table notification_merged_events (
        source_event_id uuid not null,
        recipient_id uuid not null,
        type text not null,
        notification_id uuid not null references notifications (id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (source_event_id, recipient_id, type)
      )`.execute(trx);
    await sql`create index notification_merged_events_notification_idx on notification_merged_events (notification_id)`.execute(
      trx,
    );

    // Existing overrides predate push, whose default is on.
    await sql`alter table notification_preferences add column push boolean not null default true`.execute(
      trx,
    );

    // The raw token is needed to send; its sha256 identifies the device across accounts.
    await sql`
      create table push_devices (
        id uuid primary key,
        account_id uuid not null,
        platform text not null check (platform in ('ANDROID','IOS','WEB')),
        token text not null check (char_length(token) between 1 and 4096),
        token_hash text not null unique,
        active boolean not null default true,
        deactivated_at timestamptz,
        deactivation_reason text check (deactivation_reason in ('LIMIT','INVALID_TOKEN')),
        created_at timestamptz not null default now(),
        last_registered_at timestamptz not null default now()
      )`.execute(trx);
    await sql`
      create index push_devices_account_idx
        on push_devices (account_id, last_registered_at desc, id desc) where active`.execute(trx);
  },
  async down(trx) {
    await sql`drop table push_devices`.execute(trx);
    await sql`alter table notification_preferences drop column push`.execute(trx);
    await sql`drop table notification_merged_events`.execute(trx);
    await sql`drop index notifications_coalesce_idx`.execute(trx);
    await sql`alter table notifications drop column coalesce_key`.execute(trx);
    await sql`delete from notifications where type in (${sql.raw(PHASE2_TYPES)})`.execute(trx);
    await sql`alter table notifications drop constraint notifications_type_check`.execute(trx);
    await sql`
      alter table notifications add constraint notifications_type_check
        check (type in (${sql.raw(MVP_TYPES)}))`.execute(trx);
  },
};
