import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

/** The seeded catch-all: nothing is required unless an admin adds a policy. */
export const DEFAULT_POLICY_ID = '00000000-0000-7000-8000-000000000001';

export const m0001Verification: Migration = {
  name: '0001_verification',
  async up(trx) {
    // No raw NID, name or date of birth anywhere: only last4 and a keyed fingerprint.
    await sql`
      create table verifications (
        id uuid primary key,
        account_id uuid not null,
        kind text not null check (kind in ('PHONE','NID','BUSINESS')),
        status text not null check (status in ('PENDING','VERIFIED','REJECTED','REVOKED','EXPIRED')),
        provider text not null check (char_length(provider) between 1 and 40),
        provider_ref text check (char_length(provider_ref) <= 200),
        nid_last4 text check (nid_last4 ~ '^[0-9]{4}$'),
        nid_fingerprint text check (nid_fingerprint ~ '^[0-9a-f]{64}$'),
        reviewed_by uuid,
        review_note text check (char_length(review_note) <= 500),
        submitted_at timestamptz not null default date_trunc('milliseconds', now()),
        verified_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        version int not null default 0,
        constraint verifications_account_kind_key unique (account_id, kind),
        constraint verifications_nid_fields check (
          kind = 'NID' or (nid_last4 is null and nid_fingerprint is null)
        )
      )`.execute(trx);
    // One NID can be verified on one account only (concurrency-safe duplicate check).
    await sql`
      create unique index verifications_nid_verified_once on verifications (nid_fingerprint)
      where kind = 'NID' and status = 'VERIFIED'`.execute(trx);
    // Admin review queue (keyset by submitted_at, id).
    await sql`create index verifications_queue_idx on verifications (status, submitted_at, id)`.execute(
      trx,
    );
    // Retention job: rejected NID fingerprints.
    await sql`
      create index verifications_rejected_fp_idx on verifications (updated_at)
      where kind = 'NID' and status = 'REJECTED' and nid_fingerprint is not null`.execute(trx);

    await sql`
      create table verification_history (
        id uuid primary key,
        verification_id uuid not null references verifications (id),
        from_status text,
        to_status text not null,
        actor_id uuid,
        reason text check (char_length(reason) <= 500),
        occurred_at timestamptz not null default now()
      )`.execute(trx);
    await sql`create index verification_history_verification_idx on verification_history (verification_id, occurred_at)`.execute(
      trx,
    );
    // Append-only.
    await sql`
      create function verification_history_immutable() returns trigger language plpgsql as $$
      begin
        raise exception 'verification_history is append-only';
      end $$`.execute(trx);
    await sql`
      create trigger verification_history_no_change before update or delete on verification_history
      for each row execute function verification_history_immutable()`.execute(trx);

    await sql`
      create table policies (
        id uuid primary key,
        name text not null check (char_length(name) between 2 and 120),
        action text not null check (action in ('LISTING_PUBLISH','NEED_PUBLISH','OFFER_SUBMIT','TRANSACTION_CREATE','ANY')),
        scope text not null check (scope in ('GLOBAL','ROLE','CATEGORY','MODE','VALUE_THRESHOLD')),
        selector jsonb not null default '{}',
        requirement text not null check (requirement in ('NONE','OPTIONAL','REQUIRED')),
        kinds text[] not null default '{}' check (kinds <@ array['PHONE','NID','BUSINESS']::text[]),
        active boolean not null default true,
        priority int not null default 0,
        version int not null default 1,
        updated_by uuid,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check (requirement <> 'REQUIRED' or cardinality(kinds) > 0)
      )`.execute(trx);
    // evaluate(): active policies for one action (+ ANY).
    await sql`create index policies_active_action_idx on policies (action) where active`.execute(
      trx,
    );

    await sql`
      insert into policies (id, name, action, scope, selector, requirement, kinds, priority)
      values (${DEFAULT_POLICY_ID}, 'Default: no verification beyond phone', 'ANY', 'GLOBAL',
              '{}', 'NONE', '{}', 0)`.execute(trx);
  },
  async down(trx) {
    await sql`drop table policies`.execute(trx);
    await sql`drop table verification_history`.execute(trx);
    await sql`drop function verification_history_immutable`.execute(trx);
    await sql`drop table verifications`.execute(trx);
  },
};
