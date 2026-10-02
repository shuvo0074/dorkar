import { appendToOutbox } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ProfileStore, ProfileUnitOfWork } from '../application/ports';
import type { Badge, Profile } from '../domain/profile';
import type { ProfileDB } from './db-schema';

type Executor = Kysely<ProfileDB> | Transaction<ProfileDB>;

const toProfile = (r: Selectable<ProfileDB['profiles']>): Profile => ({
  accountId: r.account_id,
  displayName: r.display_name,
  userType: r.user_type,
  bio: r.bio,
  district: r.district,
  area: r.area,
  locale: r.locale,
  avatarMediaId: r.avatar_media_id,
  hidden: r.hidden,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const BADGES: Record<string, Badge> = {
  PHONE: 'PHONE_VERIFIED',
  NID: 'NID_VERIFIED',
  BUSINESS: 'BUSINESS_VERIFIED',
};

export function pgProfileStore(db: Executor): ProfileStore {
  const get = async (accountId: string) => {
    const r = await db
      .selectFrom('profiles')
      .selectAll()
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return r ? toProfile(r) : null;
  };

  return {
    get,
    async ensure(accountId, displayName) {
      await db
        .insertInto('profiles')
        .values({ account_id: accountId, display_name: displayName })
        .onConflict((oc) => oc.column('account_id').doNothing())
        .execute();
      return (await get(accountId))!;
    },
    async update(accountId, p) {
      const r = await db
        .updateTable('profiles')
        .set((eb) => ({
          ...(p.displayName !== undefined ? { display_name: p.displayName } : {}),
          ...(p.userType !== undefined ? { user_type: p.userType } : {}),
          ...(p.bio !== undefined ? { bio: p.bio } : {}),
          ...(p.district !== undefined ? { district: p.district } : {}),
          ...(p.area !== undefined ? { area: p.area } : {}),
          ...(p.locale !== undefined ? { locale: p.locale } : {}),
          ...(p.avatarMediaId !== undefined ? { avatar_media_id: p.avatarMediaId } : {}),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('account_id', '=', accountId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toProfile(r);
    },
    async setHidden(accountId, hidden) {
      await db
        .updateTable('profiles')
        .set({ hidden, updated_at: sql<Date>`now()` })
        .where('account_id', '=', accountId)
        .execute();
    },
    async capabilities(accountId) {
      const r = await db
        .selectFrom('seller_capabilities')
        .selectAll()
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return r
        ? {
            accountId: r.account_id,
            roles: r.roles,
            categoryIds: r.category_ids,
            serviceDistricts: r.service_districts,
            deliveryModes: r.delivery_modes,
            active: r.active,
          }
        : null;
    },
    async setCapabilities(c) {
      const row = {
        roles: c.roles,
        category_ids: c.categoryIds,
        service_districts: c.serviceDistricts,
        delivery_modes: c.deliveryModes,
        active: c.active,
      };
      await db
        .insertInto('seller_capabilities')
        .values({ account_id: c.accountId, ...row })
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },
    async reputation(accountId) {
      const r = await db
        .selectFrom('reputation_summaries')
        .selectAll()
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return r
        ? {
            ratingAverage: r.rating_average === null ? null : Number(r.rating_average),
            ratingCount: r.rating_count,
            completedCount: r.completed_count,
            cancelledCount: r.cancelled_count,
            disputedCount: r.disputed_count,
          }
        : null;
    },
    async setReputation(accountId, s) {
      const row = {
        rating_average: s.ratingAverage === null ? null : s.ratingAverage.toFixed(2),
        rating_count: s.ratingCount,
        completed_count: s.completedCount,
        cancelled_count: s.cancelledCount,
        disputed_count: s.disputedCount,
      };
      await db
        .insertInto('reputation_summaries')
        .values({ account_id: accountId, ...row })
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },
    async badges(accountId) {
      const rows = await db
        .selectFrom('verification_badges')
        .select('kind')
        .where('account_id', '=', accountId)
        .where('status', '=', 'VERIFIED')
        .execute();
      return rows.map((r) => BADGES[r.kind]).filter((b): b is Badge => !!b);
    },
    async setVerification(accountId, kind, status) {
      await db
        .insertInto('verification_badges')
        .values({ account_id: accountId, kind, status })
        .onConflict((oc) =>
          oc.columns(['account_id', 'kind']).doUpdateSet({ status, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },
    async cards(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .selectFrom('profiles')
        .select(['account_id', 'display_name', 'user_type', 'district'])
        .where('account_id', 'in', ids)
        .where('hidden', '=', false)
        .execute();
      return rows.map((r) => ({
        accountId: r.account_id,
        displayName: r.display_name,
        userType: r.user_type,
        district: r.district,
      }));
    },
    outbox: (events) => appendToOutbox(db, events),
  };
}

export function pgProfileUnitOfWork(db: Kysely<ProfileDB>): ProfileUnitOfWork {
  return {
    store: pgProfileStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgProfileStore(trx))),
  };
}
