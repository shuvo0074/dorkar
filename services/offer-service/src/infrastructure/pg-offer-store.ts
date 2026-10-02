import { appendAudit, appendToOutbox, AppError, uuidv7 } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { OfferChange, OfferStore, OfferUnitOfWork } from '../application/ports';
import type { NeedSnapshot, Offer, OfferRound } from '../domain/offer';
import { LIVE_STATUSES } from '../domain/offer';
import type { OfferDB } from './db-schema';

type Executor = Kysely<OfferDB> | Transaction<OfferDB>;

const OFFER_COLUMNS = [
  'id',
  'need_id',
  'buyer_id',
  'seller_id',
  'listing_id',
  'status',
  'price_amount',
  'currency',
  'quantity',
  'condition',
  'delivery_terms',
  'mode_terms',
  'description',
  'attachment_media_ids',
  'expires_at',
  'current_round',
  'awaiting',
  'hidden',
  'created_at',
  'updated_at',
  'version',
] as const;
// `date` would be parsed into a local-midnight Date; keep it as the calendar date it is.
const availabilityFrom = sql<string | null>`to_char(availability_from, 'YYYY-MM-DD')`.as(
  'availability_from',
);

type OfferRow = Omit<Selectable<OfferDB['offers']>, 'availability_from'> & {
  availability_from: string | null;
};

const toOffer = (r: OfferRow): Offer => ({
  id: r.id,
  needId: r.need_id,
  buyerId: r.buyer_id,
  sellerId: r.seller_id,
  listingId: r.listing_id,
  status: r.status,
  price: { amount: Number(r.price_amount), currency: 'BDT' },
  quantity: r.quantity,
  condition: r.condition,
  availabilityFrom: r.availability_from,
  deliveryTerms: r.delivery_terms,
  modeTerms: r.mode_terms,
  description: r.description,
  attachmentMediaIds: r.attachment_media_ids,
  expiresAt: r.expires_at,
  currentRound: r.current_round,
  awaiting: r.awaiting,
  hidden: r.hidden,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const toNeed = (r: Selectable<OfferDB['need_projection']>): NeedSnapshot => ({
  needId: r.need_id,
  requesterId: r.requester_id,
  mode: r.mode,
  categoryId: r.category_id,
  title: r.title,
  quantity: r.quantity,
  maxOffers: r.max_offers,
  expiresAt: r.expires_at,
  status: r.status,
  acceptedQuantity: r.accepted_quantity,
});

const toRound = (r: Selectable<OfferDB['offer_rounds']>): OfferRound => ({
  offerId: r.offer_id,
  round: r.round,
  proposedBy: r.proposed_by,
  price: { amount: Number(r.price_amount), currency: 'BDT' },
  quantity: r.quantity,
  terms: r.terms,
  message: r.message,
  createdAt: r.created_at,
});

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

const LIVE = [...LIVE_STATUSES];
const ACTIVE = [...LIVE_STATUSES, 'ACCEPTED' as const];

export function pgOfferStore(db: Executor): OfferStore {
  const offers = () => db.selectFrom('offers').select([...OFFER_COLUMNS, availabilityFrom]);

  const get: OfferStore['get'] = async (offerId, opts = {}) => {
    let q = offers().where('id', '=', offerId);
    if (opts.forUpdate) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    return r ? toOffer(r) : null;
  };

  const addRound: OfferStore['addRound'] = async (r) => {
    await db
      .insertInto('offer_rounds')
      .values({
        offer_id: r.offerId,
        round: r.round,
        proposed_by: r.proposedBy,
        price_amount: r.price.amount,
        currency: r.price.currency,
        quantity: r.quantity,
        terms: JSON.stringify(r.terms),
        message: r.message,
      })
      .execute();
  };

  // created_at is stored at millisecond precision (see migration), so a JS Date cursor is exact.
  const olderThan = (c: { k: string | number; id: string }) =>
    sql<boolean>`(created_at, id) < (${new Date(String(c.k))}::timestamptz, ${c.id}::uuid)`;

  const needQuery = (needId: string) =>
    db.selectFrom('need_projection').selectAll().where('need_id', '=', needId);

  return {
    async now() {
      const { rows } = await sql<{ now: Date }>`select now() as now`.execute(db);
      return rows[0]!.now;
    },

    async need(needId) {
      const r = await needQuery(needId).executeTakeFirst();
      return r ? toNeed(r) : null;
    },
    async lockNeed(needId) {
      const r = await needQuery(needId).forUpdate().executeTakeFirst();
      return r ? toNeed(r) : null;
    },
    async upsertNeedFacts(f, status) {
      const facts = {
        requester_id: f.requesterId,
        mode: f.mode,
        category_id: f.categoryId,
        title: f.title,
        quantity: f.quantity,
        max_offers: f.maxOffers,
        expires_at: f.expiresAt,
      };
      await db
        .insertInto('need_projection')
        .values({ need_id: f.needId, ...facts, status: status ?? 'OPEN' })
        .onConflict((oc) =>
          oc.column('need_id').doUpdateSet({
            ...facts,
            ...(status ? { status } : {}),
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    },
    async setNeedStatus(needId, status) {
      const r = await db
        .updateTable('need_projection')
        .set({ status, updated_at: sql<Date>`now()` })
        .where('need_id', '=', needId)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async addAcceptedQuantity(needId, delta) {
      await db
        .updateTable('need_projection')
        .set((eb) => ({
          accepted_quantity: sql<number>`greatest(0, ${eb.ref('accepted_quantity')} + ${delta})`,
          updated_at: sql<Date>`now()`,
        }))
        .where('need_id', '=', needId)
        .execute();
    },
    async listing(listingId) {
      const r = await db
        .selectFrom('listing_projection')
        .selectAll()
        .where('listing_id', '=', listingId)
        .executeTakeFirst();
      return r ? { listingId: r.listing_id, sellerId: r.seller_id, available: r.available } : null;
    },
    async upsertListing(l) {
      const row = { seller_id: l.sellerId, available: l.available };
      await db
        .insertInto('listing_projection')
        .values({ listing_id: l.listingId, ...row })
        .onConflict((oc) =>
          oc.column('listing_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    get,
    async insert(o, round) {
      try {
        await db
          .insertInto('offers')
          .values({
            id: o.id,
            need_id: o.needId,
            buyer_id: o.buyerId,
            seller_id: o.sellerId,
            listing_id: o.listingId,
            status: o.status,
            price_amount: o.price.amount,
            currency: o.price.currency,
            quantity: o.quantity,
            condition: o.condition,
            availability_from: o.availabilityFrom,
            delivery_terms: JSON.stringify(o.deliveryTerms),
            mode_terms: JSON.stringify(o.modeTerms),
            description: o.description,
            attachment_media_ids: o.attachmentMediaIds,
            expires_at: o.expiresAt,
            current_round: o.currentRound,
            awaiting: o.awaiting,
          })
          .execute();
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError('CONFLICT', 'You already have an offer on this need.', {
            rule: 'DUPLICATE_OFFER',
          });
        }
        throw err;
      }
      await addRound(round);
      return (await get(o.id))!;
    },
    async countActiveOnNeed(needId) {
      const r = await db
        .selectFrom('offers')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('need_id', '=', needId)
        .where('status', 'in', ACTIVE)
        .executeTakeFirstOrThrow();
      return Number(r.n);
    },
    async hasLiveOffer(needId, sellerId) {
      const r = await db
        .selectFrom('offers')
        .select('id')
        .where('need_id', '=', needId)
        .where('seller_id', '=', sellerId)
        .where('status', 'in', LIVE)
        .executeTakeFirst();
      return !!r;
    },
    async transition(offer, to, c: OfferChange) {
      const r = await db
        .updateTable('offers')
        .set((eb) => ({
          status: to,
          ...(c.awaiting !== undefined ? { awaiting: c.awaiting } : {}),
          ...(c.price !== undefined ? { price_amount: c.price.amount } : {}),
          ...(c.quantity !== undefined ? { quantity: c.quantity } : {}),
          ...(c.deliveryTerms !== undefined
            ? { delivery_terms: JSON.stringify(c.deliveryTerms) }
            : {}),
          ...(c.modeTerms !== undefined ? { mode_terms: JSON.stringify(c.modeTerms) } : {}),
          ...(c.condition !== undefined ? { condition: c.condition } : {}),
          ...(c.availabilityFrom !== undefined ? { availability_from: c.availabilityFrom } : {}),
          ...(c.currentRound !== undefined ? { current_round: c.currentRound } : {}),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', offer.id)
        .where('status', '=', offer.status)
        .where('version', '=', offer.version)
        .returning([...OFFER_COLUMNS, availabilityFrom])
        .executeTakeFirst();
      return r ? toOffer(r) : null;
    },
    addRound,
    async rounds(offerId) {
      const rows = await db
        .selectFrom('offer_rounds')
        .selectAll()
        .where('offer_id', '=', offerId)
        .orderBy('round', 'asc')
        .execute();
      return rows.map(toRound);
    },
    async latestRound(offerId) {
      const r = await db
        .selectFrom('offer_rounds')
        .selectAll()
        .where('offer_id', '=', offerId)
        .orderBy('round', 'desc')
        .limit(1)
        .executeTakeFirstOrThrow();
      return toRound(r);
    },
    async recordStatus(offerId, from, to, reason, actorId) {
      await db
        .insertInto('offer_status_history')
        .values({
          id: uuidv7(),
          offer_id: offerId,
          from_status: from,
          to_status: to,
          reason,
          actor_id: actorId,
        })
        .execute();
    },
    async history(offerId) {
      const rows = await db
        .selectFrom('offer_status_history')
        .selectAll()
        .where('offer_id', '=', offerId)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute();
      return rows.map((r) => ({
        from: r.from_status,
        to: r.to_status,
        reason: r.reason,
        actorId: r.actor_id,
        at: r.created_at,
      }));
    },
    async liveOnNeed(needId, exceptId) {
      let q = offers().where('need_id', '=', needId).where('status', 'in', LIVE);
      if (exceptId) q = q.where('id', '<>', exceptId);
      const rows = await q.orderBy('id').forUpdate().execute();
      return rows.map(toOffer);
    },
    async dueForExpiry(limit) {
      const rows = await offers()
        .where('status', 'in', LIVE)
        .where('expires_at', '<=', sql<Date>`now()`)
        .orderBy('expires_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map(toOffer);
    },
    async setHidden(offerId, hidden) {
      const r = await db
        .updateTable('offers')
        .set((eb) => ({ hidden, updated_at: sql<Date>`now()`, version: eb('version', '+', 1) }))
        .where('id', '=', offerId)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async listForNeed(needId, sort, q) {
      let query = offers().where('need_id', '=', needId).where('hidden', '=', false);
      if (q.status) query = query.where('status', '=', q.status);
      if (sort === 'price_asc') {
        if (q.cursor) {
          query = query.where(
            sql<boolean>`(price_amount, id) > (${Number(q.cursor.k)}::bigint, ${q.cursor.id}::uuid)`,
          );
        }
        query = query.orderBy('price_amount', 'asc').orderBy('id', 'asc');
      } else {
        if (q.cursor) query = query.where(olderThan(q.cursor));
        query = query.orderBy('created_at', 'desc').orderBy('id', 'desc');
      }
      return (await query.limit(q.take).execute()).map(toOffer);
    },
    async listForSeller(sellerId, q) {
      let query = offers().where('seller_id', '=', sellerId).where('hidden', '=', false);
      if (q.status) query = query.where('status', '=', q.status);
      if (q.cursor) query = query.where(olderThan(q.cursor));
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.take)
        .execute();
      return rows.map(toOffer);
    },

    outbox: (events) => appendToOutbox(db, events),
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgOfferUnitOfWork(db: Kysely<OfferDB>): OfferUnitOfWork {
  return {
    store: pgOfferStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgOfferStore(trx))),
  };
}
