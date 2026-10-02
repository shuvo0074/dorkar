import { appendToOutbox, paginate } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type SqlBool, type Transaction } from 'kysely';
import type { MatchingStore, MatchingUnitOfWork, MatchRecord } from '../application/ports';
import {
  fromStatesFor,
  targetFor,
  type ListingCandidate,
  type ScoringNeed,
  type SellerCandidate,
  type SellerSignals,
} from '../domain/matching';
import type { MatchingDB } from './db-schema';

type Executor = Kysely<MatchingDB> | Transaction<MatchingDB>;

const amount = (v: string | null) => (v === null ? null : Number(v));

const toMatch = (r: Selectable<MatchingDB['matches']>): MatchRecord => ({
  id: r.id,
  needId: r.need_id,
  sellerId: r.seller_id,
  listingId: r.listing_id,
  candidateType: r.candidate_type,
  score: Number(r.score),
  reasons: r.reasons,
  scorer: r.scorer,
  status: r.status,
  respondedAt: r.responded_at,
  dismissedAt: r.dismissed_at,
  createdAt: r.created_at,
});

const toNeed = (
  r: Selectable<MatchingDB['needs']> & { category_parent_id: string | null },
): ScoringNeed => ({
  needId: r.need_id,
  requesterId: r.requester_id,
  mode: r.mode,
  categoryId: r.category_id,
  categoryParentId: r.category_parent_id,
  quantity: r.quantity,
  budgetMax: amount(r.budget_max_amount),
  conditions: r.conditions,
  district: r.district,
  attributes: r.attributes,
});

const toListing = (
  r: Selectable<MatchingDB['listings']> & { category_parent_id: string | null },
): ListingCandidate => ({
  type: 'LISTING',
  listingId: r.listing_id,
  sellerId: r.seller_id,
  categoryId: r.category_id,
  categoryParentId: r.category_parent_id,
  kind: r.kind,
  condition: r.condition,
  priceAmount: Number(r.price_amount),
  priceUnit: r.price_unit,
  quantityAvailable: r.quantity_available,
  district: r.district,
  attributes: r.attributes,
  deliveryModes: r.delivery_modes,
  available: r.available,
});

const toSeller = (r: Selectable<MatchingDB['sellers']>): SellerCandidate => ({
  type: 'SELLER',
  sellerId: r.account_id,
  roles: r.roles,
  categoryIds: r.category_ids,
  serviceDistricts: r.service_districts,
  deliveryModes: r.delivery_modes,
  active: r.active,
});

const deliversSql = (column: string) => sql<SqlBool>`'SELLER_DELIVERY' = any(${sql.ref(column)})`;

/** One cluster-wide lock key for matching work (transaction-scoped; released at commit). */
const MATCHING_LOCK = sql`hashtext('matching.candidates')`;

export function pgMatchingStore(db: Executor): MatchingStore {
  const listingsWithParent = () =>
    db
      .selectFrom('listings as l')
      .leftJoin('categories as c', 'c.id', 'l.category_id')
      .selectAll('l')
      .select('c.parent_id as category_parent_id');

  const needsWithParent = () =>
    db
      .selectFrom('needs as n')
      .leftJoin('categories as c', 'c.id', 'n.category_id')
      .selectAll('n')
      .select('c.parent_id as category_parent_id');

  return {
    async lockMatching() {
      await sql`select pg_advisory_xact_lock(${MATCHING_LOCK})`.execute(db);
    },
    // ---------------------------------------------------------------- projections
    async upsertCategory(c) {
      const row = { parent_id: c.parentId, modes: c.modes, active: c.active };
      await db
        .insertInto('categories')
        .values({ id: c.id, ...row })
        .onConflict((oc) => oc.column('id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }))
        .execute();
    },

    async upsertNeed(n, publishedAt) {
      const row = {
        requester_id: n.requesterId,
        mode: n.mode,
        category_id: n.categoryId,
        title: n.title,
        quantity: n.quantity,
        budget_min_amount: n.budgetMin,
        budget_max_amount: n.budgetMax,
        conditions: n.conditions,
        district: n.district,
        attributes: JSON.stringify(n.attributes),
        expires_at: n.expiresAt,
      };
      const publish = publishedAt ? { status: 'OPEN' as const, published_at: publishedAt } : {};
      await db
        .insertInto('needs')
        .values({ need_id: n.needId, ...row, ...publish })
        .onConflict((oc) =>
          oc.column('need_id').doUpdateSet({ ...row, ...publish, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async setNeedStatus(needId, status) {
      await db
        .updateTable('needs')
        .set({ status, updated_at: sql<Date>`now()` })
        .where('need_id', '=', needId)
        .execute();
    },

    async need(needId) {
      const r = await needsWithParent()
        .select(sql<boolean>`n.expires_at <= now()`.as('expired'))
        .where('n.need_id', '=', needId)
        .executeTakeFirst();
      return r ? { ...toNeed(r), status: r.status, expired: r.expired } : null;
    },

    async upsertListing(l) {
      const row = {
        seller_id: l.sellerId,
        category_id: l.categoryId,
        kind: l.kind,
        condition: l.condition,
        price_amount: l.priceAmount,
        price_unit: l.priceUnit,
        quantity_available: l.quantityAvailable,
        district: l.district,
        attributes: JSON.stringify(l.attributes),
        delivery_modes: l.deliveryModes,
        available: true,
      };
      await db
        .insertInto('listings')
        .values({ listing_id: l.listingId, ...row })
        .onConflict((oc) =>
          oc.column('listing_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async setListingUnavailable(listingId) {
      await db
        .updateTable('listings')
        .set({ available: false, updated_at: sql<Date>`now()` })
        .where('listing_id', '=', listingId)
        .execute();
    },

    async listing(listingId) {
      const r = await listingsWithParent().where('l.listing_id', '=', listingId).executeTakeFirst();
      return r ? toListing(r) : null;
    },

    async upsertSeller(s) {
      const row = {
        roles: s.roles,
        category_ids: s.categoryIds,
        service_districts: s.serviceDistricts,
        delivery_modes: s.deliveryModes,
        active: s.active,
      };
      await db
        .insertInto('sellers')
        .values({ account_id: s.accountId, ...row })
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async seller(accountId) {
      const r = await db
        .selectFrom('sellers')
        .selectAll()
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return r ? toSeller(r) : null;
    },

    async setReputation(accountId, r) {
      const row = {
        rating_average: r.ratingAverage === null ? null : r.ratingAverage.toFixed(2),
        rating_count: r.ratingCount,
        completed_count: r.completedCount,
      };
      await db
        .insertInto('seller_signals')
        .values({ account_id: accountId, ...row })
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async setNidVerified(accountId, verified) {
      await db
        .insertInto('seller_signals')
        .values({ account_id: accountId, nid_verified: verified })
        .onConflict((oc) =>
          oc
            .column('account_id')
            .doUpdateSet({ nid_verified: verified, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async signals(sellerIds) {
      const out = new Map<string, SellerSignals>();
      if (sellerIds.length === 0) return out;
      const rows = await db
        .selectFrom('seller_signals')
        .selectAll()
        .where('account_id', 'in', sellerIds)
        .execute();
      for (const r of rows) {
        out.set(r.account_id, {
          ratingAverage: r.rating_average === null ? null : Number(r.rating_average),
          completedCount: r.completed_count,
          nidVerified: r.nid_verified,
        });
      }
      return out;
    },

    // ---------------------------------------------------------------- candidate prefilters
    async listingCandidates(need, q) {
      if (q.kinds.length === 0) return [];
      const categories = [
        need.categoryId,
        ...(need.categoryParentId ? [need.categoryParentId] : []),
      ];
      const rows = await listingsWithParent()
        .where('l.available', '=', true)
        .where('l.quantity_available', '>=', 1)
        .where('l.seller_id', '<>', need.requesterId)
        .where('l.kind', 'in', q.kinds)
        .where((eb) =>
          eb.or([eb('l.category_id', 'in', categories), eb('c.parent_id', '=', need.categoryId)]),
        )
        .where((eb) =>
          eb.or([eb('l.district', 'in', q.districts), deliversSql('l.delivery_modes')]),
        )
        .orderBy('l.updated_at', 'desc')
        .orderBy('l.listing_id', 'desc')
        .limit(q.limit)
        .execute();
      return rows.map(toListing);
    },

    async sellerCandidates(need, q) {
      if (q.roles.length === 0) return [];
      const categories = [
        need.categoryId,
        ...(need.categoryParentId ? [need.categoryParentId] : []),
      ];
      const rows = await db
        .selectFrom('sellers')
        .selectAll()
        .where('active', '=', true)
        .where('account_id', '<>', need.requesterId)
        .where(sql<SqlBool>`roles && ${sql.val(q.roles)}::text[]`)
        .where(sql<SqlBool>`category_ids && ${sql.val(categories)}::uuid[]`)
        .where((eb) =>
          eb.or([
            sql<SqlBool>`service_districts && ${sql.val(q.districts)}::text[]`,
            deliversSql('delivery_modes'),
          ]),
        )
        .orderBy('updated_at', 'desc')
        .orderBy('account_id', 'desc')
        .limit(q.limit)
        .execute();
      return rows.map(toSeller);
    },

    async openNeeds(q) {
      if (q.modes.length === 0 || q.categoryIds.length === 0) return [];
      let query = needsWithParent()
        .where('n.status', '=', 'OPEN')
        .where('n.expires_at', '>', sql<Date>`now()`)
        .where('n.requester_id', '<>', q.excludeRequesterId)
        .where('n.mode', 'in', q.modes)
        .where((eb) =>
          eb.or([
            eb('n.category_id', 'in', q.categoryIds),
            ...(q.parentCategoryIds.length > 0
              ? [eb('c.parent_id', 'in', q.parentCategoryIds)]
              : []),
          ]),
        );
      if (q.districts !== null) {
        if (q.districts.length === 0) return [];
        query = query.where('n.district', 'in', q.districts);
      }
      const rows = await query
        .orderBy('n.published_at', 'desc')
        .orderBy('n.need_id', 'desc')
        .limit(q.limit)
        .execute();
      return rows.map(toNeed);
    },

    // ---------------------------------------------------------------- matches
    async matchesForNeed(needId) {
      const rows = await db
        .selectFrom('matches')
        .selectAll()
        .where('need_id', '=', needId)
        .execute();
      return rows.map(toMatch);
    },

    async matchesOfSeller(sellerId, needIds) {
      if (needIds.length === 0) return [];
      const rows = await db
        .selectFrom('matches')
        .selectAll()
        .where('seller_id', '=', sellerId)
        .where('need_id', 'in', needIds)
        .execute();
      return rows.map(toMatch);
    },

    async liveMatchCount(needId) {
      const r = await db
        .selectFrom('matches')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('need_id', '=', needId)
        .where('status', '<>', 'CLOSED')
        .executeTakeFirstOrThrow();
      return Number(r.n);
    },

    async insertMatch(m) {
      const r = await db
        .insertInto('matches')
        .values({
          id: m.id,
          need_id: m.needId,
          seller_id: m.sellerId,
          listing_id: m.listingId,
          candidate_type: m.candidateType,
          score: m.score,
          reasons: JSON.stringify(m.reasons),
          scorer: m.scorer,
          status: m.status,
          responded_at: null,
          dismissed_at: null,
          // Millisecond precision keeps (created_at, id) keyset cursors exact.
          created_at: sql<Date>`date_trunc('milliseconds', now())`,
        })
        .onConflict((oc) => oc.columns(['need_id', 'seller_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return r !== undefined;
    },

    async updateMatch(id, m) {
      await db
        .updateTable('matches')
        .set({
          listing_id: m.listingId,
          candidate_type: m.candidateType,
          score: m.score,
          reasons: JSON.stringify(m.reasons),
          scorer: m.scorer,
          status: m.status,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', id)
        .execute();
    },

    async applyToMatches(action, where) {
      if (where.ids && where.ids.length === 0) return 0;
      let q = db
        .updateTable('matches')
        .set({
          status: targetFor(action),
          ...(action === 'RESPOND' ? { responded_at: sql<Date>`now()` } : {}),
          ...(action === 'DISMISS' ? { dismissed_at: sql<Date>`now()` } : {}),
          updated_at: sql<Date>`now()`,
        })
        .where('status', 'in', fromStatesFor(action));
      if (where.id) q = q.where('id', '=', where.id);
      if (where.ids) q = q.where('id', 'in', where.ids);
      if (where.needId) q = q.where('need_id', '=', where.needId);
      if (where.sellerId) q = q.where('seller_id', '=', where.sellerId);
      const r = await q.executeTakeFirst();
      return Number(r.numUpdatedRows);
    },

    async match(id) {
      const r = await db.selectFrom('matches').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? toMatch(r) : null;
    },

    async pageForNeed(needId, after, limit) {
      let q = db.selectFrom('matches').selectAll().where('need_id', '=', needId);
      if (after) {
        q = q.where(sql<SqlBool>`(score, id) < (${after.k}::numeric, ${after.id}::uuid)`);
      }
      const rows = await q
        .orderBy('score', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = paginate(rows, limit, (r) => ({ k: Number(r.score), id: r.id }));
      return { items: page.items.map(toMatch), nextCursor: page.nextCursor };
    },

    async pageForSeller(sellerId, after, limit) {
      let q = db
        .selectFrom('matches as m')
        .innerJoin('needs as n', 'n.need_id', 'm.need_id')
        .selectAll('m')
        .select([
          'n.title',
          'n.mode',
          'n.category_id',
          'n.quantity',
          'n.district',
          'n.budget_min_amount',
          'n.budget_max_amount',
          'n.expires_at',
        ])
        .where('m.seller_id', '=', sellerId)
        .where('m.status', 'in', ['NEW', 'RESPONDED'])
        .where('n.status', '=', 'OPEN')
        .where('n.expires_at', '>', sql<Date>`now()`);
      if (after) {
        q = q.where(
          sql<SqlBool>`(m.created_at, m.id) < (${after.k}::timestamptz, ${after.id}::uuid)`,
        );
      }
      const rows = await q
        .orderBy('m.created_at', 'desc')
        .orderBy('m.id', 'desc')
        .limit(limit + 1)
        .execute();
      const page = paginate(rows, limit, (r) => ({ k: r.created_at.toISOString(), id: r.id }));
      return {
        items: page.items.map((r) => ({
          match: toMatch(r),
          need: {
            needId: r.need_id,
            title: r.title,
            mode: r.mode,
            categoryId: r.category_id,
            quantity: r.quantity,
            district: r.district,
            budgetMin: amount(r.budget_min_amount),
            budgetMax: amount(r.budget_max_amount),
            expiresAt: r.expires_at,
          },
        })),
        nextCursor: page.nextCursor,
      };
    },

    outbox: (events) => appendToOutbox(db, events),
  };
}

export function pgMatchingUnitOfWork(db: Kysely<MatchingDB>): MatchingUnitOfWork {
  return {
    store: pgMatchingStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgMatchingStore(trx))),
  };
}
