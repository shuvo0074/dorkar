import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Notification: Migration = {
  name: '0001_notification',
  async up(trx) {
    // One row per (source event, recipient, type): redelivered or replayed events never notify twice.
    // `in_app = false` rows exist only to carry an out-of-band delivery (user turned the inbox
    // entry off but kept SMS); they are never listed.
    await sql`
      create table notifications (
        id uuid primary key,
        recipient_id uuid not null,
        type text not null check (type in (
          'NEED_MATCHED','OFFER_RECEIVED','OFFER_COUNTERED','OFFER_ACCEPTED','OFFER_REJECTED',
          'OFFER_CLOSED','TRANSACTION_CREATED','TRANSACTION_UPDATED','NEED_EXPIRED',
          'NEED_FULFILLING','REVIEW_RECEIVED','VERIFICATION_UPDATED')),
        payload jsonb not null default '{}'::jsonb,
        source_event_id uuid not null,
        in_app boolean not null default true,
        read_at timestamptz,
        created_at timestamptz not null default now(),
        unique (source_event_id, recipient_id, type)
      )`.execute(trx);
    await sql`
      create index notifications_inbox_idx
        on notifications (recipient_id, created_at desc, id desc) where in_app`.execute(trx);
    await sql`
      create index notifications_unread_idx
        on notifications (recipient_id, created_at desc, id desc) where in_app and read_at is null`.execute(
      trx,
    );
    await sql`create index notifications_retention_idx on notifications (created_at) where read_at is not null or not in_app`.execute(
      trx,
    );

    // Rows only for overrides; defaults live in the domain.
    await sql`
      create table notification_preferences (
        account_id uuid not null,
        type text not null,
        in_app boolean not null,
        sms boolean not null,
        updated_at timestamptz not null default now(),
        primary key (account_id, type)
      )`.execute(trx);

    await sql`
      create table deliveries (
        id uuid primary key,
        notification_id uuid not null references notifications (id) on delete cascade,
        channel text not null check (channel in ('SMS','PUSH','EMAIL','WHATSAPP')),
        status text not null default 'PENDING' check (status in ('PENDING','SENT','FAILED','SKIPPED')),
        attempts int not null default 0,
        next_attempt_at timestamptz not null default now(),
        last_error text check (char_length(last_error) <= 200),
        sent_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (notification_id, channel)
      )`.execute(trx);
    await sql`
      create index deliveries_due_idx
        on deliveries (channel, next_attempt_at) where status = 'PENDING'`.execute(trx);
  },
  async down(trx) {
    await sql`drop table deliveries`.execute(trx);
    await sql`drop table notification_preferences`.execute(trx);
    await sql`drop table notifications`.execute(trx);
  },
};
