import { appendAudit, appendToOutbox, Errors } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ModerationStore, ModerationUnitOfWork } from '../application/ports';
import type { ModerationCase, Report } from '../domain/moderation';
import type { ModerationDB } from './db-schema';

type Executor = Kysely<ModerationDB> | Transaction<ModerationDB>;

const toCase = (r: Selectable<ModerationDB['moderation_cases']>): ModerationCase => ({
  id: r.id,
  targetType: r.target_type,
  targetId: r.target_id,
  status: r.status,
  reportCount: r.report_count,
  topReason: r.top_reason,
  priority: r.priority,
  assignedTo: r.assigned_to,
  targetHidden: r.target_hidden,
  openedAt: r.opened_at,
  closedAt: r.closed_at,
  version: r.version,
});

const toReport = (r: Selectable<ModerationDB['reports']>): Report => ({
  id: r.id,
  reporterId: r.reporter_id,
  targetType: r.target_type,
  targetId: r.target_id,
  reason: r.reason,
  details: r.details,
  caseId: r.case_id,
  status: r.status,
  createdAt: r.created_at,
});

const isUniqueViolation = (err: unknown, constraint: string) =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: string }).code === '23505' &&
  (err as { constraint?: string }).constraint === constraint;

export function pgModerationStore(db: Executor): ModerationStore {
  return {
    async ensureOpenCase(c) {
      await db
        .insertInto('moderation_cases')
        .values({
          id: c.id,
          target_type: c.targetType,
          target_id: c.targetId,
          top_reason: c.reason,
        })
        // Conflict target is the partial unique index moderation_cases_open_target_uq.
        .onConflict((oc) =>
          oc.columns(['target_type', 'target_id']).where('status', '=', 'OPEN').doNothing(),
        )
        .execute();
    },
    async lockOpenCase(targetType, targetId) {
      const r = await db
        .selectFrom('moderation_cases')
        .selectAll()
        .where('target_type', '=', targetType)
        .where('target_id', '=', targetId)
        .where('status', '=', 'OPEN')
        .forUpdate()
        .executeTakeFirst();
      return r ? toCase(r) : null;
    },
    async setCaseRanking(caseId, r) {
      await db
        .updateTable('moderation_cases')
        .set((eb) => ({
          report_count: r.reportCount,
          top_reason: r.topReason,
          priority: r.priority,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', caseId)
        .execute();
    },
    async insertReport(r) {
      try {
        const row = await db
          .insertInto('reports')
          .values({
            id: r.id,
            reporter_id: r.reporterId,
            target_type: r.targetType,
            target_id: r.targetId,
            reason: r.reason,
            details: r.details,
            case_id: r.caseId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return toReport(row);
      } catch (err) {
        if (isUniqueViolation(err, 'reports_open_per_reporter_uq')) {
          throw Errors.conflict('You already reported this and it is being reviewed.', {
            rule: 'DUPLICATE_OPEN_REPORT',
          });
        }
        throw err;
      }
    },
    async getCase(id) {
      const r = await db
        .selectFrom('moderation_cases')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r ? toCase(r) : null;
    },
    async listCases(filter, after, limit) {
      let q = db.selectFrom('moderation_cases').selectAll();
      if (filter.status) q = q.where('status', '=', filter.status);
      if (filter.targetType) q = q.where('target_type', '=', filter.targetType);
      if (after) {
        const k = Number(after.k);
        q = q.where((eb) =>
          eb.or([
            eb('priority', '<', k),
            eb.and([eb('priority', '=', k), eb('id', '>', after.id)]),
          ]),
        );
      }
      const rows = await q.orderBy('priority', 'desc').orderBy('id', 'asc').limit(limit).execute();
      return rows.map(toCase);
    },
    async caseReports(caseId, limit) {
      const rows = await db
        .selectFrom('reports')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map(toReport);
    },
    async caseActions(caseId, limit) {
      const rows = await db
        .selectFrom('moderation_actions')
        .selectAll()
        .where('case_id', '=', caseId)
        .orderBy('id', 'asc')
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        caseId: r.case_id,
        moderatorId: r.moderator_id,
        action: r.action,
        reason: r.reason,
        createdAt: r.created_at,
      }));
    },
    async reportsByReporter(reporterId, after, limit) {
      let q = db.selectFrom('reports').selectAll().where('reporter_id', '=', reporterId);
      if (after) q = q.where('id', '<', after.id);
      const rows = await q.orderBy('id', 'desc').limit(limit).execute();
      return rows.map(toReport);
    },
    async transitionCase(id, from, to) {
      const closing = from.status === 'OPEN' && to.status !== 'OPEN';
      const r = await db
        .updateTable('moderation_cases')
        .set((eb) => ({
          status: to.status,
          target_hidden: to.targetHidden,
          ...(to.assignedTo !== undefined ? { assigned_to: to.assignedTo } : {}),
          ...(closing ? { closed_at: sql<Date>`now()` } : {}),
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('status', '=', from.status)
        .where('version', '=', from.version)
        .returningAll()
        .executeTakeFirst();
      return r ? toCase(r) : null;
    },
    async setOpenReportsStatus(caseId, to) {
      await db
        .updateTable('reports')
        .set({ status: to })
        .where('case_id', '=', caseId)
        .where('status', '=', 'OPEN')
        .execute();
    },
    async appendAction(a) {
      await db
        .insertInto('moderation_actions')
        .values({
          id: a.id,
          case_id: a.caseId,
          moderator_id: a.moderatorId,
          action: a.action,
          reason: a.reason,
        })
        .execute();
    },
    outbox: (events) => appendToOutbox(db, events),
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgModerationUnitOfWork(db: Kysely<ModerationDB>): ModerationUnitOfWork {
  return {
    store: pgModerationStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgModerationStore(trx))),
  };
}
