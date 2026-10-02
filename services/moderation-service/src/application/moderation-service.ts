import { ModerationEvents } from '@dorkar/contracts';
import {
  AppError,
  Errors,
  uuidv7,
  type Cursor,
  type RateLimiter,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import {
  assertAssignable,
  assertNotOwnCase,
  assertNotSelfReport,
  assertPermitted,
  decide,
  withReport,
  type DecisionAction,
  type ModerationAction,
  type ModerationCase,
  type ModerationTarget,
  type Report,
  type ReportReason,
} from '../domain/moderation';
import type { CaseFilter, ModerationStore, ModerationUnitOfWork } from './ports';

export interface ModerationSettings {
  reportsPerReporterPerDay: number;
}

export interface CaseDetail {
  case: ModerationCase;
  reports: Report[];
  actions: ModerationAction[];
}

const DAY_MS = 24 * 60 * 60_000;
/** Detail view caps; report_count carries the full total. */
const DETAIL_REPORTS = 200;
const DETAIL_ACTIONS = 200;

const AUDIT_TARGET = 'moderation_case';

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Reports, the moderation queue and moderator decisions. */
export class ModerationService {
  constructor(
    private readonly uow: ModerationUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly limiter: RateLimiter,
    private readonly settings: ModerationSettings,
  ) {}

  // ---- members

  async report(
    input: {
      targetType: ModerationTarget;
      targetId: string;
      reason: ReportReason;
      details?: string | null | undefined;
    },
    ctx: RequestContext,
  ): Promise<{ reportId: string; caseId: string }> {
    const actor = requireActor(ctx);
    assertNotSelfReport(actor.id, input.targetType, input.targetId);

    const rl = await this.limiter.consume([
      {
        key: `reports:${actor.id}`,
        limit: this.settings.reportsPerReporterPerDay,
        windowMs: DAY_MS,
      },
    ]);
    if (!rl.allowed) throw Errors.rateLimited(rl.retryAfterMs);

    return this.uow.transaction(async (s) => {
      const c = await this.openCaseFor(s, input.targetType, input.targetId, input.reason);
      const report = await s.insertReport({
        id: uuidv7(),
        reporterId: actor.id,
        targetType: input.targetType,
        targetId: input.targetId,
        reason: input.reason,
        details: input.details ?? null,
        caseId: c.id,
      });
      await s.setCaseRanking(c.id, withReport(c, input.reason));
      return { reportId: report.id, caseId: c.id };
    });
  }

  myReports(after: Cursor | null, limit: number, ctx: RequestContext): Promise<Report[]> {
    const actor = requireActor(ctx);
    return this.uow.store.reportsByReporter(actor.id, after, limit + 1);
  }

  // ---- moderators (every call audited as ADMIN)

  async listCases(
    filter: CaseFilter,
    after: Cursor | null,
    limit: number,
    ctx: RequestContext,
  ): Promise<ModerationCase[]> {
    requireActor(ctx);
    if (after && typeof after.k !== 'number') throw Errors.validation('Invalid cursor.');
    const rows = await this.uow.store.listCases(filter, after, limit + 1);
    await this.uow.store.audit(ctx, {
      action: 'moderation.cases.listed',
      actorType: 'ADMIN',
      targetType: AUDIT_TARGET,
      metadata: {
        status: filter.status ?? null,
        targetType: filter.targetType ?? null,
        returned: Math.min(rows.length, limit),
      },
    });
    return rows;
  }

  async getCase(id: string, ctx: RequestContext): Promise<CaseDetail> {
    requireActor(ctx);
    const s = this.uow.store;
    const c = await s.getCase(id);
    if (!c) throw Errors.notFound('Case');
    const [reports, actions] = await Promise.all([
      s.caseReports(id, DETAIL_REPORTS),
      s.caseActions(id, DETAIL_ACTIONS),
    ]);
    // Reveals reporter ids: record who looked.
    await s.audit(ctx, {
      action: 'moderation.case.viewed',
      actorType: 'ADMIN',
      targetType: AUDIT_TARGET,
      targetId: id,
    });
    return { case: c, reports, actions };
  }

  async assign(id: string, ctx: RequestContext): Promise<ModerationCase> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const c = await this.load(s, id);
      assertNotOwnCase(actor.id, c);
      assertAssignable(c);
      const next = await s.transitionCase(c.id, c, {
        status: c.status,
        targetHidden: c.targetHidden,
        assignedTo: actor.id,
      });
      if (!next) throw this.lostRace();
      const actionId = uuidv7();
      await s.appendAction({
        id: actionId,
        caseId: c.id,
        moderatorId: actor.id,
        action: 'ASSIGN',
        reason: null,
      });
      await s.audit(ctx, {
        action: 'moderation.case.assigned',
        actorType: 'ADMIN',
        targetType: AUDIT_TARGET,
        targetId: c.id,
        metadata: { actionId, previousAssignee: c.assignedTo },
      });
      return next;
    });
  }

  async act(
    id: string,
    input: { action: DecisionAction; reason: string },
    ctx: RequestContext,
  ): Promise<ModerationCase> {
    const actor = requireActor(ctx);
    return this.uow.transaction(async (s) => {
      const c = await this.load(s, id);
      assertNotOwnCase(actor.id, c);
      assertPermitted(actor.permissions, input.action);
      const d = decide(c, input.action);

      const next = await s.transitionCase(c.id, c, {
        status: d.status,
        targetHidden: d.targetHidden,
      });
      if (!next) throw this.lostRace();
      if (d.reports) await s.setOpenReportsStatus(c.id, d.reports);

      const actionId = uuidv7();
      await s.appendAction({
        id: actionId,
        caseId: c.id,
        moderatorId: actor.id,
        action: input.action,
        reason: input.reason,
      });
      if (d.event) {
        await s.outbox(
          this.event(
            ModerationEvents.ContentModerated,
            c.targetId,
            {
              caseId: c.id,
              targetType: c.targetType,
              targetId: c.targetId,
              action: d.event,
              reason: input.reason,
              moderatorId: actor.id,
            },
            ctx,
          ),
        );
      }
      await s.audit(ctx, {
        action: `moderation.case.${input.action.toLowerCase()}`,
        actorType: 'ADMIN',
        targetType: AUDIT_TARGET,
        targetId: c.id,
        // The free-text reason lives in moderation_actions; audit metadata stays PII-free.
        metadata: {
          actionId,
          contentType: c.targetType,
          contentId: c.targetId,
          from: c.status,
          to: next.status,
        },
      });
      return next;
    });
  }

  /**
   * The open case for a target, created if needed and row-locked: serializes concurrent reports
   * on one target so counts and ranking stay exact. A moderator may close the case between the
   * insert and the lock; then a fresh case is opened.
   */
  private async openCaseFor(
    s: ModerationStore,
    targetType: ModerationTarget,
    targetId: string,
    reason: ReportReason,
  ): Promise<ModerationCase> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await s.ensureOpenCase({ id: uuidv7(), targetType, targetId, reason });
      const c = await s.lockOpenCase(targetType, targetId);
      if (c) return c;
    }
    throw Errors.unavailable('The report could not be filed. Please try again.');
  }

  private async load(s: ModerationStore, id: string): Promise<ModerationCase> {
    const c = await s.getCase(id);
    if (!c) throw Errors.notFound('Case');
    return c;
  }

  private lostRace() {
    return new AppError(
      'INVALID_STATE_TRANSITION',
      'The case was changed by someone else. Reload and try again.',
      { rule: 'CONCURRENT_UPDATE' },
    );
  }
}
