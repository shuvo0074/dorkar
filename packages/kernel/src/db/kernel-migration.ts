import { sql } from 'kysely';
import type { Migration } from './migrator';

/**
 * Platform tables every service owns in its own schema: outbox, inbox, audit_log.
 * Include as the first migration of each service.
 */
export const kernelMigration: Migration = {
  name: '0000_kernel',
  async up(trx) {
    await sql`
      create table outbox (
        id uuid primary key,
        type text not null,
        version int not null,
        aggregate_id text not null,
        payload jsonb not null,
        correlation_id text,
        causation_id text,
        occurred_at timestamptz not null default now(),
        published_at timestamptz,
        attempts int not null default 0
      )`.execute(trx);
    await sql`create index outbox_unpublished_idx on outbox (occurred_at) where published_at is null`.execute(
      trx,
    );

    await sql`
      create table inbox (
        consumer text not null,
        event_id uuid not null,
        processed_at timestamptz not null default now(),
        primary key (consumer, event_id)
      )`.execute(trx);

    await sql`
      create table audit_log (
        id uuid primary key,
        occurred_at timestamptz not null default now(),
        actor_id uuid,
        actor_type text not null check (actor_type in ('USER','ADMIN','SYSTEM','ANONYMOUS')),
        action text not null,
        target_type text,
        target_id text,
        request_id text,
        ip_hash text,
        metadata jsonb not null default '{}'
      )`.execute(trx);
    await sql`create index audit_log_actor_idx on audit_log (actor_id, occurred_at desc)`.execute(
      trx,
    );
    await sql`create index audit_log_target_idx on audit_log (target_type, target_id, occurred_at desc)`.execute(
      trx,
    );
    // Append-only: ordinary roles cannot rewrite history, even with table privileges.
    // Retention is done by a maintenance role dropping partitions / disabling the trigger explicitly.
    await sql`
      create function audit_log_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'audit_log is append-only';
      end $$`.execute(trx);
    await sql`
      create trigger audit_log_no_update_delete
        before update or delete or truncate on audit_log
        for each statement execute function audit_log_append_only()`.execute(trx);
  },
  async down(trx) {
    await sql`drop table audit_log`.execute(trx);
    await sql`drop function audit_log_append_only()`.execute(trx);
    await sql`drop table inbox`.execute(trx);
    await sql`drop table outbox`.execute(trx);
  },
};

/**
 * Adds `outbox.traceparent` so events carry the producing request's W3C trace context to their
 * consumers. Nullable, so it is a metadata-only change, safe on a live table. List it after the
 * other `0000_kernel*` migrations; on an existing database it is applied after the service's own
 * migrations, which is fine because nothing depends on that order.
 */
export const kernelOutboxTraceMigration: Migration = {
  name: '0000_kernel_outbox_trace',
  async up(trx) {
    await sql`alter table outbox add column traceparent text`.execute(trx);
  },
  async down(trx) {
    await sql`alter table outbox drop column traceparent`.execute(trx);
  },
};
