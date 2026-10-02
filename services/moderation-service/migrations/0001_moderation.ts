import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

export const m0001Moderation: Migration = {
  name: '0001_moderation',
  async up(trx) {
    await sql`
      create table moderation_cases (
        id uuid primary key,
        target_type text not null check (target_type in ('LISTING','NEED','OFFER','REVIEW','USER')),
        target_id uuid not null,
        status text not null default 'OPEN' check (status in ('OPEN','ACTIONED','DISMISSED')),
        report_count int not null default 0 check (report_count >= 0),
        top_reason text not null check (top_reason in
          ('SCAM','PROHIBITED_ITEM','SPAM','OFFENSIVE','CONTACT_INFO','FAKE','HARASSMENT','OTHER')),
        priority int not null default 0,
        assigned_to uuid,
        target_hidden boolean not null default false,
        opened_at timestamptz not null default now(),
        closed_at timestamptz,
        version int not null default 0,
        check ((status = 'OPEN') = (closed_at is null)),
        check (target_type <> 'USER' or not target_hidden)
      )`.execute(trx);
    // At most one open case per target; reports after closing open a new one.
    await sql`create unique index moderation_cases_open_target_uq on moderation_cases (target_type, target_id) where status = 'OPEN'`.execute(
      trx,
    );
    // Queue: priority desc, then oldest (uuidv7 ids are time-ordered).
    await sql`create index moderation_cases_queue_idx on moderation_cases (status, priority desc, id)`.execute(
      trx,
    );
    await sql`create index moderation_cases_queue_type_idx on moderation_cases (status, target_type, priority desc, id)`.execute(
      trx,
    );
    await sql`create index moderation_cases_priority_idx on moderation_cases (priority desc, id)`.execute(
      trx,
    );
    await sql`create index moderation_cases_type_idx on moderation_cases (target_type, priority desc, id)`.execute(
      trx,
    );

    await sql`
      create table reports (
        id uuid primary key,
        reporter_id uuid not null,
        target_type text not null check (target_type in ('LISTING','NEED','OFFER','REVIEW','USER')),
        target_id uuid not null,
        reason text not null check (reason in
          ('SCAM','PROHIBITED_ITEM','SPAM','OFFENSIVE','CONTACT_INFO','FAKE','HARASSMENT','OTHER')),
        details text check (char_length(details) <= 1000),
        case_id uuid not null references moderation_cases (id),
        status text not null default 'OPEN' check (status in ('OPEN','RESOLVED','DISMISSED')),
        created_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create unique index reports_open_per_reporter_uq on reports (reporter_id, target_type, target_id) where status = 'OPEN'`.execute(
      trx,
    );
    await sql`create index reports_reporter_idx on reports (reporter_id, id desc)`.execute(trx);
    await sql`create index reports_case_idx on reports (case_id, status, id desc)`.execute(trx);

    await sql`
      create table moderation_actions (
        id uuid primary key,
        case_id uuid not null references moderation_cases (id),
        moderator_id uuid not null,
        action text not null check (action in ('HIDE','RESTORE','DISMISS','ASSIGN','NOTE')),
        reason text check (char_length(reason) <= 500),
        created_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index moderation_actions_case_idx on moderation_actions (case_id, id)`.execute(
      trx,
    );
    await sql`
      create function moderation_actions_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'moderation_actions is append-only';
      end $$`.execute(trx);
    await sql`
      create trigger moderation_actions_no_update_delete
        before update or delete or truncate on moderation_actions
        for each statement execute function moderation_actions_append_only()`.execute(trx);
  },
  async down(trx) {
    await sql`drop table moderation_actions`.execute(trx);
    await sql`drop function moderation_actions_append_only()`.execute(trx);
    await sql`drop table reports`.execute(trx);
    await sql`drop table moderation_cases`.execute(trx);
  },
};
