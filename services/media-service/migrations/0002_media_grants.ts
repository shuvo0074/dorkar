import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

/**
 * Phase 2: message, dispute-evidence and lend-item media, and explicit read grants.
 * Constraint names below are the ones Postgres generated for 0001's unnamed checks.
 */
export const m0002MediaGrants: Migration = {
  name: '0002_media_grants',
  async up(trx) {
    await sql`alter table media_objects drop constraint media_objects_purpose_check`.execute(trx);
    await sql`
      alter table media_objects add constraint media_objects_purpose_check
        check (purpose in ('LISTING','NEED','OFFER','AVATAR','VERIFICATION','MESSAGE','DISPUTE','LEND_ITEM'))
    `.execute(trx);
    // Visibility follows the purpose.
    await sql`alter table media_objects drop constraint media_objects_check`.execute(trx);
    await sql`
      alter table media_objects add constraint media_objects_visibility_rule
        check (visibility = case when purpose in ('VERIFICATION','MESSAGE','DISPUTE')
                                 then 'PRIVATE' else 'PUBLIC' end)
    `.execute(trx);

    // Who besides the owner may read a private object (conversation / case participants).
    await sql`
      create table media_grants (
        media_id uuid not null references media_objects (id) on delete cascade,
        account_id uuid not null,
        granted_by_service text not null,
        created_at timestamptz not null default now(),
        primary key (media_id, account_id)
      )`.execute(trx);
  },
  async down(trx) {
    await sql`drop table media_grants`.execute(trx);
    await sql`alter table media_objects drop constraint media_objects_visibility_rule`.execute(trx);
    await sql`alter table media_objects drop constraint media_objects_purpose_check`.execute(trx);
    // NOT VALID: rows created with the new purposes are kept (no data loss on rollback); the old
    // rules apply to new writes only.
    await sql`
      alter table media_objects add constraint media_objects_purpose_check
        check (purpose in ('LISTING','NEED','OFFER','AVATAR','VERIFICATION')) not valid
    `.execute(trx);
    await sql`
      alter table media_objects add constraint media_objects_check
        check (visibility = case when purpose = 'VERIFICATION' then 'PRIVATE' else 'PUBLIC' end) not valid
    `.execute(trx);
  },
};
