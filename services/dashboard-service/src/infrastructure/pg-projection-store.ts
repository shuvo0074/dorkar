import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';
import type { ProjectionStore, StatusEvent } from '../application/ports';
import { mergeIncrements } from '../domain/metrics';
import type { DashboardDB } from './db-schema';

type Executor = Kysely<DashboardDB> | Transaction<DashboardDB>;
type StatusTable =
  | 'needs'
  | 'offers'
  | 'listings'
  | 'transactions'
  | 'disputes'
  | 'verifications'
  | 'auctions'
  | 'bookings'
  | 'loans';

/** How a non-key fact merges into an existing row. */
type Merge = 'new' | 'keep' | 'least' | 'greatest';

/**
 * Insert-or-update of a status projection row in one statement. The status moves only if the
 * event passes the same guard as the domain's `shouldApply`: newer event time wins; on an exact
 * tie only an event whose `from` matches the current status. A `null` status event only fills
 * facts. Table and column references inside raw fragments are left unqualified on purpose: in
 * ON CONFLICT they denote the (schema-qualified) target row.
 */
async function guardedUpsert(
  db: Executor,
  table: StatusTable,
  keys: readonly string[],
  facts: Record<string, unknown>,
  merge: Readonly<Record<string, Merge>>,
  s: StatusEvent<string> | null,
): Promise<void> {
  const ref = (c: string) => sql.ref(`${table}.${c}`);
  const row: Record<string, unknown> = { status: s?.status ?? null, status_at: s?.at ?? null };
  for (const [k, v] of Object.entries(facts)) if (v !== undefined) row[k] = v;

  const guard = sql<boolean>`(excluded.status_at is not null and (
      ${ref('status_at')} is null
      or excluded.status_at > ${ref('status_at')}
      or (excluded.status_at = ${ref('status_at')} and ${ref('status')} = ${s?.from ?? null}::text)))`;
  const set: Record<string, RawBuilder<unknown>> = {
    status: sql`case when ${guard} then excluded.status else ${ref('status')} end`,
    status_at: sql`case when ${guard} then excluded.status_at else ${ref('status_at')} end`,
  };
  for (const [c, m] of Object.entries(merge)) {
    const x = sql.ref(`excluded.${c}`);
    const t = ref(c);
    set[c] =
      m === 'new'
        ? sql`coalesce(${x}, ${t})`
        : m === 'keep'
          ? sql`coalesce(${t}, ${x})`
          : m === 'least'
            ? sql`least(${t}, ${x})`
            : sql`greatest(${t}, ${x})`;
  }
  // Dynamic table: the typed builder cannot express it, the statement shape is fixed above.
  const loose = db as unknown as Kysely<Record<string, Record<string, unknown>>>;
  await loose
    .insertInto(table)
    .values(row)
    .onConflict((oc) => oc.columns(keys).doUpdateSet(set))
    .execute();
}

export function pgProjectionStore(db: Executor): ProjectionStore {
  return {
    async increment(day, incs) {
      const rows = mergeIncrements(incs).map((i) => ({
        day,
        metric: i.metric,
        dimension: i.dimension,
        value: i.by,
      }));
      if (rows.length === 0) return;
      await db
        .insertInto('daily_metrics')
        .values(rows)
        .onConflict((oc) =>
          oc.columns(['day', 'metric', 'dimension']).doUpdateSet({
            value: sql<string>`daily_metrics.value + excluded.value`,
          }),
        )
        .execute();
    },

    upsertNeed: (r, s) =>
      guardedUpsert(
        db,
        'needs',
        ['need_id'],
        {
          need_id: r.needId,
          requester_id: r.requesterId,
          published_day: r.publishedDay,
          first_offer_at: r.firstOfferAt,
        },
        { published_day: 'keep', first_offer_at: 'least' },
        s,
      ),

    upsertOffer: (r, s) =>
      guardedUpsert(
        db,
        'offers',
        ['offer_id'],
        { offer_id: r.offerId, need_id: r.needId, buyer_id: r.buyerId, seller_id: r.sellerId },
        {},
        s,
      ),

    upsertListing: (r, s) =>
      guardedUpsert(
        db,
        'listings',
        ['listing_id'],
        { listing_id: r.listingId, seller_id: r.sellerId },
        {},
        s,
      ),

    upsertTransaction: (r, s) =>
      guardedUpsert(
        db,
        'transactions',
        ['transaction_id'],
        {
          transaction_id: r.transactionId,
          buyer_id: r.buyerId,
          seller_id: r.sellerId,
          source_type: r.sourceType,
          mode: r.mode,
          amount: r.amount,
        },
        { mode: 'keep', amount: 'keep' },
        s,
      ),

    async markCompleted(transactionId, at) {
      const r = await db
        .updateTable('transactions')
        .set({ completed_at: at })
        .where('transaction_id', '=', transactionId)
        .where('completed_at', 'is', null)
        .returning('transaction_id')
        .executeTakeFirst();
      return !!r;
    },

    async claimGmv(transactionId) {
      const r = await db
        .updateTable('transactions')
        .set({ gmv_counted: true })
        .where('transaction_id', '=', transactionId)
        .where('completed_at', 'is not', null)
        .where('amount', 'is not', null)
        .where('gmv_counted', '=', false)
        .returning(['amount', 'completed_at'])
        .executeTakeFirst();
      return r && r.completed_at
        ? { amount: Number(r.amount), completedAt: new Date(r.completed_at) }
        : null;
    },

    upsertDispute: (r, s) =>
      guardedUpsert(
        db,
        'disputes',
        ['dispute_id'],
        {
          dispute_id: r.disputeId,
          transaction_id: r.transactionId,
          buyer_id: r.buyerId,
          seller_id: r.sellerId,
        },
        {},
        s,
      ),

    upsertVerification: (r, s) =>
      guardedUpsert(
        db,
        'verifications',
        ['account_id', 'kind'],
        { account_id: r.accountId, kind: r.kind },
        {},
        s,
      ),

    upsertAuction: (r, s) =>
      guardedUpsert(
        db,
        'auctions',
        ['auction_id'],
        { auction_id: r.auctionId, owner_id: r.ownerId, ends_at: r.endsAt },
        // Anti-sniping only ever extends the end.
        { ends_at: 'greatest' },
        s,
      ),

    async addBidders(auctionId, bidderIds) {
      const ids = [...new Set(bidderIds)];
      if (ids.length === 0) return;
      await db
        .insertInto('auction_bidders')
        .values(ids.map((bidder_id) => ({ auction_id: auctionId, bidder_id })))
        .onConflict((oc) => oc.columns(['auction_id', 'bidder_id']).doNothing())
        .execute();
    },

    upsertBooking: (r, s) =>
      guardedUpsert(
        db,
        'bookings',
        ['booking_id'],
        {
          booking_id: r.bookingId,
          listing_id: r.listingId,
          owner_id: r.ownerId,
          renter_id: r.renterId,
          start_at: r.startAt,
          end_at: r.endAt,
        },
        { start_at: 'new', end_at: 'new' },
        s,
      ),

    upsertLoan: (r, s) =>
      guardedUpsert(
        db,
        'loans',
        ['loan_id'],
        {
          loan_id: r.loanId,
          item_id: r.itemId,
          lender_id: r.lenderId,
          borrower_id: r.borrowerId,
          return_by: r.returnBy,
        },
        { return_by: 'new' },
        s,
      ),

    async setReputation(accountId, r, at) {
      const row = {
        rating_average: r.ratingAverage === null ? null : r.ratingAverage.toFixed(2),
        rating_count: r.ratingCount,
        completed_count: r.completedCount,
        updated_at: at,
      };
      await db
        .insertInto('reputations')
        .values({ account_id: accountId, ...row })
        .onConflict((oc) =>
          oc
            .column('account_id')
            .doUpdateSet(row)
            .where(sql<boolean>`reputations.updated_at <= excluded.updated_at`),
        )
        .execute();
    },
  };
}
