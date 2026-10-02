import { sql, type Kysely } from 'kysely';
import type { DashboardReader, PersonalCounts } from '../application/ports';
import {
  ACTIVE_BOOKING_STATUSES,
  ACTIVE_LOAN_STATUSES,
  AWAITING_BUYER_OFFER_STATUSES,
  Metrics,
  OPEN_DISPUTE_STATUSES,
  UPCOMING_BOOKING_STATUSES,
  type Metric,
} from '../domain/metrics';
import type { DashboardDB } from './db-schema';

const LIVE_BOOKINGS = [...UPCOMING_BOOKING_STATUSES, ...ACTIVE_BOOKING_STATUSES];
const METRIC_SET = new Set<string>(Metrics);

const byStatus = (rows: ReadonlyArray<{ status: string | null; n: string | number }>) => {
  const out: Record<string, number> = {};
  for (const r of rows) if (r.status) out[r.status] = Number(r.n);
  return out;
};

export function pgDashboardReader(db: Kysely<DashboardDB>): DashboardReader {
  const countWhere = async (
    q: Promise<{ n: string | number | bigint } | undefined>,
  ): Promise<number> => Number((await q)?.n ?? 0);
  const n = sql<string>`count(*)`.as('n');

  const sumMetric = async (metric: Metric, from: string, to: string) =>
    Number(
      (
        await db
          .selectFrom('daily_metrics')
          .select(sql<string>`coalesce(sum(value), 0)`.as('v'))
          .where('metric', '=', metric)
          .where('dimension', '=', '')
          .where('day', '>=', from)
          .where('day', '<=', to)
          .executeTakeFirst()
      )?.v ?? 0,
    );

  return {
    async gauges() {
      const [needs, listings, tx, disputes, verifs, auctions, upcoming, active, loans] =
        await Promise.all([
          db
            .selectFrom('needs')
            .select(['status', n])
            .where('status', 'is not', null)
            .groupBy('status')
            .execute(),
          countWhere(
            db.selectFrom('listings').select(n).where('status', '=', 'ACTIVE').executeTakeFirst(),
          ),
          db
            .selectFrom('transactions')
            .select(['status', n, sql<string>`coalesce(sum(amount), 0)`.as('amount')])
            .where('status', 'is not', null)
            .groupBy('status')
            .orderBy('status')
            .execute(),
          countWhere(
            db
              .selectFrom('disputes')
              .select(n)
              .where('status', 'in', OPEN_DISPUTE_STATUSES)
              .executeTakeFirst(),
          ),
          countWhere(
            db
              .selectFrom('verifications')
              .select(n)
              .where('status', '=', 'PENDING')
              .executeTakeFirst(),
          ),
          countWhere(
            db.selectFrom('auctions').select(n).where('status', '=', 'OPEN').executeTakeFirst(),
          ),
          countWhere(
            db
              .selectFrom('bookings')
              .select(n)
              .where('status', 'in', UPCOMING_BOOKING_STATUSES)
              .executeTakeFirst(),
          ),
          countWhere(
            db
              .selectFrom('bookings')
              .select(n)
              .where('status', 'in', ACTIVE_BOOKING_STATUSES)
              .executeTakeFirst(),
          ),
          countWhere(
            db
              .selectFrom('loans')
              .select(n)
              .where('status', 'in', ACTIVE_LOAN_STATUSES)
              .executeTakeFirst(),
          ),
        ]);
      return {
        needsByStatus: byStatus(needs),
        activeListings: listings,
        transactionsByState: tx.map((r) => ({
          state: r.status ?? '',
          count: Number(r.n),
          amount: { amount: Number(r.amount), currency: 'BDT' as const },
        })),
        openDisputes: disputes,
        pendingVerifications: verifs,
        liveAuctions: auctions,
        upcomingBookings: upcoming,
        activeBookings: active,
        activeLoans: loans,
      };
    },

    async totals(from, to) {
      const rows = await db
        .selectFrom('daily_metrics')
        .select(['metric', sql<string>`sum(value)`.as('v')])
        .where('dimension', '=', '')
        .where('day', '>=', from)
        .where('day', '<=', to)
        .groupBy('metric')
        .execute();
      const out: Partial<Record<Metric, number>> = {};
      for (const r of rows) if (METRIC_SET.has(r.metric)) out[r.metric as Metric] = Number(r.v);
      return out;
    },

    async daily(metric, dimension, from, to) {
      const rows = await db
        .selectFrom('daily_metrics')
        .select([sql<string>`day::text`.as('day'), 'value'])
        .where('metric', '=', metric)
        .where('dimension', '=', dimension)
        .where('day', '>=', from)
        .where('day', '<=', to)
        .orderBy('day')
        .execute();
      return rows.map((r) => ({ day: r.day, value: Number(r.value) }));
    },

    async funnel(from, to) {
      const [needsPublished, needsWithOffer, offersAccepted, transactionsCompleted] =
        await Promise.all([
          sumMetric('needs_published', from, to),
          countWhere(
            db
              .selectFrom('needs')
              .select(n)
              .where('published_day', '>=', from)
              .where('published_day', '<=', to)
              .where('first_offer_at', 'is not', null)
              .executeTakeFirst(),
          ),
          sumMetric('offers_accepted', from, to),
          sumMetric('transactions_completed', from, to),
        ]);
      return { needsPublished, needsWithOffer, offersAccepted, transactionsCompleted };
    },

    async personal(me, limit) {
      const sumAmount = (side: 'buyer_id' | 'seller_id') =>
        db
          .selectFrom('transactions')
          .select(sql<string>`coalesce(sum(amount), 0)`.as('n'))
          .where(side, '=', me)
          .where('status', '=', 'COMPLETED')
          .executeTakeFirst();
      const txByState = (side: 'buyer_id' | 'seller_id') =>
        db
          .selectFrom('transactions')
          .select(['status', n])
          .where(side, '=', me)
          .groupBy('status')
          .execute();

      const [
        openNeeds,
        awaiting,
        buyerTx,
        spent,
        offersSent,
        sellerTx,
        earned,
        rep,
        ownedAuctions,
        biddingAuctions,
        bookingCounts,
        bookingItems,
        loanCounts,
        loanItems,
        openDisputes,
        disputeItems,
      ] = await Promise.all([
        countWhere(
          db
            .selectFrom('needs')
            .select(n)
            .where('requester_id', '=', me)
            .where('status', '=', 'OPEN')
            .executeTakeFirst(),
        ),
        countWhere(
          db
            .selectFrom('offers')
            .select(n)
            .where('buyer_id', '=', me)
            .where('status', 'in', AWAITING_BUYER_OFFER_STATUSES)
            .executeTakeFirst(),
        ),
        txByState('buyer_id'),
        countWhere(sumAmount('buyer_id')),
        db
          .selectFrom('offers')
          .select(['status', n])
          .where('seller_id', '=', me)
          .groupBy('status')
          .execute(),
        txByState('seller_id'),
        countWhere(sumAmount('seller_id')),
        db.selectFrom('reputations').selectAll().where('account_id', '=', me).executeTakeFirst(),
        db
          .selectFrom('auctions')
          .select(['auction_id', 'ends_at'])
          .where('owner_id', '=', me)
          .where('status', '=', 'OPEN')
          .orderBy('ends_at', sql`asc nulls last`)
          .execute(),
        db
          .selectFrom('auction_bidders as b')
          .innerJoin('auctions as a', 'a.auction_id', 'b.auction_id')
          .select(['a.auction_id', 'a.ends_at'])
          .where('b.bidder_id', '=', me)
          .where('a.owner_id', '<>', me)
          .where('a.status', '=', 'OPEN')
          .orderBy('a.ends_at', sql`asc nulls last`)
          .execute(),
        db
          .selectFrom('bookings')
          .select([
            sql<string>`count(*) filter (where renter_id = ${me})`.as('renter'),
            sql<string>`count(*) filter (where owner_id = ${me})`.as('owner'),
          ])
          .where((eb) => eb.or([eb('renter_id', '=', me), eb('owner_id', '=', me)]))
          .where('status', 'in', LIVE_BOOKINGS)
          .executeTakeFirst(),
        db
          .selectFrom('bookings')
          .select(['booking_id', 'listing_id', 'owner_id', 'status', 'start_at', 'end_at'])
          .where((eb) => eb.or([eb('renter_id', '=', me), eb('owner_id', '=', me)]))
          .where('status', 'in', LIVE_BOOKINGS)
          .orderBy('start_at', sql`asc nulls last`)
          .orderBy('booking_id')
          .limit(limit)
          .execute(),
        db
          .selectFrom('loans')
          .select([
            sql<string>`count(*) filter (where lender_id = ${me})`.as('lender'),
            sql<string>`count(*) filter (where borrower_id = ${me})`.as('borrower'),
          ])
          .where((eb) => eb.or([eb('lender_id', '=', me), eb('borrower_id', '=', me)]))
          .where('status', 'in', ACTIVE_LOAN_STATUSES)
          .executeTakeFirst(),
        db
          .selectFrom('loans')
          .select(['loan_id', 'item_id', 'lender_id', 'status', 'return_by'])
          .where((eb) => eb.or([eb('lender_id', '=', me), eb('borrower_id', '=', me)]))
          .where('status', 'in', ACTIVE_LOAN_STATUSES)
          .orderBy('return_by', sql`asc nulls last`)
          .orderBy('loan_id')
          .limit(limit)
          .execute(),
        countWhere(
          db
            .selectFrom('disputes')
            .select(n)
            .where((eb) => eb.or([eb('buyer_id', '=', me), eb('seller_id', '=', me)]))
            .where('status', 'in', OPEN_DISPUTE_STATUSES)
            .executeTakeFirst(),
        ),
        db
          .selectFrom('disputes')
          .select(['dispute_id', 'transaction_id', 'buyer_id', 'status'])
          .where((eb) => eb.or([eb('buyer_id', '=', me), eb('seller_id', '=', me)]))
          .where('status', 'in', OPEN_DISPUTE_STATUSES)
          .orderBy('status_at', 'desc')
          .limit(limit)
          .execute(),
      ]);

      const live: PersonalCounts['auctions']['live'] = [
        ...ownedAuctions.map((a) => ({
          auctionId: a.auction_id,
          role: 'OWNER' as const,
          endsAt: a.ends_at,
        })),
        ...biddingAuctions.map((a) => ({
          auctionId: a.auction_id,
          role: 'BIDDER' as const,
          endsAt: a.ends_at,
        })),
      ]
        .sort(
          (x, y) =>
            (x.endsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
            (y.endsAt?.getTime() ?? Number.MAX_SAFE_INTEGER),
        )
        .slice(0, limit);

      return {
        openNeeds,
        offersAwaitingResponse: awaiting,
        buyerTransactions: byStatus(buyerTx),
        totalSpent: spent,
        offersSentByStatus: byStatus(offersSent),
        sellerTransactions: byStatus(sellerTx),
        earnings: earned,
        rating: rep
          ? {
              average: rep.rating_average === null ? null : Number(rep.rating_average),
              count: rep.rating_count,
              completedCount: rep.completed_count,
            }
          : null,
        auctions: { owned: ownedAuctions.length, bidding: biddingAuctions.length, live },
        bookings: {
          asRenter: Number(bookingCounts?.renter ?? 0),
          asOwner: Number(bookingCounts?.owner ?? 0),
          items: bookingItems.map((b) => ({
            bookingId: b.booking_id,
            listingId: b.listing_id,
            role: b.owner_id === me ? ('OWNER' as const) : ('RENTER' as const),
            status: b.status ?? '',
            startAt: b.start_at,
            endAt: b.end_at,
          })),
        },
        loans: {
          asLender: Number(loanCounts?.lender ?? 0),
          asBorrower: Number(loanCounts?.borrower ?? 0),
          items: loanItems.map((l) => ({
            loanId: l.loan_id,
            itemId: l.item_id,
            role: l.lender_id === me ? ('LENDER' as const) : ('BORROWER' as const),
            status: l.status ?? '',
            returnBy: l.return_by,
          })),
        },
        disputes: {
          open: openDisputes,
          items: disputeItems.map((d) => ({
            disputeId: d.dispute_id,
            transactionId: d.transaction_id,
            role: d.buyer_id === me ? ('BUYER' as const) : ('SELLER' as const),
            status: d.status ?? '',
          })),
        },
      };
    },
  };
}
