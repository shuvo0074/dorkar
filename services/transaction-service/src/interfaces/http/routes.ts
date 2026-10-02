import { DeliveryModes, NeedModes, PageQuerySchema, TransactionStates } from '@dorkar/contracts';
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
import type { ListQuery } from '../../application/ports';
import {
  ActionNames,
  type CommandInput,
  type PartyCommand,
  type TransactionDetail,
  type TransactionService,
} from '../../application/transaction-service';
import type { Transaction } from '../../domain/transaction';

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

const Money = z.object({ amount: z.number().int(), currency: z.literal('BDT') });

const TransactionDto = z.object({
  id: z.uuid(),
  sourceType: z.enum(['OFFER', 'LISTING']),
  sourceId: z.uuid(),
  listingId: z.uuid().nullable(),
  needId: z.uuid().nullable(),
  buyerId: z.uuid(),
  sellerId: z.uuid(),
  mode: z.enum(NeedModes),
  amount: Money,
  quantity: z.number().int(),
  terms: z.record(z.string(), z.unknown()),
  state: z.enum(TransactionStates),
  buyerConfirmedAt: iso.nullable(),
  sellerConfirmedAt: iso.nullable(),
  deliveredAt: iso.nullable(),
  completedAt: iso.nullable(),
  cancelReason: z.string().nullable(),
  disputeReason: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
  version: z.number().int(),
});

const PaymentDto = z.object({
  provider: z.string(),
  status: z.enum(['PENDING', 'PAID', 'REFUNDED', 'FAILED']),
  amount: Money,
  note: z.string().nullable(),
  updatedAt: iso,
});

const DeliveryDto = z.object({
  method: z.enum(DeliveryModes),
  status: z.enum(['ARRANGED', 'DELIVERED', 'CANCELLED']),
  provider: z.string(),
  scheduledFor: iso.nullable(),
  /** Only the two parties see notes. */
  notes: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});

const TransitionDto = z.object({
  from: z.enum(TransactionStates),
  to: z.enum(TransactionStates),
  command: z.string(),
  actorId: z.uuid().nullable(),
  actorRole: z.string(),
  reason: z.string().nullable(),
  at: iso,
});

const DetailDto = TransactionDto.extend({
  viewerRole: z.enum(['BUYER', 'SELLER']).nullable(),
  actions: z.array(z.enum(ActionNames)),
  payment: PaymentDto.nullable(),
  delivery: DeliveryDto.nullable(),
  transitions: z.array(TransitionDto),
});
type Detail = z.output<typeof DetailDto>;

const toTransactionDto = (t: Transaction): z.output<typeof TransactionDto> => ({
  id: t.id,
  sourceType: t.sourceType,
  sourceId: t.sourceId,
  listingId: t.listingId,
  needId: t.needId,
  buyerId: t.buyerId,
  sellerId: t.sellerId,
  mode: t.mode,
  amount: { amount: t.amount, currency: t.currency },
  quantity: t.quantity,
  terms: t.terms,
  state: t.state,
  buyerConfirmedAt: t.buyerConfirmedAt,
  sellerConfirmedAt: t.sellerConfirmedAt,
  deliveredAt: t.deliveredAt,
  completedAt: t.completedAt,
  cancelReason: t.cancelReason,
  disputeReason: t.disputeReason,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
  version: t.version,
});

const toDetail = (d: TransactionDetail): Detail => ({
  ...toTransactionDto(d.tx),
  viewerRole: d.viewerRole,
  actions: d.actions,
  payment: d.payment
    ? {
        provider: d.payment.provider,
        status: d.payment.status,
        amount: { amount: d.payment.amount, currency: d.payment.currency },
        note: d.payment.note,
        updatedAt: d.payment.updatedAt,
      }
    : null,
  delivery: d.delivery
    ? {
        method: d.delivery.method,
        status: d.delivery.status,
        provider: d.delivery.provider,
        scheduledFor: d.delivery.scheduledFor,
        notes: d.delivery.notes,
        createdAt: d.delivery.createdAt,
        updatedAt: d.delivery.updatedAt,
      }
    : null,
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

const IdParams = z.strictObject({ id: z.uuid() });
const Reason = z.string().trim().min(3).max(500);
const NoBody = z.strictObject({}).nullish();
const ReasonBody = z.strictObject({ reason: Reason });
const ArrangeBody = z.strictObject({
  method: z.enum(DeliveryModes),
  scheduledFor: iso.optional(),
  notes: z.string().trim().min(1).max(500).optional(),
});

const ListQuerySchema = z.strictObject({
  ...PageQuerySchema.shape,
  state: z.enum(TransactionStates).optional(),
});
const MyListQuery = ListQuerySchema.extend({ role: z.enum(['buyer', 'seller']).optional() });
const ListResponse = z.object({
  data: z.array(TransactionDto),
  page: z.object({ nextCursor: z.string().nullable() }),
});

function listQuery(q: z.output<typeof ListQuerySchema>): ListQuery {
  const c = decodeCursor(q.cursor);
  if (
    c &&
    (typeof c.k !== 'string' || Number.isNaN(Date.parse(c.k)) || !z.uuid().safeParse(c.id).success)
  ) {
    throw Errors.validation('Invalid cursor.');
  }
  return { state: q.state, cursor: c, limit: q.limit };
}

const listPage = (rows: Transaction[], limit: number) => {
  const { items, nextCursor } = paginate(rows, limit, (t) => ({
    k: t.createdAt.toISOString(),
    id: t.id,
  }));
  return { data: items.map(toTransactionDto), page: { nextCursor } };
};

export interface TransactionRouteDeps {
  txns: TransactionService;
  runtime: ServiceRuntime<never>;
  idempotencyDb: Kysely<IdempotencyTables>;
}

export const transactionRoutes: FastifyPluginAsyncZod<TransactionRouteDeps> = async (
  app,
  { txns, runtime, idempotencyDb },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };

  /**
   * Every command is idempotent: a retry with the same Idempotency-Key and body replays the
   * stored response (stored in wire form, so a replay is byte-identical).
   */
  const idempotent = async (
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    status: 200 | 201,
    run: () => Promise<TransactionDetail>,
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
      async () => ({ status, body: z.encode(DetailDto, toDetail(await run())) }),
    );
    return reply
      .status(r.status)
      .header('idempotent-replayed', String(r.replayed))
      .send(ok(z.decode(DetailDto, r.body)));
  };

  app.post(
    '/api/v1/transactions',
    {
      preHandler: authenticate,
      schema: {
        tags: ['transactions'],
        summary: 'Buy a listing directly (requires Idempotency-Key)',
        ...secured,
        body: z.strictObject({
          listingId: z.uuid(),
          quantity: z.number().int().min(1).max(10_000),
        }),
        response: { 201: z.object({ data: DetailDto }), ...errors },
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'transaction:create', 201, () =>
        txns.purchaseListing(req.body, req.ctx),
      ),
  );

  app.get(
    '/api/v1/transactions/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['transactions'],
        summary: 'A transaction with payment, delivery, history and my next actions',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: DetailDto }), ...errors },
      },
    },
    async (req) => ok(toDetail(await txns.get(req.params.id, req.ctx))),
  );

  app.get(
    '/api/v1/me/transactions',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'Transactions where I am the buyer or the seller',
        ...secured,
        querystring: MyListQuery,
        response: { 200: ListResponse, ...errors },
      },
    },
    async (req) =>
      listPage(await txns.listMine(req.query.role, listQuery(req.query), req.ctx), req.query.limit),
  );

  const command = <B extends z.ZodType>(
    name: PartyCommand,
    summary: string,
    body: B,
    toInput: (b: z.output<B>) => CommandInput,
  ) =>
    app.post(
      `/api/v1/transactions/:id/${name}`,
      {
        preHandler: authenticate,
        schema: {
          tags: ['transactions'],
          summary: `${summary} (requires Idempotency-Key)`,
          ...secured,
          params: IdParams,
          body,
          response: { 200: z.object({ data: DetailDto }), ...errors },
        },
      },
      async (req, reply) =>
        idempotent(req, reply, `transaction:${name}`, 200, () =>
          txns.command(req.params.id, name, toInput(req.body as z.output<B>), req.ctx),
        ),
    );

  command('confirm', 'Confirm the deal (both parties must confirm)', NoBody, () => ({}));
  command('cancel', 'Cancel before delivery is arranged', ReasonBody, (b) => ({
    reason: b.reason,
  }));
  command('arrange-delivery', 'Record how and when delivery happens', ArrangeBody, (b) => ({
    delivery: { method: b.method, scheduledFor: b.scheduledFor ?? null, notes: b.notes ?? null },
  }));
  command('mark-delivered', 'Seller: the item was handed over', NoBody, () => ({}));
  command('confirm-receipt', 'Buyer: received as agreed; completes the deal', NoBody, () => ({}));
  command('dispute', 'Raise a dispute within the dispute window', ReasonBody, (b) => ({
    reason: b.reason,
  }));

  // ---- admin

  app.get(
    '/api/v1/admin/transactions',
    {
      preHandler: requirePermission('transaction:read:any'),
      schema: {
        tags: ['admin'],
        summary: 'All transactions, optionally by state (e.g. DISPUTED)',
        ...secured,
        querystring: ListQuerySchema,
        response: { 200: ListResponse, ...errors },
      },
    },
    async (req) => listPage(await txns.listAll(listQuery(req.query)), req.query.limit),
  );

  app.post(
    '/api/v1/admin/transactions/:id/resolve',
    {
      preHandler: requirePermission('dispute:resolve'),
      schema: {
        tags: ['admin'],
        summary: 'Resolve a dispute: RELEASE completes, CANCEL cancels (requires Idempotency-Key)',
        ...secured,
        params: IdParams,
        body: z.strictObject({ resolution: z.enum(['RELEASE', 'CANCEL']), note: Reason }),
        response: { 200: z.object({ data: DetailDto }), ...errors },
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'transaction:resolve', 200, () =>
        txns.resolve(req.params.id, req.body.resolution, req.body.note, req.ctx),
      ),
  );
};
