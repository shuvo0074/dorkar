import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

/**
 * The list cursor carries a JS (millisecond) timestamp. With microsecond `created_at`, rows in the
 * same millisecond as the cursor row could be skipped. Millisecond precision makes the keyset exact.
 */
export const m0003MsCreatedAt: Migration = {
  name: '0003_ms_created_at',
  async up(trx) {
    await sql`alter table notifications alter column created_at type timestamptz(3)`.execute(trx);
  },
  async down(trx) {
    await sql`alter table notifications alter column created_at type timestamptz`.execute(trx);
  },
};
