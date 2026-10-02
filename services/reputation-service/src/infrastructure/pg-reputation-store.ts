import type { TransactionState } from '@dorkar/contracts';
import { appendAudit, appendToOutbox } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ReputationStore, ReputationUnitOfWork } from '../application/ports';
import type { Review } from '../domain/review';
import { fromSignalRows, toSignalRows } from '../domain/signals';
import type { ReputationDB } from './db-schema';

type Executor = Kysely<ReputationDB> | Transaction<ReputationDB>;

const toReview = (r: Selectable<ReputationDB['reviews']>): Review => ({
  id: r.id,
  transactionId: r.transaction_id,
  authorId: r.author_id,
  subjectId: r.subject_id,
  authorRole: r.author_role,
  rating: r.rating,
  comment: r.comment,
  status: r.status,
  createdAt: r.created_at,
});

export function pgReputationStore(db: Executor): ReputationStore {
  return {
    async recordTransactionCreated(f) {
      await db
        .insertInto('transactions')
        .values({
          id: f.id,
          buyer_id: f.buyerId,
          seller_id: f.sellerId,
          mode: f.mode,
          amount: f.amount,
          currency: f.currency,
          state: 'CREATED',
          state_at: f.at,
        })
        // A state change may have arrived first: fill in the facts, keep its state.
        .onConflict((oc) =>
          oc.column('id').doUpdateSet({
            mode: f.mode,
            amount: f.amount,
            currency: f.currency,
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    },

    async recordStateChange(f) {
      await db
        .insertInto('transactions')
        .values({
          id: f.id,
          buyer_id: f.buyerId,
          seller_id: f.sellerId,
          state: f.to,
          state_at: f.at,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      // The latest state wins (by occurrence time); milestones are sticky once reached, so
      // late or out-of-order delivery never loses or double counts them.
      await db
        .updateTable('transactions')
        .set({
          state: sql<TransactionState>`case when state_at <= ${f.at} then ${f.to} else state end`,
          state_at: sql<Date>`greatest(state_at, ${f.at})`,
          ...(f.to === 'COMPLETED'
            ? { completed_at: sql<Date>`coalesce(completed_at, ${f.at})` }
            : {}),
          ...(f.to === 'DISPUTED'
            ? { disputed_at: sql<Date>`coalesce(disputed_at, ${f.at})` }
            : {}),
          ...(f.to === 'CANCELLED' && f.actorId
            ? { cancelled_by: sql<string>`coalesce(cancelled_by, ${f.actorId}::uuid)` }
            : {}),
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', f.id)
        .execute();
    },

    async transaction(id) {
      const [{ now }, t] = await Promise.all([
        sql<{ now: Date }>`select now() as now`.execute(db).then((r) => r.rows[0]!),
        db
          .selectFrom('transactions')
          .select(['id', 'buyer_id', 'seller_id', 'state', 'completed_at'])
          .where('id', '=', id)
          .executeTakeFirst(),
      ]);
      return {
        now,
        tx: t
          ? {
              id: t.id,
              buyerId: t.buyer_id,
              sellerId: t.seller_id,
              state: t.state,
              completedAt: t.completed_at,
            }
          : null,
      };
    },

    async insertReview(r) {
      const row = await db
        .insertInto('reviews')
        .values({
          id: r.id,
          transaction_id: r.transactionId,
          author_id: r.authorId,
          subject_id: r.subjectId,
          author_role: r.authorRole,
          rating: r.rating,
          comment: r.comment,
        })
        .onConflict((oc) => oc.columns(['transaction_id', 'author_id']).doNothing())
        .returningAll()
        .executeTakeFirst();
      return row ? toReview(row) : null;
    },

    async reviewsForTransaction(transactionId) {
      const rows = await db
        .selectFrom('reviews')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .execute();
      return rows.map(toReview);
    },

    async visibleReviewsAbout(subjectId, cursor, limit) {
      let q = db
        .selectFrom('reviews')
        .selectAll()
        .where('subject_id', '=', subjectId)
        .where('status', '=', 'VISIBLE');
      if (cursor) {
        q = q.where((eb) =>
          eb(
            eb.refTuple('created_at', 'id'),
            '<',
            eb.tuple(new Date(cursor.k), cursor.id) as never,
          ),
        );
      }
      const rows = await q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      return rows.map(toReview);
    },

    async reviews(status, cursor, limit) {
      let q = db.selectFrom('reviews').selectAll();
      if (status) q = q.where('status', '=', status);
      if (cursor) {
        q = q.where((eb) =>
          eb(
            eb.refTuple('created_at', 'id'),
            '<',
            eb.tuple(new Date(cursor.k), cursor.id) as never,
          ),
        );
      }
      const rows = await q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit + 1)
        .execute();
      return rows.map(toReview);
    },

    async setReviewStatus(id, status) {
      const row = await db
        .updateTable('reviews')
        .set({ status, updated_at: sql<Date>`now()` })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirst();
      return row ? toReview(row) : null;
    },

    async lockAccounts(ids) {
      for (const id of ids) {
        await sql`select pg_advisory_xact_lock(hashtextextended(${'reputation:' + id}, 0))`.execute(
          db,
        );
      }
    },

    async computeStats(accountId) {
      // Raw fragments name columns only: tables go through the builder (schema-scoped).
      const n = (expr: ReturnType<typeof sql>) => sql<string>`${expr}`;
      const r = await db
        .selectFrom('transactions')
        .select([
          n(sql`count(*) filter (where completed_at is not null)`).as('completed'),
          n(sql`count(*) filter (where completed_at is not null and seller_id = ${accountId})`).as(
            'as_seller',
          ),
          n(sql`count(*) filter (where completed_at is not null and buyer_id = ${accountId})`).as(
            'as_buyer',
          ),
          n(sql`count(*) filter (where cancelled_by = ${accountId})`).as('cancelled'),
          n(sql`count(*) filter (where disputed_at is not null)`).as('disputed'),
          n(
            sql`count(distinct case when buyer_id = ${accountId} then seller_id else buyer_id end) filter (where completed_at is not null and buyer_id <> seller_id)`,
          ).as('counterparties'),
        ])
        .where((eb) => eb.or([eb('buyer_id', '=', accountId), eb('seller_id', '=', accountId)]))
        .executeTakeFirstOrThrow();
      return {
        accountId,
        completedCount: Number(r.completed),
        cancelledCount: Number(r.cancelled),
        disputedCount: Number(r.disputed),
        asSellerCompleted: Number(r.as_seller),
        asBuyerCompleted: Number(r.as_buyer),
        distinctCounterparties: Number(r.counterparties),
      };
    },

    async saveStats(s) {
      const row = {
        completed_count: s.completedCount,
        cancelled_count: s.cancelledCount,
        disputed_count: s.disputedCount,
        as_seller_completed: s.asSellerCompleted,
        as_buyer_completed: s.asBuyerCompleted,
      };
      await db
        .insertInto('account_stats')
        .values({ account_id: s.accountId, ...row })
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async ratingInputs(subjectId, pairCap) {
      // Pair cap applied in SQL to bound the rows read; the domain applies it again.
      const rows = await db
        .selectFrom((eb) =>
          eb
            .selectFrom('reviews')
            .select([
              'id',
              'author_id',
              'rating',
              'created_at',
              sql<number>`row_number() over (partition by author_id order by created_at desc, id desc)`.as(
                'rn',
              ),
            ])
            .where('subject_id', '=', subjectId)
            .where('status', '=', 'VISIBLE')
            .as('r'),
        )
        .select(['id', 'author_id', 'rating', 'created_at'])
        .where('rn', '<=', pairCap)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        authorId: r.author_id,
        rating: r.rating,
        createdAt: r.created_at,
      }));
    },

    async saveSignals(accountId, signals) {
      await db
        .insertInto('reputation_signals')
        .values(
          toSignalRows(signals).map((r) => ({
            account_id: accountId,
            signal: r.signal,
            value: r.value === null ? null : String(r.value),
          })),
        )
        .onConflict((oc) =>
          oc.columns(['account_id', 'signal']).doUpdateSet((eb) => ({
            value: eb.ref('excluded.value'),
            computed_at: sql<Date>`now()`,
          })),
        )
        .execute();
    },

    async signals(accountId) {
      const rows = await db
        .selectFrom('reputation_signals')
        .select(['signal', 'value'])
        .where('account_id', '=', accountId)
        .execute();
      return fromSignalRows(
        rows.map((r) => ({ signal: r.signal, value: r.value === null ? null : Number(r.value) })),
      );
    },

    outbox: (events) => appendToOutbox(db, events),
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgReputationUnitOfWork(db: Kysely<ReputationDB>): ReputationUnitOfWork {
  return {
    store: pgReputationStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgReputationStore(trx))),
  };
}
