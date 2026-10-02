import { appendAudit, appendToOutbox, Errors, uuidv7 } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { CatalogStore, CatalogUnitOfWork, CategoryPatch } from '../application/ports';
import { MAX_CATEGORY_DEPTH, type Category } from '../domain/category';
import type { Listing, ListingContent } from '../domain/listing';
import type { CatalogDB } from './db-schema';

type Executor = Kysely<CatalogDB> | Transaction<CatalogDB>;

const toCategory = (r: Selectable<CatalogDB['categories']>): Category => ({
  id: r.id,
  parentId: r.parent_id,
  slug: r.slug,
  nameEn: r.name_en,
  nameBn: r.name_bn,
  modes: r.modes,
  attributeSchema: r.attribute_schema,
  sort: r.sort,
  active: r.active,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Every listing column except the generated `search` vector. */
const LISTING_COLUMNS = [
  'id',
  'seller_id',
  'category_id',
  'kind',
  'condition',
  'title',
  'description',
  'price_amount',
  'currency',
  'price_unit',
  'quantity_available',
  'attributes',
  'district',
  'area',
  'delivery_modes',
  'media_ids',
  'status',
  'hidden_from',
  'hidden_reason',
  'stock_sold_out',
  'published_at',
  'created_at',
  'updated_at',
  'version',
] as const;

type ListingRow = Pick<Selectable<CatalogDB['listings']>, (typeof LISTING_COLUMNS)[number]>;

const toListing = (r: ListingRow): Listing => ({
  id: r.id,
  sellerId: r.seller_id,
  categoryId: r.category_id,
  kind: r.kind,
  condition: r.condition,
  title: r.title,
  description: r.description,
  price: { amount: Number(r.price_amount), currency: 'BDT' },
  priceUnit: r.price_unit,
  quantityAvailable: r.quantity_available,
  attributes: r.attributes,
  district: r.district,
  area: r.area,
  deliveryModes: r.delivery_modes,
  mediaIds: r.media_ids,
  status: r.status,
  hiddenFrom: r.hidden_from,
  hiddenReason: r.hidden_reason,
  stockSoldOut: r.stock_sold_out,
  publishedAt: r.published_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const contentRow = (c: ListingContent) => ({
  category_id: c.categoryId,
  kind: c.kind,
  condition: c.condition,
  title: c.title,
  description: c.description,
  price_amount: c.price.amount,
  currency: c.price.currency,
  price_unit: c.priceUnit,
  quantity_available: c.quantityAvailable,
  attributes: JSON.stringify(c.attributes),
  district: c.district,
  area: c.area,
  delivery_modes: c.deliveryModes,
  media_ids: c.mediaIds,
});

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

/** Millisecond precision so keyset cursors (JS Dates) round-trip exactly. */
const nowMs = sql<Date>`date_trunc('milliseconds', now())`;

export function pgCatalogStore(db: Executor): CatalogStore {
  const category = async (id: string) => {
    const r = await db.selectFrom('categories').selectAll().where('id', '=', id).executeTakeFirst();
    return r ? toCategory(r) : null;
  };
  const listing = async (id: string) => {
    const r = await db
      .selectFrom('listings')
      .select(LISTING_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? toListing(r) : null;
  };

  return {
    async allCategories() {
      const rows = await db.selectFrom('categories').selectAll().orderBy('sort').execute();
      return rows.map(toCategory);
    },
    category,
    async categoryForUpdate(id) {
      const r = await db
        .selectFrom('categories')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      return r ? toCategory(r) : null;
    },
    async categoryChain(id) {
      const chain: string[] = [];
      let next: string | null = id;
      // Bounded walk: the tree is shallow, and the bound also stops any corrupt loop.
      while (next !== null && chain.length <= MAX_CATEGORY_DEPTH + 1) {
        const r: { parent_id: string | null } | undefined = await db
          .selectFrom('categories')
          .select('parent_id')
          .where('id', '=', next)
          .executeTakeFirst();
        if (!r) break;
        chain.push(next);
        next = r.parent_id;
      }
      return chain;
    },
    async insertCategory(c) {
      try {
        const r = await db
          .insertInto('categories')
          .values({
            id: c.id,
            parent_id: c.parentId,
            slug: c.slug,
            name_en: c.nameEn,
            name_bn: c.nameBn,
            modes: c.modes,
            attribute_schema: JSON.stringify(c.attributeSchema),
            sort: c.sort,
            active: c.active,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toCategory(r);
      } catch (err) {
        if (isUniqueViolation(err)) throw Errors.conflict('A category with this slug exists.');
        throw err;
      }
    },
    async updateCategory(id, p: CategoryPatch) {
      try {
        const r = await db
          .updateTable('categories')
          .set((eb) => ({
            ...(p.parentId !== undefined ? { parent_id: p.parentId } : {}),
            ...(p.slug !== undefined ? { slug: p.slug } : {}),
            ...(p.nameEn !== undefined ? { name_en: p.nameEn } : {}),
            ...(p.nameBn !== undefined ? { name_bn: p.nameBn } : {}),
            ...(p.modes !== undefined ? { modes: p.modes } : {}),
            ...(p.attributeSchema !== undefined
              ? { attribute_schema: JSON.stringify(p.attributeSchema) }
              : {}),
            ...(p.sort !== undefined ? { sort: p.sort } : {}),
            ...(p.active !== undefined ? { active: p.active } : {}),
            updated_at: sql<Date>`now()`,
            version: eb('version', '+', 1),
          }))
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return toCategory(r);
      } catch (err) {
        if (isUniqueViolation(err)) throw Errors.conflict('A category with this slug exists.');
        throw err;
      }
    },

    async insertListing(l) {
      const r = await db
        .insertInto('listings')
        .values({ id: l.id, seller_id: l.sellerId, ...contentRow(l) })
        .returning(LISTING_COLUMNS)
        .executeTakeFirstOrThrow();
      return toListing(r);
    },
    listing,
    async ownedListing(id, sellerId) {
      const r = await db
        .selectFrom('listings')
        .select(LISTING_COLUMNS)
        .where('id', '=', id)
        .where('seller_id', '=', sellerId)
        .executeTakeFirst();
      return r ? toListing(r) : null;
    },
    async updateListingContent(id, expected, content) {
      const r = await db
        .updateTable('listings')
        .set((eb) => ({
          ...contentRow(content),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('status', '=', expected.status)
        .where('version', '=', expected.version)
        .returning(LISTING_COLUMNS)
        .executeTakeFirst();
      return r ? toListing(r) : null;
    },
    async changeStatus(c) {
      const r = await db
        .updateTable('listings')
        .set((eb) => ({
          status: c.to,
          hidden_from: c.hiddenFrom,
          hidden_reason: c.hiddenReason,
          stock_sold_out: c.stockSoldOut,
          ...(c.to === 'PUBLISHED'
            ? { published_at: sql<Date>`coalesce(published_at, ${nowMs})` }
            : {}),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', c.id)
        .where('status', '=', c.expectedStatus)
        .where('version', '=', c.expectedVersion)
        .returning(LISTING_COLUMNS)
        .executeTakeFirst();
      return r ? toListing(r) : null;
    },
    async appendHistory(h) {
      await db
        .insertInto('listing_status_history')
        .values({
          id: uuidv7(),
          listing_id: h.listingId,
          from_status: h.from,
          to_status: h.to,
          actor_id: h.actorId,
          actor_type: h.actorType,
          reason: h.reason,
        })
        .execute();
    },
    async listingForUpdate(id) {
      const r = await db
        .selectFrom('listings')
        .select(LISTING_COLUMNS)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      return r ? toListing(r) : null;
    },
    async changeStock(id, expectedVersion, c) {
      const r = await db
        .updateTable('listings')
        .set((eb) => ({
          quantity_available: c.quantity,
          stock_sold_out: c.stockSoldOut,
          ...(c.hiddenFrom !== undefined ? { hidden_from: c.hiddenFrom } : {}),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('version', '=', expectedVersion)
        .returning(LISTING_COLUMNS)
        .executeTakeFirst();
      return r ? toListing(r) : null;
    },
    async insertReservation(r) {
      const inserted = await db
        .insertInto('stock_reservations')
        .values({
          transaction_id: r.transactionId,
          listing_id: r.listingId,
          requested_quantity: r.requestedQuantity,
          quantity: r.quantity,
        })
        .onConflict((oc) => oc.column('transaction_id').doNothing())
        .returning('transaction_id')
        .executeTakeFirst();
      return !!inserted;
    },
    async reservationForUpdate(transactionId) {
      const r = await db
        .selectFrom('stock_reservations')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .forUpdate()
        .executeTakeFirst();
      return r
        ? {
            transactionId: r.transaction_id,
            listingId: r.listing_id,
            requestedQuantity: r.requested_quantity,
            quantity: r.quantity,
            status: r.status,
          }
        : null;
    },
    async setReservationStatus(transactionId, status) {
      await db
        .updateTable('stock_reservations')
        .set({ status, updated_at: sql<Date>`now()` })
        .where('transaction_id', '=', transactionId)
        .execute();
    },
    async searchListings(s) {
      let q = db
        .selectFrom('listings')
        .select(LISTING_COLUMNS)
        .where('status', '=', 'PUBLISHED')
        .limit(s.limit);
      if (s.q) q = q.where(sql<boolean>`search @@ websearch_to_tsquery('simple', ${s.q})`);
      if (s.categoryId) {
        const categoryId = s.categoryId;
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
      if (s.district) q = q.where('district', '=', s.district);
      if (s.kind) q = q.where('kind', '=', s.kind);
      if (s.condition) q = q.where('condition', '=', s.condition);
      if (s.minPrice !== undefined) q = q.where('price_amount', '>=', s.minPrice as never);
      if (s.maxPrice !== undefined) q = q.where('price_amount', '<=', s.maxPrice as never);

      const c = s.cursor;
      switch (s.sort) {
        case 'newest':
          if (c) {
            q = q.where((eb) =>
              eb(eb.refTuple('published_at', 'id'), '<', eb.tuple(new Date(c.k), c.id) as never),
            );
          }
          q = q.orderBy('published_at', 'desc').orderBy('id', 'desc');
          break;
        case 'price_asc':
          if (c) {
            q = q.where((eb) =>
              eb(eb.refTuple('price_amount', 'id'), '>', eb.tuple(String(c.k), c.id)),
            );
          }
          q = q.orderBy('price_amount', 'asc').orderBy('id', 'asc');
          break;
        case 'price_desc':
          if (c) {
            q = q.where((eb) =>
              eb(eb.refTuple('price_amount', 'id'), '<', eb.tuple(String(c.k), c.id)),
            );
          }
          q = q.orderBy('price_amount', 'desc').orderBy('id', 'desc');
          break;
      }
      return (await q.execute()).map(toListing);
    },
    async listingsBySeller(sellerId, opts) {
      let q = db
        .selectFrom('listings')
        .select(LISTING_COLUMNS)
        .where('seller_id', '=', sellerId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(opts.limit);
      if (opts.status) q = q.where('status', '=', opts.status);
      const c = opts.cursor;
      if (c) {
        q = q.where((eb) =>
          eb(eb.refTuple('created_at', 'id'), '<', eb.tuple(new Date(c.k), c.id) as never),
        );
      }
      return (await q.execute()).map(toListing);
    },

    outbox: (events) => appendToOutbox(db, events),
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgCatalogUnitOfWork(db: Kysely<CatalogDB>): CatalogUnitOfWork {
  return {
    store: pgCatalogStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgCatalogStore(trx))),
  };
}
