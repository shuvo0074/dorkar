import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { PushDeviceStore, PushDeviceUnitOfWork } from '../application/ports';
import type { PushDevice } from '../domain/push';
import type { NotificationDB } from './db-schema';

type Executor = Kysely<NotificationDB> | Transaction<NotificationDB>;

const COLUMNS = ['id', 'account_id', 'platform', 'created_at', 'last_registered_at'] as const;

const toDevice = (
  r: Pick<Selectable<NotificationDB['push_devices']>, (typeof COLUMNS)[number]>,
): PushDevice => ({
  id: r.id,
  accountId: r.account_id,
  platform: r.platform,
  createdAt: r.created_at,
  lastRegisteredAt: r.last_registered_at,
});

export function pgPushDeviceStore(db: Executor): PushDeviceStore {
  return {
    async lockAccount(accountId) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`notification.push-devices:${accountId}`}, 0))`.execute(
        db,
      );
    },

    async register(d) {
      const prev = await db
        .selectFrom('push_devices')
        .select('account_id')
        .where('token_hash', '=', d.tokenHash)
        .forUpdate()
        .executeTakeFirst();
      const moved = prev !== undefined && prev.account_id !== d.accountId;
      const row = await db
        .insertInto('push_devices')
        .values({
          id: d.id,
          account_id: d.accountId,
          platform: d.platform,
          token: d.token,
          token_hash: d.tokenHash,
          deactivated_at: null,
          deactivation_reason: null,
        })
        .onConflict((oc) =>
          oc.column('token_hash').doUpdateSet({
            // A token that changes hands is a new device for its new owner (fresh id), so the
            // previous owner's references to it stop resolving.
            ...(moved ? { id: d.id, created_at: sql<Date>`now()` } : {}),
            account_id: d.accountId,
            platform: d.platform,
            token: d.token,
            active: true,
            deactivated_at: null,
            deactivation_reason: null,
            last_registered_at: sql<Date>`now()`,
          }),
        )
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return { device: toDevice(row), previousOwnerId: moved ? prev.account_id : null };
    },

    async trimActive(accountId, keep) {
      const r = await db
        .updateTable('push_devices')
        .set({
          active: false,
          deactivated_at: sql<Date>`now()`,
          deactivation_reason: 'LIMIT',
        })
        .where('account_id', '=', accountId)
        .where('active', '=', true)
        .where('id', 'not in', (eb) =>
          eb
            .selectFrom('push_devices')
            .select('id')
            .where('account_id', '=', accountId)
            .where('active', '=', true)
            .orderBy('last_registered_at', 'desc')
            .orderBy('id', 'desc')
            .limit(keep),
        )
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },

    async listActive(accountId) {
      const rows = await db
        .selectFrom('push_devices')
        .select(COLUMNS)
        .where('account_id', '=', accountId)
        .where('active', '=', true)
        .orderBy('last_registered_at', 'desc')
        .orderBy('id', 'desc')
        .execute();
      return rows.map(toDevice);
    },

    async remove(id, accountId) {
      const r = await db
        .deleteFrom('push_devices')
        .where('id', '=', id)
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return Number(r.numDeletedRows) > 0;
    },

    async targetsFor(accountId) {
      return db
        .selectFrom('push_devices')
        .select(['id', 'platform', 'token'])
        .where('account_id', '=', accountId)
        .where('active', '=', true)
        .orderBy('last_registered_at', 'desc')
        .execute();
    },

    async deactivate(id, reason) {
      await db
        .updateTable('push_devices')
        .set({ active: false, deactivated_at: sql<Date>`now()`, deactivation_reason: reason })
        .where('id', '=', id)
        .where('active', '=', true)
        .execute();
    },
  };
}

export function pgPushDeviceUnitOfWork(db: Kysely<NotificationDB>): PushDeviceUnitOfWork {
  return {
    store: pgPushDeviceStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgPushDeviceStore(trx))),
  };
}
