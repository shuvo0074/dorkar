import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

/**
 * The matched-needs cursor carries a JS (millisecond) timestamp. With microsecond `created_at`,
 * rows in the same millisecond as the cursor row could be skipped.
 */
export const m0002MsCreatedAt: Migration = {
  name: '0002_ms_created_at',
  async up(trx) {
    await sql`alter table matches alter column created_at type timestamptz(3)`.execute(trx);
  },
  async down(trx) {
    await sql`alter table matches alter column created_at type timestamptz`.execute(trx);
  },
};
