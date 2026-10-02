import {
  decodeCursor,
  ok,
  paginate,
  type FastifyPluginAsyncZod,
  type ServiceRuntime,
} from '@dorkar/kernel';
import { z } from 'zod';
import type { CaseDetail, ModerationService } from '../../application/moderation-service';
import {
  ActionKinds,
  CaseStatuses,
  DecisionActions,
  ModerationTargets,
  ReportReasons,
  ReportStatuses,
  type ModerationAction,
  type ModerationCase,
  type Report,
} from '../../domain/moderation';

const iso = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});
const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
  429: ErrorResponse,
};

const PageInfo = z.object({ nextCursor: z.string().nullable() });
const PageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
};
const IdParams = z.strictObject({ id: z.uuid() });

// ---- member DTOs

/** A reporter's own report: never shows other reporters or moderator identities. */
const MyReportDto = z.object({
  id: z.uuid(),
  targetType: z.enum(ModerationTargets),
  targetId: z.uuid(),
  reason: z.enum(ReportReasons),
  details: z.string().nullable(),
  status: z.enum(ReportStatuses),
  createdAt: iso,
});
const toMyReport = (r: Report): z.output<typeof MyReportDto> => ({
  id: r.id,
  targetType: r.targetType,
  targetId: r.targetId,
  reason: r.reason,
  details: r.details,
  status: r.status,
  createdAt: r.createdAt,
});

const ReportBody = z.strictObject({
  targetType: z.enum(ModerationTargets),
  targetId: z.uuid(),
  reason: z.enum(ReportReasons),
  details: z.string().trim().max(1000).nullable().optional(),
});

// ---- moderator DTOs

const CaseDto = z.object({
  id: z.uuid(),
  targetType: z.enum(ModerationTargets),
  targetId: z.uuid(),
  status: z.enum(CaseStatuses),
  reportCount: z.number().int(),
  topReason: z.enum(ReportReasons),
  priority: z.number().int(),
  assignedTo: z.uuid().nullable(),
  targetHidden: z.boolean(),
  openedAt: iso,
  closedAt: iso.nullable(),
  version: z.number().int(),
});
const toCase = (c: ModerationCase): z.output<typeof CaseDto> => ({
  id: c.id,
  targetType: c.targetType,
  targetId: c.targetId,
  status: c.status,
  reportCount: c.reportCount,
  topReason: c.topReason,
  priority: c.priority,
  assignedTo: c.assignedTo,
  targetHidden: c.targetHidden,
  openedAt: c.openedAt,
  closedAt: c.closedAt,
  version: c.version,
});

const CaseReportDto = MyReportDto.omit({ targetType: true, targetId: true }).extend({
  reporterId: z.uuid(),
});
const ActionDto = z.object({
  id: z.uuid(),
  moderatorId: z.uuid(),
  action: z.enum(ActionKinds),
  reason: z.string().nullable(),
  createdAt: iso,
});
const toAction = (a: ModerationAction): z.output<typeof ActionDto> => ({
  id: a.id,
  moderatorId: a.moderatorId,
  action: a.action,
  reason: a.reason,
  createdAt: a.createdAt,
});
const CaseDetailDto = CaseDto.extend({
  reports: z.array(CaseReportDto),
  actions: z.array(ActionDto),
});
const toDetail = (d: CaseDetail): z.output<typeof CaseDetailDto> => ({
  ...toCase(d.case),
  reports: d.reports.map((r) => ({
    id: r.id,
    reporterId: r.reporterId,
    reason: r.reason,
    details: r.details,
    status: r.status,
    createdAt: r.createdAt,
  })),
  actions: d.actions.map(toAction),
});

const CasesQuery = z.strictObject({
  status: z.enum(CaseStatuses).optional(),
  targetType: z.enum(ModerationTargets).optional(),
  ...PageQuery,
});

const ActionBody = z.strictObject({
  action: z.enum(DecisionActions),
  reason: z.string().trim().min(3).max(500),
});

export interface ModerationRouteDeps {
  moderation: ModerationService;
  runtime: ServiceRuntime<never>;
}

export const moderationRoutes: FastifyPluginAsyncZod<ModerationRouteDeps> = async (
  app,
  { moderation, runtime },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  const canRead = requirePermission('moderation:case:read');

  app.post(
    '/api/v1/reports',
    {
      preHandler: requirePermission('report:create'),
      schema: {
        tags: ['reports'],
        summary: 'Report a listing, need, offer, review or user',
        ...secured,
        body: ReportBody,
        response: {
          201: z.object({ data: z.object({ reportId: z.uuid(), caseId: z.uuid() }) }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const r = await moderation.report(req.body, req.ctx);
      void reply.status(201);
      return ok(r);
    },
  );

  app.get(
    '/api/v1/reports/mine',
    {
      preHandler: authenticate,
      schema: {
        tags: ['reports'],
        summary: 'My reports and their status, newest first',
        ...secured,
        querystring: z.strictObject(PageQuery),
        response: {
          200: z.object({ data: z.array(MyReportDto), page: PageInfo }),
          ...errors,
        },
      },
    },
    async (req) => {
      const { limit, cursor } = req.query;
      const rows = await moderation.myReports(decodeCursor(cursor), limit, req.ctx);
      const { items, nextCursor } = paginate(rows, limit, (r) => ({ k: r.id, id: r.id }));
      return { data: items.map(toMyReport), page: { nextCursor } };
    },
  );

  app.get(
    '/api/v1/admin/moderation/cases',
    {
      preHandler: canRead,
      schema: {
        tags: ['admin-moderation'],
        summary: 'Moderation queue: highest priority first, then oldest',
        ...secured,
        querystring: CasesQuery,
        response: { 200: z.object({ data: z.array(CaseDto), page: PageInfo }), ...errors },
      },
    },
    async (req) => {
      const { limit, cursor, status, targetType } = req.query;
      const rows = await moderation.listCases(
        { status, targetType },
        decodeCursor(cursor),
        limit,
        req.ctx,
      );
      const { items, nextCursor } = paginate(rows, limit, (c) => ({ k: c.priority, id: c.id }));
      return { data: items.map(toCase), page: { nextCursor } };
    },
  );

  app.get(
    '/api/v1/admin/moderation/cases/:id',
    {
      preHandler: canRead,
      schema: {
        tags: ['admin-moderation'],
        summary: 'Case with its reports (reporter ids) and action history',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: CaseDetailDto }), ...errors },
      },
    },
    async (req) => ok(toDetail(await moderation.getCase(req.params.id, req.ctx))),
  );

  app.post(
    '/api/v1/admin/moderation/cases/:id/assign',
    {
      preHandler: canRead,
      schema: {
        tags: ['admin-moderation'],
        summary: 'Take the case (assigns it to the caller)',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: CaseDto }), ...errors },
      },
    },
    async (req) => ok(toCase(await moderation.assign(req.params.id, req.ctx))),
  );

  app.post(
    '/api/v1/admin/moderation/cases/:id/actions',
    {
      preHandler: canRead,
      schema: {
        tags: ['admin-moderation'],
        summary: 'Decide: HIDE or RESTORE the target, or DISMISS the case',
        description:
          'HIDE needs moderation:content:hide, RESTORE moderation:content:restore. HIDE/RESTORE ' +
          'emit moderation.ContentModerated for the owning service. USER targets: use the account admin.',
        ...secured,
        params: IdParams,
        body: ActionBody,
        response: { 200: z.object({ data: CaseDto }), ...errors },
      },
    },
    async (req) => ok(toCase(await moderation.act(req.params.id, req.body, req.ctx))),
  );
};
