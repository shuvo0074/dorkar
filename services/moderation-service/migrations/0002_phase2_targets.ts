import { sql } from 'kysely';
import type { Migration } from '@dorkar/kernel';

const NEW_TARGETS = sql.raw(
  `('LISTING','NEED','OFFER','REVIEW','USER','MESSAGE','AUCTION','LEND_ITEM')`,
);
const OLD_TARGETS = sql.raw(`('LISTING','NEED','OFFER','REVIEW','USER')`);

/**
 * Phase 2 targets: messages, auctions and lend items. Constraint names are the ones Postgres
 * generated for 0001's column checks; the USER-cannot-be-hidden table check is untouched.
 */
export const m0002Phase2Targets: Migration = {
  name: '0002_phase2_targets',
  async up(trx) {
    for (const table of ['moderation_cases', 'reports']) {
      const name = sql.id(`${table}_target_type_check`);
      await sql`alter table ${sql.table(table)} drop constraint ${name}`.execute(trx);
      await sql`alter table ${sql.table(table)} add constraint ${name}
        check (target_type in ${NEW_TARGETS})`.execute(trx);
    }
  },
  async down(trx) {
    for (const table of ['moderation_cases', 'reports']) {
      const name = sql.id(`${table}_target_type_check`);
      await sql`alter table ${sql.table(table)} drop constraint ${name}`.execute(trx);
      // NOT VALID keeps cases/reports already filed on the new targets (moderation history).
      await sql`alter table ${sql.table(table)} add constraint ${name}
        check (target_type in ${OLD_TARGETS}) not valid`.execute(trx);
    }
  },
};
