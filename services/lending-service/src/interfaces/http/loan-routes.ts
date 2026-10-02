import { LoanStatuses, PageQuerySchema } from '@dorkar/contracts';
import {
  ok,
  paginate,
  type FastifyPluginAsyncZod,
  type IdempotencyTables,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import {
  PartyCommands,
  type LoanDetail,
  type LoanService,
  type PartyCommand,
} from '../../application/loan-service';
import type { LoanListQuery } from '../../application/ports';
import type { Loan } from '../../domain/loan';
import {
  errors,
  IdParams,
  idempotentReply,
  iso,
  Money,
  pageOf,
  secured,
  timeCursor,
} from './common';

// ---------------------------------------------------------------- DTOs

const LoanDto = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  itemTitle: z.string(),
  lenderId: z.uuid(),
  borrowerId: z.uuid(),
  startAt: iso,
  returnBy: iso,
  message: z.string().nullable(),
  deposit: Money.nullable(),
  status: z.enum(LoanStatuses),
  transactionId: z.uuid().nullable(),
  declineReason: z.string().nullable(),
  returnedAt: iso.nullable(),
  overdue: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
  version: z.number().int(),
});

const TransitionDto = z.object({
  from: z.enum(LoanStatuses).nullable(),
  to: z.enum(LoanStatuses),
  command: z.string(),
  actorId: z.uuid().nullable(),
  actorRole: z.enum(['LENDER', 'BORROWER', 'SYSTEM']),
  reason: z.string().nullable(),
  at: iso,
});

const LoanDetailDto = LoanDto.extend({
  viewerRole: z.enum(['LENDER', 'BORROWER']).nullable(),
  actions: z.array(z.enum(PartyCommands)),
  transitions: z.array(TransitionDto),
});

const toLoan = (l: Loan): z.output<typeof LoanDto> => ({
  id: l.id,
  itemId: l.itemId,
  itemTitle: l.itemTitle,
  lenderId: l.lenderId,
  borrowerId: l.borrowerId,
  startAt: l.startAt,
  returnBy: l.returnBy,
  message: l.message,
  deposit: l.depositAmount === null ? null : { amount: l.depositAmount, currency: 'BDT' },
  status: l.status,
  transactionId: l.transactionId,
  declineReason: l.declineReason,
  returnedAt: l.returnedAt,
  overdue: l.overdueNotifiedAt !== null,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
  version: l.version,
});

const toDetail = (d: LoanDetail): z.output<typeof LoanDetailDto> => ({
  ...toLoan(d.loan),
  viewerRole: d.viewerRole,
  actions: d.actions,
  transitions: d.transitions.map((t) => ({
    from: t.from,
    to: t.to,
    command: t.command,
    actorId: t.actorId,
    actorRole: t.actorRole,
    reason: t.reason,
    at: t.at,
  })),
});

// ---------------------------------------------------------------- requests

const Reason = z.string().trim().min(3).max(500);

const RequestBody = z.strictObject({
  itemId: z.uuid(),
  startAt: iso,
  returnBy: iso,
  message: z.string().trim().min(1).max(500).optional(),
});

const ListQuerySchema = z.strictObject({
  ...PageQuerySchema.shape,
  status: z.enum(LoanStatuses).optional(),
});
const MyListQuery = ListQuerySchema.extend({ role: z.enum(['lender', 'borrower']).optional() });

const listQuery = (q: z.output<typeof ListQuerySchema>): LoanListQuery => ({
  status: q.status,
  cursor: timeCursor(q.cursor),
  limit: q.limit,
});

const loanPage = (rows: Loan[], limit: number) => {
  const { items, nextCursor } = paginate(rows, limit, (l) => ({
    k: l.createdAt.toISOString(),
    id: l.id,
  }));
  return { data: items.map(toLoan), page: { nextCursor } };
};

export interface LoanRouteDeps {
  loans: LoanService;
  runtime: ServiceRuntime<never>;
  idempotencyDb: Kysely<IdempotencyTables>;
}

export const loanRoutes: FastifyPluginAsyncZod<LoanRouteDeps> = async (
  app,
  { loans, runtime, idempotencyDb },
) => {
  const { authenticate, requirePermission } = runtime.auth;

  app.post(
    '/api/v1/loans',
    {
      preHandler: authenticate,
      schema: {
        tags: ['loans'],
        summary: 'Ask to borrow an item (requires Idempotency-Key)',
        ...secured,
        body: RequestBody,
        response: { 201: z.object({ data: LoanDetailDto }), ...errors },
      },
    },
    async (req, reply) =>
      idempotentReply(
        idempotencyDb,
        req,
        reply,
        { scope: 'lending:loan:request', status: 201, schema: LoanDetailDto },
        async () => toDetail(await loans.request(req.body, req.ctx)),
      ),
  );

  const command = <B extends z.ZodType>(
    name: PartyCommand,
    summary: string,
    body: B,
    reasonOf: (b: z.output<B>) => string | undefined,
  ) =>
    app.post(
      `/api/v1/loans/:id/${name}`,
      {
        preHandler: authenticate,
        schema: {
          tags: ['loans'],
          summary: `${summary} (requires Idempotency-Key)`,
          ...secured,
          params: IdParams,
          body,
          response: { 200: z.object({ data: LoanDetailDto }), ...errors },
        },
      },
      async (req, reply) =>
        idempotentReply(
          idempotencyDb,
          req,
          reply,
          { scope: `lending:loan:${name}`, status: 200, schema: LoanDetailDto },
          async () =>
            toDetail(
              await loans.command(
                req.params.id,
                name,
                { reason: reasonOf(req.body as z.output<B>) },
                req.ctx,
              ),
            ),
        ),
    );

  command('approve', 'Lender: approve the request', z.strictObject({}).nullish(), () => undefined);
  command(
    'decline',
    'Lender: decline the request',
    z.strictObject({ reason: Reason }),
    (b) => b.reason,
  );
  command(
    'cancel',
    'Borrower: withdraw my request',
    z.strictObject({ reason: Reason.optional() }).nullish(),
    (b) => b?.reason,
  );

  app.get(
    '/api/v1/loans/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['loans'],
        summary: 'A loan with its history and my next actions',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: LoanDetailDto }), ...errors },
      },
    },
    async (req) => ok(toDetail(await loans.get(req.params.id, req.ctx))),
  );

  app.get(
    '/api/v1/me/loans',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'Loans where I am the lender or the borrower',
        ...secured,
        querystring: MyListQuery,
        response: { 200: pageOf(LoanDto), ...errors },
      },
    },
    async (req) =>
      loanPage(
        await loans.listMine(req.query.role, listQuery(req.query), req.ctx),
        req.query.limit,
      ),
  );

  app.get(
    '/api/v1/admin/loans',
    {
      preHandler: requirePermission('transaction:read:any'),
      schema: {
        tags: ['admin'],
        summary: 'All loans, optionally by status',
        ...secured,
        querystring: ListQuerySchema,
        response: { 200: pageOf(LoanDto), ...errors },
      },
    },
    async (req) => loanPage(await loans.listAll(listQuery(req.query)), req.query.limit),
  );
};
