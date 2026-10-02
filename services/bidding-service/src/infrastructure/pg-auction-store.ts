import { appendAudit, appendToOutbox, AppError, uuidv7 } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { AuctionChange, AuctionStore, AuctionUnitOfWork } from '../application/ports';
import { ACTIVE_BID_STATUSES, LIVE_STATUSES, type Auction, type Bid } from '../domain/auction';
import type { BiddingDB } from './db-schema';

type Executor = Kysely<BiddingDB> | Transaction<BiddingDB>;

const bdt = (amount: number | string) => ({ amount: Number(amount), currency: 'BDT' as const });
const bdtOrNull = (amount: number | string | null) => (amount === null ? null : bdt(amount));

const toAuction = (r: Selectable<BiddingDB['auctions']>): Auction => ({
  id: r.id,
  kind: r.kind,
  ownerId: r.owner_id,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  categoryId: r.category_id,
  title: r.title,
  district: r.district,
  mode: r.mode,
  quantity: r.quantity,
  startPrice: bdt(r.start_price_amount),
  reservePrice: bdtOrNull(r.reserve_price_amount),
  minIncrement: bdt(r.min_increment_amount),
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  antiSnipeSeconds: r.anti_snipe_seconds,
  status: r.status,
  leadingBidId: r.leading_bid_id,
  leadingAmount: bdtOrNull(r.leading_amount),
  bidCount: r.bid_count,
  hidden: r.hidden,
  cancelReason: r.cancel_reason,
  closedAt: r.closed_at,
  transactionId: r.transaction_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

interface BidRow {
  id: string;
  seq: string;
  auction_id: string;
  bidder_id: string;
  alias: number;
  amount: string;
  status: Bid['status'];
  placed_at: Date;
  retracted_at: Date | null;
}

const toBid = (r: BidRow): Bid => ({
  id: r.id,
  seq: Number(r.seq),
  auctionId: r.auction_id,
  bidderId: r.bidder_id,
  alias: r.alias,
  amount: bdt(r.amount),
  status: r.status,
  placedAt: r.placed_at,
  retractedAt: r.retracted_at,
});

const BID_COLUMNS = [
  'b.id',
  'b.seq',
  'b.auction_id',
  'b.bidder_id',
  'ab.alias',
  'b.amount',
  'b.status',
  'b.placed_at',
  'b.retracted_at',
] as const;

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

const LIVE = [...LIVE_STATUSES];
const ACTIVE = [...ACTIVE_BID_STATUSES];

export function pgAuctionStore(db: Executor): AuctionStore {
  const bids = () =>
    db
      .selectFrom('bids as b')
      .innerJoin('auction_bidders as ab', (j) =>
        j.onRef('ab.auction_id', '=', 'b.auction_id').onRef('ab.bidder_id', '=', 'b.bidder_id'),
      )
      .select(BID_COLUMNS);

  const getBid: AuctionStore['getBid'] = async (bidId, opts = {}) => {
    let q = bids().where('b.id', '=', bidId);
    if (opts.forUpdate) q = q.forUpdate('b');
    const r = await q.executeTakeFirst();
    return r ? toBid(r) : null;
  };

  const get: AuctionStore['get'] = async (auctionId, opts = {}) => {
    let q = db.selectFrom('auctions').selectAll().where('id', '=', auctionId);
    if (opts.forUpdate) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    return r ? toAuction(r) : null;
  };

  // Timestamps written from JS Dates (ms precision), so a JS Date cursor is exact.
  const newestFirst = (c: { k: string | number; id: string }) =>
    sql<boolean>`(created_at, id) < (${new Date(String(c.k))}::timestamptz, ${c.id}::uuid)`;
  const olderSeq = (c: { k: string | number; id: string }) =>
    sql<boolean>`b.seq < ${Number(c.k)}::bigint`;

  return {
    async now() {
      const { rows } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db);
      return rows[0]!.now;
    },

    // ------------------------------------------------------------ projections
    async listing(listingId) {
      const r = await db
        .selectFrom('listing_projection')
        .selectAll()
        .where('listing_id', '=', listingId)
        .executeTakeFirst();
      return r
        ? {
            listingId: r.listing_id,
            sellerId: r.seller_id,
            categoryId: r.category_id,
            kind: r.kind,
            title: r.title,
            district: r.district,
            price: bdt(r.price_amount),
            quantityAvailable: r.quantity_available,
            available: r.available,
          }
        : null;
    },
    async upsertListing(l) {
      const row = {
        seller_id: l.sellerId,
        category_id: l.categoryId,
        kind: l.kind,
        title: l.title,
        district: l.district,
        price_amount: l.price.amount,
        quantity_available: l.quantityAvailable,
        available: l.available,
      };
      await db
        .insertInto('listing_projection')
        .values({ listing_id: l.listingId, ...row })
        .onConflict((oc) =>
          oc.column('listing_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },
    async setListingUnavailable(listingId) {
      const r = await db
        .updateTable('listing_projection')
        .set({ available: false, updated_at: sql<Date>`now()` })
        .where('listing_id', '=', listingId)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async need(needId) {
      const r = await db
        .selectFrom('need_projection')
        .selectAll()
        .where('need_id', '=', needId)
        .executeTakeFirst();
      return r
        ? {
            needId: r.need_id,
            requesterId: r.requester_id,
            mode: r.mode,
            categoryId: r.category_id,
            title: r.title,
            district: r.district,
            budgetMax: bdtOrNull(r.budget_max_amount),
            quantity: r.quantity,
            status: r.status,
          }
        : null;
    },
    async upsertNeed(n, status) {
      const facts = {
        requester_id: n.requesterId,
        mode: n.mode,
        category_id: n.categoryId,
        title: n.title,
        district: n.district,
        budget_max_amount: n.budgetMax?.amount ?? null,
        quantity: n.quantity,
      };
      await db
        .insertInto('need_projection')
        .values({ need_id: n.needId, ...facts, status: status ?? 'OPEN' })
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

    // ------------------------------------------------------------ auctions
    get,
    async insert(a) {
      try {
        const r = await db
          .insertInto('auctions')
          .values({
            id: a.id,
            kind: a.kind,
            owner_id: a.ownerId,
            subject_type: a.subjectType,
            subject_id: a.subjectId,
            category_id: a.categoryId,
            title: a.title,
            district: a.district,
            mode: a.mode,
            quantity: a.quantity,
            start_price_amount: a.startPrice.amount,
            reserve_price_amount: a.reservePrice?.amount ?? null,
            min_increment_amount: a.minIncrement.amount,
            starts_at: a.startsAt,
            ends_at: a.endsAt,
            anti_snipe_seconds: a.antiSnipeSeconds,
            status: a.status,
            leading_bid_id: null,
            leading_amount: null,
            cancel_reason: null,
            closed_at: null,
            transaction_id: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toAuction(r);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new AppError(
            'CONFLICT',
            'There is already a live auction for this ' +
              (a.subjectType === 'LISTING' ? 'listing.' : 'need.'),
            { rule: 'AUCTION_ALREADY_LIVE' },
          );
        }
        throw err;
      }
    },
    async update(a, to, c: AuctionChange) {
      const r = await db
        .updateTable('auctions')
        .set((eb) => ({
          status: to,
          ...(c.leadingBidId !== undefined ? { leading_bid_id: c.leadingBidId } : {}),
          ...(c.leadingAmount !== undefined
            ? { leading_amount: c.leadingAmount?.amount ?? null }
            : {}),
          ...(c.bidCount !== undefined ? { bid_count: c.bidCount } : {}),
          ...(c.endsAt !== undefined ? { ends_at: c.endsAt } : {}),
          ...(c.cancelReason !== undefined ? { cancel_reason: c.cancelReason } : {}),
          ...(c.closedAt !== undefined ? { closed_at: c.closedAt } : {}),
          ...(c.transactionId !== undefined ? { transaction_id: c.transactionId } : {}),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', a.id)
        .where('status', '=', a.status)
        .where('version', '=', a.version)
        .returningAll()
        .executeTakeFirst();
      return r ? toAuction(r) : null;
    },
    async setHidden(auctionId, hidden) {
      const r = await db
        .updateTable('auctions')
        .set((eb) => ({ hidden, updated_at: sql<Date>`now()`, version: eb('version', '+', 1) }))
        .where('id', '=', auctionId)
        .executeTakeFirst();
      return r.numUpdatedRows > 0n;
    },
    async recordStatus(auctionId, from, to, reason, actorId) {
      await db
        .insertInto('auction_status_history')
        .values({
          id: uuidv7(),
          auction_id: auctionId,
          from_status: from,
          to_status: to,
          reason,
          actor_id: actorId,
        })
        .execute();
    },
    async history(auctionId) {
      const rows = await db
        .selectFrom('auction_status_history')
        .selectAll()
        .where('auction_id', '=', auctionId)
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
    async liveForSubject(subjectType, subjectId) {
      const rows = await db
        .selectFrom('auctions')
        .selectAll()
        .where('subject_type', '=', subjectType)
        .where('subject_id', '=', subjectId)
        .where('status', 'in', LIVE)
        .orderBy('id')
        .forUpdate()
        .execute();
      return rows.map(toAuction);
    },
    async dueToOpen(limit) {
      const rows = await db
        .selectFrom('auctions')
        .selectAll()
        .where('status', '=', 'SCHEDULED')
        .where('starts_at', '<=', sql<Date>`clock_timestamp()`)
        .orderBy('starts_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map(toAuction);
    },
    async dueToClose(limit) {
      const rows = await db
        .selectFrom('auctions')
        .selectAll()
        .where('status', '=', 'OPEN')
        .where('ends_at', '<=', sql<Date>`clock_timestamp()`)
        .orderBy('ends_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map(toAuction);
    },
    async browse(q) {
      let query = db
        .selectFrom('auctions')
        .selectAll()
        .where('status', '=', q.status)
        .where('hidden', '=', false);
      if (q.kind) query = query.where('kind', '=', q.kind);
      if (q.categoryId) query = query.where('category_id', '=', q.categoryId);
      if (q.district) query = query.where('district', '=', q.district as never);
      if (q.cursor) {
        query = query.where(
          sql<boolean>`(ends_at, id) > (${new Date(String(q.cursor.k))}::timestamptz, ${q.cursor.id}::uuid)`,
        );
      }
      const rows = await query
        .orderBy('ends_at', 'asc')
        .orderBy('id', 'asc')
        .limit(q.take)
        .execute();
      return rows.map(toAuction);
    },
    async listForOwner(ownerId, q) {
      let query = db.selectFrom('auctions').selectAll().where('owner_id', '=', ownerId);
      if (q.status) query = query.where('status', '=', q.status);
      if (q.cursor) query = query.where(newestFirst(q.cursor));
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.take)
        .execute();
      return rows.map(toAuction);
    },
    async listAll(q) {
      let query = db.selectFrom('auctions').selectAll();
      if (q.status) query = query.where('status', '=', q.status);
      if (q.cursor) query = query.where(newestFirst(q.cursor));
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.take)
        .execute();
      return rows.map(toAuction);
    },

    // ------------------------------------------------------------ bids
    getBid,
    async ensureBidder(auctionId, bidderId) {
      const existing = await db
        .selectFrom('auction_bidders')
        .select('alias')
        .where('auction_id', '=', auctionId)
        .where('bidder_id', '=', bidderId)
        .executeTakeFirst();
      if (existing) return existing.alias;
      const { max } = await db
        .selectFrom('auction_bidders')
        .select((eb) => eb.fn.max('alias').as('max'))
        .where('auction_id', '=', auctionId)
        .executeTakeFirstOrThrow();
      const alias = (max ?? 0) + 1;
      await db
        .insertInto('auction_bidders')
        .values({ auction_id: auctionId, bidder_id: bidderId, alias })
        .execute();
      return alias;
    },
    async insertBid(b) {
      const r = await db
        .insertInto('bids')
        .values({
          id: b.id,
          auction_id: b.auctionId,
          bidder_id: b.bidderId,
          amount: b.amount.amount,
          currency: b.amount.currency,
          status: 'LEADING',
          idempotency_key: b.idempotencyKey,
          placed_at: b.placedAt,
          retracted_at: null,
        })
        .onConflict((oc) => oc.columns(['auction_id', 'bidder_id', 'idempotency_key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return r ? getBid(r.id) : null;
    },
    async bidByKey(auctionId, bidderId, key) {
      const r = await bids()
        .where('b.auction_id', '=', auctionId)
        .where('b.bidder_id', '=', bidderId)
        .where('b.idempotency_key', '=', key)
        .executeTakeFirst();
      return r ? toBid(r) : null;
    },
    async setBidStatus(bidId, from, to) {
      const r = await db
        .updateTable('bids')
        .set({
          status: to,
          updated_at: sql<Date>`now()`,
          ...(to === 'RETRACTED' ? { retracted_at: sql<Date>`clock_timestamp()` } : {}),
        })
        .where('id', '=', bidId)
        .where('status', '=', from)
        .executeTakeFirst();
      return r.numUpdatedRows === 1n;
    },
    async settleBids(auctionId, to, exceptBidId) {
      let q = db
        .updateTable('bids')
        .set({ status: to, updated_at: sql<Date>`now()` })
        .where('auction_id', '=', auctionId)
        .where('status', 'in', ACTIVE);
      if (exceptBidId) q = q.where('id', '<>', exceptBidId);
      const r = await q.executeTakeFirst();
      return Number(r.numUpdatedRows);
    },
    async bestRemaining(auctionId, kind) {
      const r = await bids()
        .where('b.auction_id', '=', auctionId)
        .where('b.status', '=', 'OUTBID')
        .orderBy('b.amount', kind === 'FORWARD' ? 'desc' : 'asc')
        .orderBy('b.seq', 'asc')
        .limit(1)
        .forUpdate('b')
        .executeTakeFirst();
      return r ? toBid(r) : null;
    },
    async distinctBidders(auctionId) {
      const rows = await db
        .selectFrom('auction_bidders')
        .select('bidder_id')
        .where('auction_id', '=', auctionId)
        .orderBy('alias')
        .execute();
      return rows.map((r) => r.bidder_id);
    },
    async latestBidOf(auctionId, bidderId) {
      const r = await bids()
        .where('b.auction_id', '=', auctionId)
        .where('b.bidder_id', '=', bidderId)
        .orderBy('b.seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      return r ? toBid(r) : null;
    },
    async listBids(auctionId, q) {
      let query = bids().where('b.auction_id', '=', auctionId);
      if (q.status) query = query.where('b.status', '=', q.status);
      if (q.cursor) query = query.where(olderSeq(q.cursor));
      const rows = await query.orderBy('b.seq', 'desc').limit(q.take).execute();
      return rows.map(toBid);
    },
    async listBidsOf(bidderId, q) {
      let query = bids()
        .innerJoin('auctions as a', 'a.id', 'b.auction_id')
        .select([
          'a.kind as a_kind',
          'a.title as a_title',
          'a.status as a_status',
          'a.ends_at as a_ends_at',
          'a.leading_amount as a_leading_amount',
          'a.hidden as a_hidden',
          'a.owner_id as a_owner_id',
        ])
        .where('b.bidder_id', '=', bidderId)
        .where('a.hidden', '=', false);
      if (q.status) query = query.where('b.status', '=', q.status);
      if (q.cursor) query = query.where(olderSeq(q.cursor));
      const rows = await query.orderBy('b.seq', 'desc').limit(q.take).execute();
      return rows.map((r) => ({
        bid: toBid(r),
        auction: {
          id: r.auction_id,
          kind: r.a_kind,
          title: r.a_title,
          status: r.a_status,
          endsAt: r.a_ends_at,
          leadingAmount: bdtOrNull(r.a_leading_amount),
          hidden: r.a_hidden,
          ownerId: r.a_owner_id,
        },
      }));
    },

    outbox: (events) => appendToOutbox(db, events),
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgAuctionUnitOfWork(db: Kysely<BiddingDB>): AuctionUnitOfWork {
  return {
    store: pgAuctionStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgAuctionStore(trx))),
  };
}
