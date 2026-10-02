import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Reputation: Migration = {
  name: '0001_reputation',
  async up(trx) {
    // Projection of transaction-service facts. Rows may be created by either TransactionCreated
    // or TransactionStateChanged (whichever arrives first), so mode/amount are nullable.
    await sql`
      create table transactions (
        id uuid primary key,
        buyer_id uuid not null,
        seller_id uuid not null,
        mode text check (mode in ('BUY','RENT','BORROW','HIRE','SOURCE')),
        amount bigint check (amount >= 0),
        currency char(3),
        state text not null check (state in (
          'CREATED','CONFIRMED','DELIVERY_PENDING','DELIVERED','COMPLETED',
          'CANCELLED','DISPUTED','REFUNDED','EXPIRED')),
        state_at timestamptz not null,
        completed_at timestamptz,
        cancelled_by uuid,
        disputed_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index transactions_buyer_idx on transactions (buyer_id)`.execute(trx);
    await sql`create index transactions_seller_idx on transactions (seller_id)`.execute(trx);

    // Raw per-account counters, recomputed from `transactions` (never incremented blindly).
    await sql`
      create table account_stats (
        account_id uuid primary key,
        completed_count int not null default 0,
        cancelled_count int not null default 0,
        disputed_count int not null default 0,
        as_seller_completed int not null default 0,
        as_buyer_completed int not null default 0,
        updated_at timestamptz not null default now()
      )`.execute(trx);

    await sql`
      create table reviews (
        id uuid primary key,
        transaction_id uuid not null references transactions (id),
        author_id uuid not null,
        subject_id uuid not null,
        author_role text not null check (author_role in ('BUYER','SELLER')),
        rating smallint not null check (rating between 1 and 5),
        comment text check (char_length(comment) <= 1000),
        status text not null default 'VISIBLE' check (status in ('VISIBLE','HIDDEN')),
        created_at timestamptz not null default date_trunc('milliseconds', now()),
        updated_at timestamptz not null default now(),
        unique (transaction_id, author_id),
        check (author_id <> subject_id)
      )`.execute(trx);
    // Public list + rating computation per subject (VISIBLE only).
    await sql`create index reviews_subject_visible_idx on reviews (subject_id, created_at desc, id desc) where status = 'VISIBLE'`.execute(
      trx,
    );
    // Admin queue filtered by status.
    await sql`create index reviews_status_idx on reviews (status, created_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index reviews_created_idx on reviews (created_at desc, id desc)`.execute(trx);

    // Many signals, not one score. `signal` is free text so new signals need no migration.
    await sql`
      create table reputation_signals (
        account_id uuid not null,
        signal text not null,
        value numeric,
        computed_at timestamptz not null default now(),
        primary key (account_id, signal)
      )`.execute(trx);
  },
  async down(trx) {
    await sql`drop table reputation_signals`.execute(trx);
    await sql`drop table reviews`.execute(trx);
    await sql`drop table account_stats`.execute(trx);
    await sql`drop table transactions`.execute(trx);
  },
};
