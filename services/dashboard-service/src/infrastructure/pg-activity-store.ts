import { appendAudit, type Cursor } from '@dorkar/kernel';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ActivityStore, ActivityUnitOfWork } from '../application/ports';
import {
  ABOUT_ME_TARGET_TYPES,
  prefixUpperBound,
  type ActivityEntry,
  type ActivityFilter,
} from '../domain/activity';
import type { DashboardDB } from './db-schema';

type Executor = Kysely<DashboardDB> | Transaction<DashboardDB>;

export function pgActivityStore(db: Executor): ActivityStore {
  const base = () =>
    db
      .selectFrom('activity_log as a')
      .leftJoin('actor_names as n', 'n.account_id', 'a.actor_id')
      .select([
        'a.id',
        'a.service',
        'a.occurred_at',
        'a.actor_id',
        'a.actor_type',
        'a.action',
        'a.target_type',
        'a.target_id',
        'a.request_id',
        'a.ip_hash',
        'a.metadata',
        'n.display_name',
      ]);
  type Row = Awaited<ReturnType<ReturnType<typeof base>['execute']>>[number];
  const toEntry = (r: Row): ActivityEntry => ({
    id: r.id,
    service: r.service,
    occurredAt: r.occurred_at,
    actorId: r.actor_id,
    actorType: r.actor_type,
    actorName: r.display_name ?? null,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    requestId: r.request_id,
    ipHash: r.ip_hash,
    metadata: r.metadata ?? {},
  });
  const page = (q: ReturnType<typeof base>, cursor: Cursor | null, limit: number) =>
    (cursor
      ? q.where(sql<boolean>`(a.occurred_at, a.id) < (${new Date(cursor.k)}, ${cursor.id}::uuid)`)
      : q
    )
      .orderBy('a.occurred_at', 'desc')
      .orderBy('a.id', 'desc')
      .limit(limit)
      .execute()
      .then((rows) => rows.map(toEntry));

  return {
    async record(a) {
      const r = await db
        .insertInto('activity_log')
        .values({
          id: a.id,
          service: a.service,
          occurred_at: a.occurredAt,
          actor_id: a.actorId,
          actor_type: a.actorType,
          action: a.action,
          target_type: a.targetType,
          target_id: a.targetId,
          request_id: a.requestId,
          ip_hash: a.ipHash,
          metadata: JSON.stringify(a.metadata),
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();
      return !!r;
    },
    async setActorName(accountId, displayName, at) {
      await db
        .insertInto('actor_names')
        .values({ account_id: accountId, display_name: displayName, updated_at: at })
        .onConflict((oc) =>
          oc
            .column('account_id')
            .doUpdateSet((eb) => ({
              display_name: eb.ref('excluded.display_name'),
              updated_at: eb.ref('excluded.updated_at'),
            }))
            .where(sql<boolean>`actor_names.updated_at <= excluded.updated_at`),
        )
        .execute();
    },
    async forgetActorName(accountId) {
      await db.deleteFrom('actor_names').where('account_id', '=', accountId).execute();
    },
    list(f: ActivityFilter, cursor, limit) {
      let q = base();
      if (f.actorId) q = q.where('a.actor_id', '=', f.actorId);
      if (f.targetType) q = q.where('a.target_type', '=', f.targetType);
      if (f.targetId) q = q.where('a.target_id', '=', f.targetId);
      if (f.service) q = q.where('a.service', '=', f.service);
      if (f.actorType) q = q.where('a.actor_type', '=', f.actorType);
      if (f.actionPrefix) {
        const lo = f.actionPrefix;
        const hi = prefixUpperBound(lo);
        q = q.where(sql<boolean>`a.action ~>=~ ${lo} and a.action ~<~ ${hi}`);
      }
      if (f.from) q = q.where('a.occurred_at', '>=', f.from);
      if (f.to) q = q.where('a.occurred_at', '<=', f.to);
      return page(q, cursor, limit);
    },
    listAboutAccount(accountId, cursor, limit) {
      const q = base()
        .where('a.target_id', '=', accountId)
        .where('a.target_type', 'in', ABOUT_ME_TARGET_TYPES)
        .where('a.actor_type', '=', 'ADMIN');
      return page(q, cursor, limit);
    },
    async get(id) {
      const r = await base().where('a.id', '=', id).executeTakeFirst();
      return r ? toEntry(r) : null;
    },
    async facets(since, maxActions) {
      const [services, actions] = await Promise.all([
        db
          .selectFrom('activity_log')
          .select(['service', (eb) => eb.fn.countAll<string>().as('count')])
          .where('occurred_at', '>=', since)
          .groupBy('service')
          .orderBy('count', 'desc')
          .orderBy('service')
          .execute(),
        db
          .selectFrom('activity_log')
          .select(['action', (eb) => eb.fn.countAll<string>().as('count')])
          .where('occurred_at', '>=', since)
          .groupBy('action')
          .orderBy('count', 'desc')
          .orderBy('action')
          .limit(maxActions)
          .execute(),
      ]);
      return {
        services: services.map((r) => ({ service: r.service, count: Number(r.count) })),
        actions: actions.map((r) => ({ action: r.action, count: Number(r.count) })),
      };
    },
    async purgeBatch(days, batchSize) {
      const r = await db
        .deleteFrom('activity_log')
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('activity_log')
            .select('id')
            .where('occurred_at', '<', sql<Date>`now() - make_interval(days => ${days})`)
            .limit(batchSize),
        )
        .executeTakeFirst();
      return Number(r.numDeletedRows);
    },
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgActivityUnitOfWork(db: Kysely<DashboardDB>): ActivityUnitOfWork {
  return {
    store: pgActivityStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgActivityStore(trx))),
  };
}
