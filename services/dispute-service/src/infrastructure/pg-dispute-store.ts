import { appendAudit, appendToOutbox, uuidv7 } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { DisputeStore, DisputeUnitOfWork, PartyListQuery } from '../application/ports';
import { LiveStatuses, type Dispute, type Entry } from '../domain/dispute';
import type { DisputeDB } from './db-schema';

type Executor = Kysely<DisputeDB> | Transaction<DisputeDB>;

const num = (v: string | null) => (v === null ? null : Number(v));

const toDispute = (r: Selectable<DisputeDB['disputes']>): Dispute => ({
  id: r.id,
  transactionId: r.transaction_id,
  buyerId: r.buyer_id,
  sellerId: r.seller_id,
  openedBy: r.opened_by,
  respondentId: r.respondent_id,
  previousState: r.previous_state,
  reason: r.reason,
  description: r.description,
  mode: r.mode,
  amount: num(r.amount),
  currency: r.currency,
  paymentProvider: r.payment_provider,
  status: r.status,
  respondBy: r.respond_by,
  respondentMissedDeadline: r.respondent_missed_deadline,
  statementSubmittedAt: r.statement_submitted_at,
  assignedTo: r.assigned_to,
  assignedAt: r.assigned_at,
  escalated: r.escalated,
  escalatedAt: r.escalated_at,
  resolution: r.resolution,
  resolutionNote: r.resolution_note,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at,
  withdrawnBy: r.withdrawn_by,
  withdrawnAt: r.withdrawn_at,
  appliedAt: r.applied_at,
  finalTransactionState: r.final_transaction_state,
  openedAt: r.opened_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const toEntry = (r: Selectable<DisputeDB['dispute_entries']>): Entry => ({
  id: r.id,
  disputeId: r.dispute_id,
  kind: r.kind,
  authorId: r.author_id,
  authorRole: r.author_role,
  visibility: r.visibility,
  text: r.text,
  mediaIds: r.media_ids,
  targetParty: r.target_party,
  fromStatus: r.from_status,
  toStatus: r.to_status,
  createdAt: r.created_at,
});

const live = [...LiveStatuses];

export function pgDisputeStore(db: Executor): DisputeStore {
  const now = sql<Date>`now()`;

  return {
    async upsertDeal(p) {
      await db
        .insertInto('transaction_projection')
        .values({
          transaction_id: p.transactionId,
          buyer_id: p.buyerId,
          seller_id: p.sellerId,
          mode: p.mode,
          amount: p.amount,
          currency: p.currency,
          source_type: p.sourceType,
          source_id: p.sourceId,
        })
        // Facts never regress: a partial projection (from StateChanged) keeps what Created set.
        .onConflict((oc) =>
          oc.column('transaction_id').doUpdateSet((eb) => ({
            buyer_id: eb.ref('excluded.buyer_id'),
            seller_id: eb.ref('excluded.seller_id'),
            mode: eb.fn.coalesce('excluded.mode', 'transaction_projection.mode'),
            amount: eb.fn.coalesce('excluded.amount', 'transaction_projection.amount'),
            currency: eb.fn.coalesce('excluded.currency', 'transaction_projection.currency'),
            updated_at: now,
          })),
        )
        .execute();
    },

    async deal(transactionId) {
      const r = await db
        .selectFrom('transaction_projection')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .executeTakeFirst();
      return r
        ? {
            transactionId: r.transaction_id,
            buyerId: r.buyer_id,
            sellerId: r.seller_id,
            mode: r.mode,
            amount: num(r.amount),
            currency: r.currency,
            sourceType: r.source_type,
            sourceId: r.source_id,
          }
        : null;
    },

    async fillDealFacts(p) {
      await db
        .updateTable('disputes')
        .set((eb) => ({
          mode: eb.fn.coalesce('mode', eb.val(p.mode)),
          amount: eb.fn.coalesce('amount', eb.val(p.amount)).$castTo<number | null>(),
          currency: eb.fn.coalesce('currency', eb.val(p.currency)),
        }))
        .where('transaction_id', '=', p.transactionId)
        .where((eb) => eb.or([eb('amount', 'is', null), eb('mode', 'is', null)]))
        .execute();
    },

    async insert(d) {
      const r = await db
        .insertInto('disputes')
        .values({
          id: d.id,
          transaction_id: d.transactionId,
          buyer_id: d.buyerId,
          seller_id: d.sellerId,
          opened_by: d.openedBy,
          respondent_id: d.respondentId,
          previous_state: d.previousState,
          reason: d.reason,
          description: d.description,
          mode: d.mode,
          amount: d.amount,
          currency: d.currency,
          status: 'AWAITING_RESPONSE',
          respond_by: sql<Date>`now() + ${d.respondWithinHours} * interval '1 hour'`,
          statement_submitted_at: null,
          assigned_to: null,
          assigned_at: null,
          escalated_at: null,
          resolution: null,
          resolution_note: null,
          resolved_by: null,
          resolved_at: null,
          withdrawn_by: null,
          withdrawn_at: null,
          applied_at: null,
          final_transaction_state: null,
        })
        // At most one live case per transaction, even under concurrent delivery.
        .onConflict((oc) =>
          oc
            .column('transaction_id')
            .where('status', 'in', ['OPEN', 'AWAITING_RESPONSE', 'UNDER_REVIEW'])
            .doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      return r ? toDispute(r) : null;
    },

    async load(id) {
      const r = await db
        .selectFrom('disputes')
        .selectAll()
        .select(sql<Date>`now()`.as('db_now'))
        .where('id', '=', id)
        .executeTakeFirst();
      return r ? { dispute: toDispute(r), now: r.db_now } : null;
    },

    async unappliedForTransaction(transactionId) {
      const r = await db
        .selectFrom('disputes')
        .selectAll()
        .where('transaction_id', '=', transactionId)
        .where('applied_at', 'is', null)
        .orderBy('opened_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      return r ? toDispute(r) : null;
    },

    async transition(id, guard, to, p) {
      const r = await db
        .updateTable('disputes')
        .set((eb) => ({
          status: to,
          ...(p.statementSubmitted ? { statement_submitted_at: now } : {}),
          ...(p.respondentMissedDeadline ? { respondent_missed_deadline: true } : {}),
          ...(p.resolution
            ? {
                resolution: p.resolution.resolution,
                resolution_note: p.resolution.note,
                resolved_by: p.resolution.by,
                resolved_at: now,
              }
            : {}),
          ...(p.withdrawnBy !== undefined
            ? { withdrawn_by: p.withdrawnBy, withdrawn_at: now }
            : {}),
          ...(p.applied ? { applied_at: now, final_transaction_state: p.applied.finalState } : {}),
          updated_at: now,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('status', '=', guard.from)
        .where('version', '=', guard.version)
        .returningAll()
        .executeTakeFirst();
      return r ? toDispute(r) : null;
    },

    async markApplied(id, finalState) {
      await db
        .updateTable('disputes')
        .set({ applied_at: now, final_transaction_state: finalState, updated_at: now })
        .where('id', '=', id)
        .where('applied_at', 'is', null)
        .execute();
    },

    async assign(id, assigneeId) {
      const r = await db
        .updateTable('disputes')
        .set({ assigned_to: assigneeId, assigned_at: now, updated_at: now })
        .where('id', '=', id)
        .where('status', 'in', live)
        .returningAll()
        .executeTakeFirst();
      return r ? toDispute(r) : null;
    },

    async appendEntry(e) {
      const r = await db
        .insertInto('dispute_entries')
        .values({
          id: uuidv7(),
          dispute_id: e.disputeId,
          kind: e.kind,
          author_id: e.authorId,
          author_role: e.authorRole,
          visibility: e.visibility,
          text: e.text ?? null,
          media_ids: e.mediaIds ?? [],
          target_party: e.targetParty ?? null,
          from_status: e.fromStatus ?? null,
          to_status: e.toStatus ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toEntry(r);
    },

    async entries(disputeId, includeStaffOnly) {
      let q = db.selectFrom('dispute_entries').selectAll().where('dispute_id', '=', disputeId);
      if (!includeStaffOnly) q = q.where('visibility', '=', 'PARTIES');
      return (await q.orderBy('seq').execute()).map(toEntry);
    },

    async listForParty(accountId, q: PartyListQuery) {
      let query = db
        .selectFrom('disputes')
        .selectAll()
        .where((eb) => eb.or([eb('buyer_id', '=', accountId), eb('seller_id', '=', accountId)]));
      if (q.status) query = query.where('status', '=', q.status);
      if (q.cursor) {
        const { k, id } = q.cursor;
        query = query.where(
          sql<boolean>`(opened_at, id) < (${new Date(k)}::timestamptz, ${id}::uuid)`,
        );
      }
      const rows = await query
        .orderBy('opened_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.limit + 1)
        .execute();
      return rows.map(toDispute);
    },

    async listAdmin(q) {
      let query = db.selectFrom('disputes').selectAll();
      query = q.status ? query.where('status', '=', q.status) : query.where('status', 'in', live);
      if (q.assignee === 'none') query = query.where('assigned_to', 'is', null);
      else if (q.assignee) query = query.where('assigned_to', '=', q.assignee);
      if (q.escalated !== undefined) query = query.where('escalated', '=', q.escalated);
      if (q.cursor) {
        const { k, id } = q.cursor;
        query = query.where(
          sql<boolean>`(opened_at, id) > (${new Date(k)}::timestamptz, ${id}::uuid)`,
        );
      }
      const rows = await query
        .orderBy('opened_at', 'asc')
        .orderBy('id', 'asc')
        .limit(q.limit + 1)
        .execute();
      return rows.map(toDispute);
    },

    async dueForDeadline(limit) {
      const rows = await db
        .selectFrom('disputes')
        .select('id')
        .where('status', '=', 'AWAITING_RESPONSE')
        .where('respond_by', '<=', now)
        .orderBy('respond_by')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map((r) => r.id);
    },

    async escalateUnassigned(hours, limit) {
      const rows = await db
        .updateTable('disputes')
        .set({ escalated: true, escalated_at: now, updated_at: now })
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('disputes')
            .select('id')
            .where('assigned_to', 'is', null)
            .where('escalated', '=', false)
            .where('status', 'in', live)
            .where('opened_at', '<=', sql<Date>`now() - ${hours} * interval '1 hour'`)
            .orderBy('opened_at')
            .limit(limit)
            .forUpdate()
            .skipLocked(),
        )
        .returning('id')
        .execute();
      return rows.map((r) => r.id);
    },

    audit: (ctx, entry) => appendAudit(db, ctx, entry),
    outbox: (events) => appendToOutbox(db, events),
  };
}

export function pgDisputeUnitOfWork(db: Kysely<DisputeDB>): DisputeUnitOfWork {
  return {
    store: pgDisputeStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgDisputeStore(trx))),
  };
}
