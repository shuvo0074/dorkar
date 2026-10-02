import {
  DisputeReasons,
  DisputeResolutions,
  DisputeStatuses,
  NeedModes,
  PageQuerySchema,
  TransactionStates,
} from '@dorkar/contracts';
import {
  decodeCursor,
  Errors,
  ok,
  paginate,
  requestFingerprint,
  withIdempotency,
  type FastifyPluginAsyncZod,
  type IdempotencyTables,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  ActionNames,
  type DisputeDetail,
  type DisputeService,
} from '../../application/dispute-service';
import type { PageCursor } from '../../application/ports';
import { partyRole, type Dispute, type Entry } from '../../domain/dispute';

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
};

const Party = z.enum(['BUYER', 'SELLER']);
const Money = z.object({ amount: z.number().int(), currency: z.string() });

/** What both parties and staff see. Parties are ids and roles only, never contact details. */
const DisputeDto = z.object({
  id: z.uuid(),
  transactionId: z.uuid(),
  buyerId: z.uuid(),
  sellerId: z.uuid(),
  openedBy: Party,
  respondent: Party,
  reason: z.enum(DisputeReasons),
  description: z.string().nullable(),
  previousState: z.enum(TransactionStates),
  mode: z.enum(NeedModes).nullable(),
  amount: Money.nullable(),
  status: z.enum(DisputeStatuses),
  respondBy: iso,
  respondentMissedDeadline: z.boolean(),
  statementSubmitted: z.boolean(),
  resolution: z.enum(DisputeResolutions).nullable(),
  resolutionNote: z.string().nullable(),
  resolvedAt: iso.nullable(),
  withdrawnAt: iso.nullable(),
  appliedAt: iso.nullable(),
  finalTransactionState: z.enum(TransactionStates).nullable(),
  openedAt: iso,
  updatedAt: iso,
});

/** Case handling, for staff only. */
const StaffDto = z.object({
  assignedTo: z.uuid().nullable(),
  assignedAt: iso.nullable(),
  escalated: z.boolean(),
  escalatedAt: iso.nullable(),
  resolvedBy: z.uuid().nullable(),
  withdrawnBy: z.uuid().nullable(),
});

const AdminDisputeDto = DisputeDto.extend(StaffDto.shape);

const EntryDto = z.object({
  id: z.uuid(),
  kind: z.enum([
    'OPENED',
    'STATEMENT',
    'EVIDENCE',
    'INFO_REQUEST',
    'NOTE',
    'STATUS_CHANGE',
    'ASSIGNMENT',
    'ESCALATION',
    'SYSTEM',
  ]),
  authorRole: z.enum(['BUYER', 'SELLER', 'STAFF', 'SYSTEM']),
  /** Null for system entries, and for staff entries when a party is looking. */
  authorId: z.uuid().nullable(),
  visibility: z.enum(['PARTIES', 'STAFF']),
  text: z.string().nullable(),
  mediaIds: z.array(z.uuid()),
  targetParty: z.enum(['BUYER', 'SELLER', 'BOTH']).nullable(),
  fromStatus: z.enum(DisputeStatuses).nullable(),
  toStatus: z.enum(DisputeStatuses).nullable(),
  createdAt: iso,
});

const DetailDto = DisputeDto.extend({
  viewerRole: z.enum(['BUYER', 'SELLER', 'STAFF']),
  actions: z.array(z.enum(ActionNames)),
  timeline: z.array(EntryDto),
  staff: StaffDto.nullable(),
});
type Detail = z.output<typeof DetailDto>;

const toDisputeDto = (d: Dispute): z.output<typeof DisputeDto> => ({
  id: d.id,
  transactionId: d.transactionId,
  buyerId: d.buyerId,
  sellerId: d.sellerId,
  openedBy: partyRole(d, d.openedBy)!,
  respondent: partyRole(d, d.respondentId)!,
  reason: d.reason,
  description: d.description,
  previousState: d.previousState,
  mode: d.mode,
  amount: d.amount === null ? null : { amount: d.amount, currency: (d.currency ?? 'BDT').trim() },
  status: d.status,
  respondBy: d.respondBy,
  respondentMissedDeadline: d.respondentMissedDeadline,
  statementSubmitted: d.statementSubmittedAt !== null,
  resolution: d.resolution,
  resolutionNote: d.resolutionNote,
  resolvedAt: d.resolvedAt,
  withdrawnAt: d.withdrawnAt,
  appliedAt: d.appliedAt,
  finalTransactionState: d.finalTransactionState,
  openedAt: d.openedAt,
  updatedAt: d.updatedAt,
});

const toStaffDto = (d: Dispute): z.output<typeof StaffDto> => ({
  assignedTo: d.assignedTo,
  assignedAt: d.assignedAt,
  escalated: d.escalated,
  escalatedAt: d.escalatedAt,
  resolvedBy: d.resolvedBy,
  withdrawnBy: d.withdrawnBy,
});

const toEntryDto = (e: Entry): z.output<typeof EntryDto> => ({
  id: e.id,
  kind: e.kind,
  authorRole: e.authorRole,
  authorId: e.authorId,
  visibility: e.visibility,
  text: e.text,
  mediaIds: e.mediaIds,
  targetParty: e.targetParty,
  fromStatus: e.fromStatus,
  toStatus: e.toStatus,
  createdAt: e.createdAt,
});

const toDetail = (d: DisputeDetail): Detail => ({
  ...toDisputeDto(d.dispute),
  viewerRole: d.viewerRole,
  actions: d.actions,
  timeline: d.entries.map(toEntryDto),
  staff: d.viewerRole === 'STAFF' ? toStaffDto(d.dispute) : null,
});

const IdParams = z.strictObject({ id: z.uuid() });
const NoBody = z.strictObject({}).nullish();
const PageInfo = z.object({ nextCursor: z.string().nullable() });

const MyListQuery = z.strictObject({
  ...PageQuerySchema.shape,
  status: z.enum(DisputeStatuses).optional(),
});
const AdminListQuery = MyListQuery.extend({
  assignee: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
  escalated: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

function cursorOf(raw: string | undefined): PageCursor | null {
  const c = decodeCursor(raw);
  if (
    c &&
    (typeof c.k !== 'string' || Number.isNaN(Date.parse(c.k)) || !z.uuid().safeParse(c.id).success)
  ) {
    throw Errors.validation('Invalid cursor.');
  }
  return c;
}

const pageOf = <T>(rows: Dispute[], limit: number, map: (d: Dispute) => T) => {
  const { items, nextCursor } = paginate(rows, limit, (d) => ({
    k: d.openedAt.toISOString(),
    id: d.id,
  }));
  return { data: items.map(map), page: { nextCursor } };
};

export interface DisputeRouteDeps {
  disputes: DisputeService;
  runtime: ServiceRuntime<never>;
  idempotencyDb: Kysely<IdempotencyTables>;
}

export const disputeRoutes: FastifyPluginAsyncZod<DisputeRouteDeps> = async (
  app,
  { disputes, runtime, idempotencyDb },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  const detailResponse = { 200: z.object({ data: DetailDto }), ...errors };

  /**
   * Every command requires an Idempotency-Key: a retry with the same key and body replays the
   * stored response (stored in wire form, so a replay is byte-identical).
   */
  const idempotent = async (
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    run: () => Promise<DisputeDetail>,
  ) => {
    const r = await withIdempotency(
      idempotencyDb,
      {
        actorId: req.ctx.actor!.id,
        scope,
        key: req.headers['idempotency-key'] as string | undefined,
        fingerprint: requestFingerprint({ params: req.params, body: req.body ?? null }),
        required: true,
      },
      async () => ({ status: 200, body: z.encode(DetailDto, toDetail(await run())) }),
    );
    return reply
      .status(r.status)
      .header('idempotent-replayed', String(r.replayed))
      .send(ok(z.decode(DetailDto, r.body)));
  };

  // ---------------------------------------------------------------- parties (and staff)

  app.get(
    '/api/v1/disputes/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['disputes'],
        summary: 'A dispute with its timeline and my next actions (parties and staff)',
        ...secured,
        params: IdParams,
        response: detailResponse,
      },
    },
    async (req) => ok(toDetail(await disputes.get(req.params.id, req.ctx))),
  );

  app.get(
    '/api/v1/me/disputes',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'Disputes on my deals, newest first',
        ...secured,
        querystring: MyListQuery,
        response: { 200: z.object({ data: z.array(DisputeDto), page: PageInfo }), ...errors },
      },
    },
    async (req) => {
      const { status, cursor, limit } = req.query;
      const rows = await disputes.listMine({ status, cursor: cursorOf(cursor), limit }, req.ctx);
      return pageOf(rows, limit, toDisputeDto);
    },
  );

  app.post(
    '/api/v1/disputes/:id/statement',
    {
      preHandler: authenticate,
      schema: {
        tags: ['disputes'],
        summary: 'Respondent: give your side, once (requires Idempotency-Key)',
        ...secured,
        params: IdParams,
        body: z.strictObject({ text: z.string().trim().min(10).max(4000) }),
        response: detailResponse,
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'dispute:statement', () =>
        disputes.submitStatement(req.params.id, req.body.text, req.ctx),
      ),
  );

  app.post(
    '/api/v1/disputes/:id/evidence',
    {
      preHandler: authenticate,
      schema: {
        tags: ['disputes'],
        summary: 'Add evidence: text and/or uploaded media; immutable (requires Idempotency-Key)',
        ...secured,
        params: IdParams,
        body: z.strictObject({
          text: z.string().trim().min(1).max(2000).optional(),
          mediaIds: z.array(z.uuid()).max(10).optional(),
        }),
        response: detailResponse,
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'dispute:evidence', () =>
        disputes.addEvidence(req.params.id, req.body, req.ctx),
      ),
  );

  app.post(
    '/api/v1/disputes/:id/withdraw',
    {
      preHandler: authenticate,
      schema: {
        tags: ['disputes'],
        summary: 'Opener: withdraw; the deal returns to where it was (requires Idempotency-Key)',
        ...secured,
        params: IdParams,
        body: NoBody,
        response: detailResponse,
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'dispute:withdraw', () => disputes.withdraw(req.params.id, req.ctx)),
  );

  // ---------------------------------------------------------------- staff

  app.get(
    '/api/v1/admin/disputes',
    {
      preHandler: requirePermission('dispute:read'),
      schema: {
        tags: ['admin'],
        summary: 'Dispute queue, oldest first (live cases unless a status is given)',
        ...secured,
        querystring: AdminListQuery,
        response: {
          200: z.object({ data: z.array(AdminDisputeDto), page: PageInfo }),
          ...errors,
        },
      },
    },
    async (req) => {
      const { status, cursor, limit, assignee, escalated } = req.query;
      const rows = await disputes.listAdmin(
        { status, cursor: cursorOf(cursor), limit, assignee, escalated },
        req.ctx,
      );
      return pageOf(rows, limit, (d) => ({ ...toDisputeDto(d), ...toStaffDto(d) }));
    },
  );

  app.post(
    '/api/v1/admin/disputes/:id/assign',
    {
      preHandler: requirePermission('dispute:read'),
      schema: {
        tags: ['admin'],
        summary: 'Assign the case to a staff member, or "me" (requires Idempotency-Key)',
        ...secured,
        params: IdParams,
        body: z.strictObject({ assigneeId: z.union([z.literal('me'), z.uuid()]) }),
        response: detailResponse,
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'dispute:assign', () =>
        disputes.assign(req.params.id, req.body.assigneeId, req.ctx),
      ),
  );

  app.post(
    '/api/v1/admin/disputes/:id/notes',
    {
      preHandler: requirePermission('dispute:read'),
      schema: {
        tags: ['admin'],
        summary: 'Internal note, never shown to the parties (requires Idempotency-Key)',
        ...secured,
        params: IdParams,
        body: z.strictObject({ text: z.string().trim().min(1).max(4000) }),
        response: detailResponse,
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'dispute:note', () =>
        disputes.addNote(req.params.id, req.body.text, req.ctx),
      ),
  );

  app.post(
    '/api/v1/admin/disputes/:id/request-info',
    {
      preHandler: requirePermission('dispute:resolve'),
      schema: {
        tags: ['admin'],
        summary: "Ask a party for more information; shown in the parties' timeline",
        ...secured,
        params: IdParams,
        body: z.strictObject({
          party: z.enum(['BUYER', 'SELLER', 'BOTH']),
          message: z.string().trim().min(3).max(2000),
        }),
        response: detailResponse,
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'dispute:request-info', () =>
        disputes.requestInfo(req.params.id, req.body, req.ctx),
      ),
  );

  app.post(
    '/api/v1/admin/disputes/:id/resolve',
    {
      preHandler: requirePermission('dispute:resolve'),
      schema: {
        tags: ['admin'],
        summary: 'Decide: RELEASE completes the deal, CANCEL cancels it (requires Idempotency-Key)',
        description:
          'REFUND is accepted only when the payment provider supports refunds; cash deals ' +
          'answer 422 REFUND_NOT_SUPPORTED. Emits dispute.DisputeResolved for transaction-service.',
        ...secured,
        params: IdParams,
        body: z.strictObject({
          resolution: z.enum(DisputeResolutions),
          note: z.string().trim().min(3).max(2000),
        }),
        response: detailResponse,
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'dispute:resolve', () =>
        disputes.resolve(req.params.id, req.body, req.ctx),
      ),
  );
};
