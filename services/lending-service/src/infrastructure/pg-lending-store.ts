import { appendAudit, appendToOutbox, AppError, uuidv7, type Cursor } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type {
  LendingStore,
  LendingUnitOfWork,
  LendItemPatch,
  LoanListQuery,
} from '../application/ports';
import type { LendItem } from '../domain/lend-item';
import { BLOCKING_STATUSES, marksReturn, type Loan } from '../domain/loan';
import type { LendingDB } from './db-schema';

type Executor = Kysely<LendingDB> | Transaction<LendingDB>;

const num = (v: string | null) => (v === null ? null : Number(v));

const toItem = (r: Selectable<LendingDB['lend_items']>): LendItem => ({
  id: r.id,
  lenderId: r.lender_id,
  categoryId: r.category_id,
  title: r.title,
  description: r.description,
  condition: r.condition,
  district: r.district,
  mediaIds: r.media_ids,
  depositAmount: num(r.deposit_amount),
  maxLoanDays: r.max_loan_days,
  requirements: {
    nidVerified: r.req_nid_verified,
    minCompletedDeals: r.req_min_completed_deals,
    minRating: num(r.req_min_rating),
  },
  active: r.active,
  hidden: r.hidden,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const toLoan = (r: Selectable<LendingDB['loans']>): Loan => ({
  id: r.id,
  itemId: r.item_id,
  lenderId: r.lender_id,
  borrowerId: r.borrower_id,
  itemTitle: r.item_title,
  categoryId: r.category_id,
  startAt: r.start_at,
  returnBy: r.return_by,
  message: r.message,
  depositAmount: num(r.deposit_amount),
  status: r.status,
  transactionId: r.transaction_id,
  declineReason: r.decline_reason,
  returnedAt: r.returned_at,
  overdueNotifiedAt: r.overdue_notified_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

/** Every item column except the generated `search` vector. */
const ITEM_COLUMNS = [
  'id',
  'lender_id',
  'category_id',
  'title',
  'description',
  'condition',
  'district',
  'media_ids',
  'deposit_amount',
  'currency',
  'max_loan_days',
  'req_nid_verified',
  'req_min_completed_deals',
  'req_min_rating',
  'active',
  'hidden',
  'created_at',
  'updated_at',
  'version',
] as const;

const pgCode = (err: unknown) =>
  typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;

const rating = (v: number | null) => (v === null ? null : v.toFixed(2));

const keyset = (c: Cursor) =>
  sql<boolean>`(created_at, id) < (${new Date(c.k)}::timestamptz, ${c.id}::uuid)`;

export function pgLendingStore(db: Executor): LendingStore {
  const loanPage = (q: LoanListQuery) => {
    let query = db.selectFrom('loans').selectAll();
    if (q.status) query = query.where('status', '=', q.status);
    if (q.cursor) query = query.where(keyset(q.cursor));
    return query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(q.limit + 1);
  };

  const loadLoan = async (id: string, forUpdate = false) => {
    let q = db
      .selectFrom('loans')
      .selectAll()
      .select(sql<Date>`now()`.as('db_now'))
      .where('id', '=', id);
    if (forUpdate) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    return r ? { value: toLoan(r), now: r.db_now } : null;
  };

  return {
    async now() {
      const { rows } = await sql<{ now: Date }>`select now() as now`.execute(db);
      return rows[0]!.now;
    },

    // ------------------------------------------------------------ items

    async item(id, opts = {}) {
      let q = db.selectFrom('lend_items').select(ITEM_COLUMNS).where('id', '=', id);
      if (opts.forUpdate) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toItem(r) : null;
    },

    async insertItem(i) {
      const r = await db
        .insertInto('lend_items')
        .values({
          id: i.id,
          lender_id: i.lenderId,
          category_id: i.categoryId,
          title: i.title,
          description: i.description,
          condition: i.condition,
          district: i.district,
          media_ids: i.mediaIds,
          deposit_amount: i.depositAmount,
          max_loan_days: i.maxLoanDays,
          req_nid_verified: i.requirements.nidVerified,
          req_min_completed_deals: i.requirements.minCompletedDeals,
          req_min_rating: rating(i.requirements.minRating),
        })
        .returning(ITEM_COLUMNS)
        .executeTakeFirstOrThrow();
      return toItem(r);
    },

    async updateItem(id, p: LendItemPatch) {
      const r = await db
        .updateTable('lend_items')
        .set((eb) => ({
          ...(p.categoryId !== undefined ? { category_id: p.categoryId } : {}),
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
          ...(p.condition !== undefined ? { condition: p.condition } : {}),
          ...(p.district !== undefined ? { district: p.district } : {}),
          ...(p.mediaIds !== undefined ? { media_ids: p.mediaIds } : {}),
          ...(p.depositAmount !== undefined ? { deposit_amount: p.depositAmount } : {}),
          ...(p.maxLoanDays !== undefined ? { max_loan_days: p.maxLoanDays } : {}),
          ...(p.requirements !== undefined
            ? {
                req_nid_verified: p.requirements.nidVerified,
                req_min_completed_deals: p.requirements.minCompletedDeals,
                req_min_rating: rating(p.requirements.minRating),
              }
            : {}),
          ...(p.active !== undefined ? { active: p.active } : {}),
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .returning(ITEM_COLUMNS)
        .executeTakeFirstOrThrow();
      return toItem(r);
    },

    async setItemHidden(id, hidden) {
      const r = await db
        .updateTable('lend_items')
        .set((eb) => ({ hidden, updated_at: sql<Date>`now()`, version: eb('version', '+', 1) }))
        .where('id', '=', id)
        .returning(ITEM_COLUMNS)
        .executeTakeFirst();
      return r ? toItem(r) : null;
    },

    async searchItems(s) {
      let q = db
        .selectFrom('lend_items')
        .select(ITEM_COLUMNS)
        .where('active', '=', true)
        .where('hidden', '=', false);
      if (s.q) q = q.where(sql<boolean>`search @@ websearch_to_tsquery('simple', ${s.q})`);
      if (s.categoryId) q = q.where('category_id', '=', s.categoryId);
      if (s.district) q = q.where('district', '=', s.district);
      if (s.cursor) q = q.where(keyset(s.cursor));
      const rows = await q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(s.limit + 1)
        .execute();
      return rows.map(toItem);
    },

    async itemsOf(lenderId, q) {
      let query = db
        .selectFrom('lend_items')
        .select(ITEM_COLUMNS)
        .where('lender_id', '=', lenderId);
      if (q.cursor) query = query.where(keyset(q.cursor));
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.limit + 1)
        .execute();
      return rows.map(toItem);
    },

    async lenderStats(lenderId) {
      const r = await db
        .selectFrom('loans')
        .select([
          sql<string>`count(*) filter (where status in ('RETURNED','CLOSED'))`.as('completed'),
          sql<string>`count(*) filter (where returned_at is not null)`.as('returned'),
          sql<string>`count(*) filter (where returned_at is not null and returned_at <= return_by)`.as(
            'on_time',
          ),
        ])
        .where('lender_id', '=', lenderId)
        .executeTakeFirstOrThrow();
      const returned = Number(r.returned);
      return {
        completedLoans: Number(r.completed),
        onTimeReturnRate:
          returned === 0 ? null : Math.round((Number(r.on_time) / returned) * 1000) / 1000,
      };
    },

    // ------------------------------------------------------------ loans

    loan: (id, opts = {}) => loadLoan(id, opts.forUpdate),

    async insertLoan(l) {
      try {
        const r = await db
          .insertInto('loans')
          .values({
            id: l.id,
            item_id: l.itemId,
            lender_id: l.lenderId,
            borrower_id: l.borrowerId,
            item_title: l.itemTitle,
            category_id: l.categoryId,
            start_at: l.startAt,
            return_by: l.returnBy,
            message: l.message,
            deposit_amount: l.depositAmount,
            transaction_id: null,
            decline_reason: null,
            returned_at: null,
            overdue_notified_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toLoan(r);
      } catch (err) {
        if (pgCode(err) === '23505') {
          throw new AppError(
            'CONFLICT',
            'You already have an open request for this item. Wait for the lender or cancel it first.',
            { rule: 'LOAN_ALREADY_REQUESTED' },
          );
        }
        throw err;
      }
    },

    async transitionLoan(id, guard, to, p) {
      const now = sql<Date>`now()`;
      try {
        const r = await db
          .updateTable('loans')
          .set((eb) => ({
            status: to,
            ...(p.declineReason !== undefined ? { decline_reason: p.declineReason } : {}),
            ...(p.transactionId !== undefined ? { transaction_id: p.transactionId } : {}),
            ...(marksReturn(to) ? { returned_at: sql<Date>`coalesce(returned_at, now())` } : {}),
            updated_at: now,
            version: eb('version', '+', 1),
          }))
          .where('id', '=', id)
          .where('status', '=', guard.from)
          .where('version', '=', guard.version)
          .returningAll()
          .executeTakeFirst();
        return r ? toLoan(r) : null;
      } catch (err) {
        // EXCLUDE USING gist (item_id WITH =, period WITH &&): the item is already promised.
        if (pgCode(err) === '23P01') {
          throw new AppError(
            'CONFLICT',
            'This item is already lent or promised for part of that period.',
            { rule: 'LOAN_CONFLICT' },
          );
        }
        throw err;
      }
    },

    async hasBlockingOverlap(loan) {
      const r = await db
        .selectFrom('loans')
        .select('id')
        .where('item_id', '=', loan.itemId)
        .where('id', '<>', loan.id)
        .where('status', 'in', BLOCKING_STATUSES)
        .where(
          sql<boolean>`period && tstzrange(${loan.startAt}::timestamptz, ${loan.returnBy}::timestamptz, '[)')`,
        )
        .limit(1)
        .executeTakeFirst();
      return !!r;
    },

    async setTransactionId(loanId, transactionId) {
      const r = await db
        .updateTable('loans')
        .set({ transaction_id: transactionId, updated_at: sql<Date>`now()` })
        .where('id', '=', loanId)
        .where('transaction_id', 'is', null)
        .returningAll()
        .executeTakeFirst();
      return r ? toLoan(r) : null;
    },

    async markOverdueNotified(loanId) {
      const r = await db
        .updateTable('loans')
        .set({ overdue_notified_at: sql<Date>`now()` })
        .where('id', '=', loanId)
        .where('overdue_notified_at', 'is', null)
        .where('status', 'in', ['LENT', 'RETURN_REPORTED'])
        .where('return_by', '<', sql<Date>`now()`)
        .executeTakeFirst();
      return r.numUpdatedRows === 1n;
    },

    async appendTransition(t) {
      await db
        .insertInto('loan_transitions')
        .values({
          id: uuidv7(),
          loan_id: t.loanId,
          from_status: t.from,
          to_status: t.to,
          command: t.command,
          actor_id: t.actorId,
          actor_role: t.actorRole,
          reason: t.reason,
        })
        .execute();
    },

    async transitions(loanId) {
      const rows = await db
        .selectFrom('loan_transitions')
        .selectAll()
        .where('loan_id', '=', loanId)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        loanId: r.loan_id,
        from: r.from_status,
        to: r.to_status,
        command: r.command,
        actorId: r.actor_id,
        actorRole: r.actor_role,
        reason: r.reason,
        at: r.at,
      }));
    },

    async loansForParty(accountId, role, q) {
      let query = loanPage(q);
      if (role === 'lender') query = query.where('lender_id', '=', accountId);
      else if (role === 'borrower') query = query.where('borrower_id', '=', accountId);
      else
        query = query.where((eb) =>
          eb.or([eb('lender_id', '=', accountId), eb('borrower_id', '=', accountId)]),
        );
      return (await query.execute()).map(toLoan);
    },

    async allLoans(q) {
      return (await loanPage(q).execute()).map(toLoan);
    },

    async dueForExpiry(ttlMs, limit) {
      const rows = await db
        .selectFrom('loans')
        .select('id')
        .where('status', '=', 'REQUESTED')
        .where('created_at', '<=', sql<Date>`now() - ${ttlMs} * interval '1 millisecond'`)
        .orderBy('created_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map((r) => r.id);
    },

    async dueForOverdue(limit) {
      const rows = await db
        .selectFrom('loans')
        .select('id')
        .where('status', 'in', ['LENT', 'RETURN_REPORTED'])
        .where('overdue_notified_at', 'is', null)
        .where('return_by', '<', sql<Date>`now()`)
        .orderBy('return_by')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map((r) => r.id);
    },

    // ------------------------------------------------------------ projections

    async category(id) {
      const r = await db
        .selectFrom('category_projection')
        .selectAll()
        .where('category_id', '=', id)
        .executeTakeFirst();
      return r ? { categoryId: r.category_id, modes: r.modes, active: r.active } : null;
    },

    async upsertCategory(c) {
      await db
        .insertInto('category_projection')
        .values({ category_id: c.categoryId, modes: c.modes, active: c.active })
        .onConflict((oc) =>
          oc
            .column('category_id')
            .doUpdateSet({ modes: c.modes, active: c.active, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async borrowerFacts(accountId) {
      // Sequential: the executor may be a transaction (one connection).
      const rep = await db
        .selectFrom('reputation_projection')
        .selectAll()
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      const ver = await db
        .selectFrom('verification_projection')
        .selectAll()
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return {
        nidVerified: ver?.nid_verified ?? false,
        completedCount: rep?.completed_count ?? 0,
        ratingAverage: rep ? num(rep.rating_average) : null,
        ratingCount: rep?.rating_count ?? 0,
      };
    },

    async setReputation(accountId, r) {
      const row = {
        completed_count: r.completedCount,
        rating_average: rating(r.ratingAverage),
        rating_count: r.ratingCount,
      };
      await db
        .insertInto('reputation_projection')
        .values({ account_id: accountId, ...row })
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet({ ...row, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    async setNidVerified(accountId, verified) {
      await db
        .insertInto('verification_projection')
        .values({ account_id: accountId, nid_verified: verified })
        .onConflict((oc) =>
          oc
            .column('account_id')
            .doUpdateSet({ nid_verified: verified, updated_at: sql<Date>`now()` }),
        )
        .execute();
    },

    audit: (ctx, entry) => appendAudit(db, ctx, entry),
    outbox: (events) => appendToOutbox(db, events),
  };
}

export function pgLendingUnitOfWork(db: Kysely<LendingDB>): LendingUnitOfWork {
  return {
    store: pgLendingStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgLendingStore(trx))),
  };
}
