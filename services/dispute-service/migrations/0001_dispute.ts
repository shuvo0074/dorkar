import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

const TX_STATES = sql.raw(
  `'CREATED','CONFIRMED','DELIVERY_PENDING','DELIVERED','HANDED_OVER','RETURN_REPORTED',` +
    `'RETURNED','COMPLETED','CANCELLED','DISPUTED','REFUNDED','EXPIRED'`,
);
const MODES = sql.raw(`'BUY','RENT','BORROW','HIRE','SOURCE'`);

export const m0001Dispute: Migration = {
  name: '0001_dispute',
  async up(trx) {
    // Projection of transaction-service deals: parties, mode, amount, source.
    await sql`
      create table transaction_projection (
        transaction_id uuid primary key,
        buyer_id uuid not null,
        seller_id uuid not null,
        mode text check (mode in (${MODES})),
        amount bigint check (amount >= 0),
        currency char(3),
        source_type text not null check (source_type in ('OFFER','LISTING','AUCTION','BOOKING','LOAN')),
        source_id uuid not null,
        updated_at timestamptz not null default now()
      )`.execute(trx);

    await sql`
      create table disputes (
        id uuid primary key,
        transaction_id uuid not null,
        buyer_id uuid not null,
        seller_id uuid not null,
        opened_by uuid not null,
        respondent_id uuid not null,
        previous_state text not null check (previous_state in (${TX_STATES})),
        reason text not null check (reason in
          ('NOT_RECEIVED','NOT_AS_DESCRIBED','DAMAGED','NOT_RETURNED','PAYMENT','NO_SHOW','OTHER')),
        description text check (char_length(description) <= 500),
        mode text check (mode in (${MODES})),
        amount bigint check (amount >= 0),
        currency char(3),
        payment_provider text not null default 'CASH' check (payment_provider in ('CASH')),
        status text not null check (status in
          ('OPEN','AWAITING_RESPONSE','UNDER_REVIEW','RESOLVED','WITHDRAWN')),
        respond_by timestamptz not null,
        respondent_missed_deadline boolean not null default false,
        statement_submitted_at timestamptz,
        assigned_to uuid,
        assigned_at timestamptz,
        escalated boolean not null default false,
        escalated_at timestamptz,
        resolution text check (resolution in ('RELEASE','CANCEL','REFUND')),
        resolution_note text check (char_length(resolution_note) <= 2000),
        resolved_by uuid,
        resolved_at timestamptz,
        withdrawn_by uuid,
        withdrawn_at timestamptz,
        -- set when transaction-service has applied the outcome (the deal left DISPUTED)
        applied_at timestamptz,
        final_transaction_state text check (final_transaction_state in (${TX_STATES})),
        -- millisecond precision: the keyset cursor carries a JS ISO timestamp
        opened_at timestamptz(3) not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        check (buyer_id <> seller_id),
        check (opened_by in (buyer_id, seller_id) and respondent_id in (buyer_id, seller_id)
               and opened_by <> respondent_id),
        check ((status = 'RESOLVED') = (resolution is not null and resolved_at is not null))
      )`.execute(trx);
    // At most one live case per transaction (redelivery and duplicate opens are no-ops).
    await sql`create unique index disputes_open_tx_uq on disputes (transaction_id)
      where status in ('OPEN','AWAITING_RESPONSE','UNDER_REVIEW')`.execute(trx);
    await sql`create index disputes_tx_idx on disputes (transaction_id, opened_at desc)`.execute(
      trx,
    );
    // Party lists: newest first.
    await sql`create index disputes_buyer_idx on disputes (buyer_id, opened_at desc, id desc)`.execute(
      trx,
    );
    await sql`create index disputes_seller_idx on disputes (seller_id, opened_at desc, id desc)`.execute(
      trx,
    );
    // Staff queue: oldest first, by status / assignee / escalation.
    await sql`create index disputes_queue_idx on disputes (status, opened_at, id)`.execute(trx);
    await sql`create index disputes_assignee_idx on disputes (assigned_to, opened_at, id)`.execute(
      trx,
    );
    await sql`create index disputes_escalated_idx on disputes (opened_at, id) where escalated`.execute(
      trx,
    );
    // Jobs.
    await sql`create index disputes_respond_by_idx on disputes (respond_by)
      where status = 'AWAITING_RESPONSE'`.execute(trx);
    await sql`create index disputes_unassigned_idx on disputes (opened_at)
      where assigned_to is null and not escalated and status in ('AWAITING_RESPONSE','UNDER_REVIEW')`.execute(
      trx,
    );

    // The case file: opening, statement, evidence, staff messages, notes, status history.
    await sql`
      create table dispute_entries (
        id uuid primary key,
        -- timeline order: several entries can share a transaction's now() and millisecond
        seq bigint generated always as identity,
        dispute_id uuid not null references disputes (id),
        kind text not null check (kind in
          ('OPENED','STATEMENT','EVIDENCE','INFO_REQUEST','NOTE','STATUS_CHANGE','ASSIGNMENT','ESCALATION','SYSTEM')),
        author_id uuid,
        author_role text not null check (author_role in ('BUYER','SELLER','STAFF','SYSTEM')),
        visibility text not null check (visibility in ('PARTIES','STAFF')),
        text text check (char_length(text) <= 4000),
        media_ids uuid[] not null default '{}' check (cardinality(media_ids) <= 10),
        target_party text check (target_party in ('BUYER','SELLER','BOTH')),
        from_status text,
        to_status text,
        created_at timestamptz not null default clock_timestamp(),
        check (kind <> 'NOTE' or visibility = 'STAFF')
      )`.execute(trx);
    await sql`create index dispute_entries_dispute_idx on dispute_entries (dispute_id, seq)`.execute(
      trx,
    );
    // Evidence and history are immutable.
    await sql`
      create function dispute_entries_append_only() returns trigger language plpgsql as $$
      begin raise exception 'dispute_entries is append-only'; end $$`.execute(trx);
    await sql`
      create trigger dispute_entries_no_change before update or delete on dispute_entries
      for each row execute function dispute_entries_append_only()`.execute(trx);
    await sql`
      create trigger dispute_entries_no_truncate before truncate on dispute_entries
      for each statement execute function dispute_entries_append_only()`.execute(trx);
  },
  async down(trx) {
    await sql`drop table dispute_entries`.execute(trx);
    await sql`drop function dispute_entries_append_only()`.execute(trx);
    await sql`drop table disputes`.execute(trx);
    await sql`drop table transaction_projection`.execute(trx);
  },
};
