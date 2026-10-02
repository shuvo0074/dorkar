import type { NeedStatus } from '@dorkar/contracts';
import { appendAudit, appendToOutbox } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { NeedEdit, NeedStore, NeedUnitOfWork } from '../application/ports';
import type { Need } from '../domain/need';
import type { DemandDB } from './db-schema';

type Executor = Kysely<DemandDB> | Transaction<DemandDB>;
type NeedRow = Selectable<DemandDB['needs']> & { required_by_s: string | null };

/** `date` columns come back from pg as local-midnight Dates; read them as text instead. */
const requiredByText = sql<string | null>`required_by::text`.as('required_by_s');

const num = (v: string | null): number | null => (v === null ? null : Number(v));

const toNeed = (r: NeedRow): Need => ({
  id: r.id,
  requesterId: r.requester_id,
  mode: r.mode,
  categoryId: r.category_id,
  title: r.title,
  description: r.description,
  quantity: r.quantity,
  budgetMin: num(r.budget_min_amount),
  budgetMax: num(r.budget_max_amount),
  budgetFlexible: r.budget_flexible,
  conditions: r.conditions,
  attributes: r.attributes,
  modeTerms: r.mode_terms,
  district: r.district,
  area: r.area,
  deliveryPref: r.delivery_pref,
  requiredBy: r.required_by_s,
  ttlDays: r.ttl_days,
  expiresAt: r.expires_at,
  renewals: r.renewals,
  maxOffers: r.max_offers,
  visibility: r.visibility,
  status: r.status,
  statusBeforeHidden: r.status_before_hidden,
  offerCount: r.offer_count,
  acceptedQuantity: r.accepted_quantity,
  publishedAt: r.published_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const editColumns = (e: NeedEdit) => ({
  mode: e.mode,
  category_id: e.categoryId,
  title: e.title,
  description: e.description,
  quantity: e.quantity,
  budget_min_amount: e.budgetMin,
  budget_max_amount: e.budgetMax,
  budget_flexible: e.budgetFlexible,
  conditions: e.conditions,
  attributes: JSON.stringify(e.attributes),
  mode_terms: JSON.stringify(e.modeTerms),
  district: e.district,
  area: e.area,
  delivery_pref: e.deliveryPref,
  required_by: e.requiredBy,
  visibility: e.visibility,
});

export function pgNeedStore(db: Executor): NeedStore {
  const needs = () => db.selectFrom('needs').selectAll().select(requiredByText);

  const get = async (id: string) => {
    const r = await needs().where('id', '=', id).executeTakeFirst();
    return r ? toNeed(r) : null;
  };

  return {
    async now() {
      const { rows } = await sql<{ now: Date }>`select now() as now`.execute(db);
      return rows[0]!.now;
    },

    async category(id) {
      const r = await db
        .selectFrom('categories')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r
        ? {
            id: r.id,
            parentId: r.parent_id,
            modes: r.modes,
            attributeSchema: r.attribute_schema,
            active: r.active,
          }
        : null;
    },

    async upsertCategory(c) {
      const row = {
        parent_id: c.parentId,
        slug: c.slug,
        name_en: c.nameEn,
        name_bn: c.nameBn,
        modes: c.modes,
        attribute_schema: JSON.stringify(c.attributeSchema),
        active: c.active,
      };
      await db
        .insertInto('categories')
        .values({ id: c.id, ...row })
        .onConflict((oc) => oc.column('id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }))
        .execute();
    },

    async insert(n) {
      const r = await db
        .insertInto('needs')
        .values({
          id: n.id,
          requester_id: n.requesterId,
          ...editColumns(n),
          ttl_days: n.ttlDays,
          max_offers: n.maxOffers,
          expires_at: null,
          published_at: null,
          status_before_hidden: null,
        })
        .returningAll()
        .returning(requiredByText)
        .executeTakeFirstOrThrow();
      return toNeed(r);
    },

    get,

    async getForUpdate(id) {
      const r = await needs().where('id', '=', id).forUpdate().executeTakeFirst();
      return r ? toNeed(r) : null;
    },

    async update(id, version, e) {
      const r = await db
        .updateTable('needs')
        .set((eb) => ({
          ...editColumns(e),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('version', '=', version)
        .returningAll()
        .returning(requiredByText)
        .executeTakeFirst();
      return r ? toNeed(r) : null;
    },

    async setStatus(id, from, version, to, c) {
      const r = await db
        .updateTable('needs')
        .set((eb) => ({
          status: to,
          ...(c.expiresAt !== undefined ? { expires_at: c.expiresAt } : {}),
          ...(c.publishedAt !== undefined ? { published_at: c.publishedAt } : {}),
          ...(c.renewals !== undefined ? { renewals: c.renewals } : {}),
          ...(c.statusBeforeHidden !== undefined
            ? { status_before_hidden: c.statusBeforeHidden }
            : {}),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('status', '=', from)
        .where('version', '=', version)
        .returningAll()
        .returning(requiredByText)
        .executeTakeFirst();
      return r ? toNeed(r) : null;
    },

    async appendHistory(needId, e) {
      await db
        .insertInto('need_status_history')
        .values({
          need_id: needId,
          from_status: e.from,
          to_status: e.to,
          actor_id: e.actorId,
          reason: e.reason,
        })
        .execute();
    },

    async history(needId) {
      const rows = await db
        .selectFrom('need_status_history')
        .select(['from_status', 'to_status', 'actor_id', 'reason', 'at'])
        .where('need_id', '=', needId)
        .orderBy('id')
        .execute();
      return rows.map((r) => ({
        from: r.from_status,
        to: r.to_status,
        actorId: r.actor_id,
        reason: r.reason,
        at: r.at,
      }));
    },

    async lockRequester(requesterId) {
      await sql`select pg_advisory_xact_lock(hashtext(${`demand:open-needs:${requesterId}`}))`.execute(
        db,
      );
    },

    async countActive(requesterId) {
      const r = await db
        .selectFrom('needs')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('requester_id', '=', requesterId)
        .where('status', 'in', ['OPEN', 'PAUSED', 'FULFILLING'] satisfies NeedStatus[])
        .executeTakeFirstOrThrow();
      return Number(r.n);
    },

    async feed(f, cursor, limit) {
      let q = needs().where('status', '=', 'OPEN').where('visibility', '=', 'PUBLIC');
      if (f.q) q = q.where(sql<boolean>`search @@ websearch_to_tsquery('simple', ${f.q})`);
      if (f.categoryId) {
        const categoryId = f.categoryId;
        q = q.where((eb) =>
          eb.or([
            eb('category_id', '=', categoryId),
            eb(
              'category_id',
              'in',
              eb.selectFrom('categories').select('id').where('parent_id', '=', categoryId),
            ),
          ]),
        );
      }
      if (f.mode) q = q.where('mode', '=', f.mode);
      if (f.district) q = q.where('district', '=', f.district);
      if (f.budgetMaxAtLeast !== undefined) {
        q = q.where('budget_max_amount', '>=', f.budgetMaxAtLeast as unknown as string);
      }
      if (cursor) {
        const at = new Date(String(cursor.k));
        q = q.where((eb) => eb(eb.refTuple('published_at', 'id'), '<', eb.tuple(at, cursor.id)));
      }
      const rows = await q
        .orderBy('published_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      return rows.map(toNeed);
    },

    async listByRequester(requesterId, status, cursor, limit) {
      let q = needs().where('requester_id', '=', requesterId);
      if (status) q = q.where('status', '=', status);
      if (cursor) q = q.where('id', '<', cursor.id);
      const rows = await q
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      return rows.map(toNeed);
    },

    async dueForExpiry(limit) {
      const rows = await needs()
        .where('status', 'in', ['OPEN', 'PAUSED'] satisfies NeedStatus[])
        .where('expires_at', '<=', sql<Date>`now()`)
        .orderBy('expires_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map(toNeed);
    },

    async incrementOfferCount(needId) {
      await db
        .updateTable('needs')
        .set((eb) => ({ offer_count: eb('offer_count', '+', 1), updated_at: sql<Date>`now()` }))
        .where('id', '=', needId)
        .execute();
    },

    async addAcceptedOffer(offerId, needId, quantity) {
      const r = await db
        .insertInto('accepted_offers')
        .values({ offer_id: offerId, need_id: needId, quantity })
        .onConflict((oc) => oc.column('offer_id').doNothing())
        .returning('offer_id')
        .executeTakeFirst();
      return !!r;
    },

    async cancelAcceptedOffer(offerId) {
      const r = await db
        .updateTable('accepted_offers')
        .set({ status: 'CANCELLED', updated_at: sql<Date>`now()` })
        .where('offer_id', '=', offerId)
        .where('status', '=', 'ACCEPTED')
        .returning(['need_id', 'quantity'])
        .executeTakeFirst();
      return r ? { needId: r.need_id, quantity: r.quantity } : null;
    },

    async completeAcceptedOffer(offerId) {
      const r = await db
        .updateTable('accepted_offers')
        .set({ completed: true, updated_at: sql<Date>`now()` })
        .where('offer_id', '=', offerId)
        .where('status', '=', 'ACCEPTED')
        .where('completed', '=', false)
        .returning('need_id')
        .executeTakeFirst();
      return r?.need_id ?? null;
    },

    async allAcceptedOffersCompleted(needId) {
      const r = await db
        .selectFrom('accepted_offers')
        .select('offer_id')
        .where('need_id', '=', needId)
        .where('status', '=', 'ACCEPTED')
        .where('completed', '=', false)
        .limit(1)
        .executeTakeFirst();
      return !r;
    },

    async adjustAcceptedQuantity(needId, delta) {
      const r = await db
        .updateTable('needs')
        .set({
          accepted_quantity: sql<number>`greatest(0, accepted_quantity + ${delta}::int)`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', needId)
        .returningAll()
        .returning(requiredByText)
        .executeTakeFirst();
      return r ? toNeed(r) : null;
    },

    async addMatch(needId, sellerId) {
      await db
        .insertInto('need_matches')
        .values({ need_id: needId, seller_id: sellerId })
        .onConflict((oc) => oc.columns(['need_id', 'seller_id']).doNothing())
        .execute();
    },

    async isMatched(needId, sellerId) {
      const r = await db
        .selectFrom('need_matches')
        .select('need_id')
        .where('need_id', '=', needId)
        .where('seller_id', '=', sellerId)
        .executeTakeFirst();
      return !!r;
    },

    outbox: (events) => appendToOutbox(db, events),
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgNeedUnitOfWork(db: Kysely<DemandDB>): NeedUnitOfWork {
  return {
    store: pgNeedStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgNeedStore(trx))),
  };
}
