import {
  Conditions,
  DeliveryModes,
  MoneySchema,
  OfferStatuses,
  PageQuerySchema,
  pageSchema,
} from '@dorkar/contracts';
import {
  ok,
  requestFingerprint,
  withIdempotency,
  type FastifyPluginAsyncZod,
  type IdempotencyTables,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type {
  AdminOfferDetail,
  OfferDetail,
  OfferService,
  OfferView,
} from '../../application/offer-service';
import { isLive, OfferActions, type OfferRound } from '../../domain/offer';

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
  503: ErrorResponse,
};

const Party = z.enum(['BUYER', 'SELLER']);
const amount = z.number().int().min(0).max(100_000_000_000);

const DeliveryTermsBody = z.strictObject({
  method: z.enum(DeliveryModes),
  feeAmount: amount.optional(),
  etaDays: z.number().int().min(0).max(365).optional(),
});
const DeliveryTermsDto = z.object({
  method: z.enum(DeliveryModes),
  feeAmount: amount.optional(),
  etaDays: z.number().int().optional(),
});
/** Validated against the need's mode in the domain (BUY/RENT/BORROW/HIRE/SOURCE shapes). */
const ModeTermsBody = z.record(z.string(), z.unknown());

const TermsDto = z.object({
  delivery: DeliveryTermsDto,
  mode: z.record(z.string(), z.unknown()),
  condition: z.enum(Conditions).nullable(),
  availabilityFrom: z.iso.date().nullable(),
});

const OfferDto = z.object({
  id: z.uuid(),
  needId: z.uuid(),
  buyerId: z.uuid(),
  sellerId: z.uuid(),
  listingId: z.uuid().nullable(),
  status: z.enum(OfferStatuses),
  price: MoneySchema,
  quantity: z.number().int(),
  condition: z.enum(Conditions).nullable(),
  availabilityFrom: z.iso.date().nullable(),
  deliveryTerms: DeliveryTermsDto,
  modeTerms: z.record(z.string(), z.unknown()),
  description: z.string().nullable(),
  attachmentMediaIds: z.array(z.uuid()),
  expiresAt: iso,
  currentRound: z.number().int(),
  /** Whose move it is; null once the offer is no longer live. */
  awaiting: Party.nullable(),
  /** Hidden by moderation: content is withheld from the parties. */
  hidden: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
  /** What the caller may do now. Render these; do not re-derive the rules client-side. */
  actions: z.array(z.enum(OfferActions)),
});

const RoundDto = z.object({
  round: z.number().int(),
  proposedBy: Party,
  price: MoneySchema,
  quantity: z.number().int(),
  terms: TermsDto,
  message: z.string().nullable(),
  createdAt: iso,
});

const OfferDetailDto = OfferDto.extend({ rounds: z.array(RoundDto) });
const CompareItemDto = OfferDto.extend({ sellerDisplayName: z.string().nullable() });
const AdminOfferDto = OfferDetailDto.extend({
  history: z.array(
    z.object({
      from: z.enum(OfferStatuses).nullable(),
      to: z.enum(OfferStatuses),
      reason: z.string(),
      actorId: z.uuid().nullable(),
      at: iso,
    }),
  ),
});

const toOffer = (v: Pick<OfferView, 'offer' | 'actions'>): z.output<typeof OfferDto> => {
  const o = v.offer;
  return {
    id: o.id,
    needId: o.needId,
    buyerId: o.buyerId,
    sellerId: o.sellerId,
    listingId: o.listingId,
    status: o.status,
    price: o.price,
    quantity: o.quantity,
    condition: o.condition,
    availabilityFrom: o.availabilityFrom,
    deliveryTerms: o.deliveryTerms,
    modeTerms: o.modeTerms,
    description: o.description,
    attachmentMediaIds: o.attachmentMediaIds,
    expiresAt: o.expiresAt,
    currentRound: o.currentRound,
    awaiting: isLive(o.status) ? o.awaiting : null,
    hidden: o.hidden,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    actions: v.actions,
  };
};

const toRound = (r: OfferRound): z.output<typeof RoundDto> => ({
  round: r.round,
  proposedBy: r.proposedBy,
  price: r.price,
  quantity: r.quantity,
  terms: r.terms,
  message: r.message,
  createdAt: r.createdAt,
});

const toDetail = (d: OfferDetail): z.output<typeof OfferDetailDto> => ({
  ...toOffer(d),
  rounds: d.rounds.map(toRound),
});

const toAdmin = (d: AdminOfferDetail): z.output<typeof AdminOfferDto> => ({
  ...toOffer({ offer: d.offer, actions: [] }),
  rounds: d.rounds.map(toRound),
  history: d.history,
});

const SubmitBody = z.strictObject({
  listingId: z.uuid().nullable().optional(),
  /** Total price for `quantity`, in poisha. */
  price: MoneySchema,
  quantity: z.number().int().min(1).max(1_000_000),
  condition: z.enum(Conditions).nullable().optional(),
  availabilityFrom: z.iso.date().nullable().optional(),
  deliveryTerms: DeliveryTermsBody,
  modeTerms: ModeTermsBody.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  attachmentMediaIds: z.array(z.uuid()).max(5).optional(),
  /** Defaults to OFFER_DEFAULT_TTL_HOURS; never beyond the need's own expiry. */
  expiresInHours: z.number().int().min(1).optional(),
});

const CounterBody = z.strictObject({
  price: MoneySchema,
  quantity: z.number().int().min(1).max(1_000_000),
  deliveryTerms: DeliveryTermsBody.optional(),
  modeTerms: ModeTermsBody.optional(),
  condition: z.enum(Conditions).nullable().optional(),
  availabilityFrom: z.iso.date().nullable().optional(),
  message: z.string().trim().max(1000).nullable().optional(),
});

const OfferIdParams = z.strictObject({ id: z.uuid() });

export interface OfferRouteDeps {
  offers: OfferService;
  runtime: ServiceRuntime<never>;
  db: Kysely<IdempotencyTables>;
}

export const offerRoutes: FastifyPluginAsyncZod<OfferRouteDeps> = async (
  app,
  { offers, runtime, db },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  const idempotencyHeader = z.object({ 'idempotency-key': z.string().optional() }).loose();

  /**
   * Runs a critical command at most once per Idempotency-Key. The stored body is the wire form,
   * so a replay returns byte-identical JSON; it is decoded back so the response schema can
   * serialize either path the same way.
   */
  const once = async <S extends z.ZodType>(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    schema: S,
    status: number,
    run: () => Promise<z.output<S>>,
  ): Promise<z.output<S>> => {
    const key = req.headers['idempotency-key'];
    const r = await withIdempotency(
      db,
      {
        actorId: req.ctx.actor!.id,
        scope,
        key: typeof key === 'string' ? key : undefined,
        fingerprint: requestFingerprint({ params: req.params, body: req.body ?? null }),
        required: true,
      },
      async () => ({ status, body: z.encode(schema, await run()) }),
    );
    void reply.code(r.status);
    return z.decode(schema, r.body);
  };

  const Detail = z.object({ data: OfferDetailDto });

  app.post(
    '/api/v1/needs/:needId/offers',
    {
      preHandler: requirePermission('offer:create'),
      schema: {
        tags: ['offers'],
        summary: 'Make an offer on a need (Idempotency-Key required)',
        ...secured,
        headers: idempotencyHeader,
        params: z.strictObject({ needId: z.uuid() }),
        body: SubmitBody,
        response: { 201: Detail, ...errors },
      },
    },
    async (req, reply) =>
      once(req, reply, 'offer.submit', Detail, 201, async () =>
        ok(toDetail(await offers.submit(req.params.needId, req.body, req.ctx))),
      ),
  );

  app.get(
    '/api/v1/needs/:needId/offers',
    {
      preHandler: authenticate,
      schema: {
        tags: ['offers'],
        summary: 'Compare offers on my need (requester only; others get 404)',
        ...secured,
        params: z.strictObject({ needId: z.uuid() }),
        querystring: z.strictObject({
          ...PageQuerySchema.shape,
          sort: z.enum(['price_asc', 'newest']).default('newest'),
          status: z.enum(OfferStatuses).optional(),
        }),
        response: { 200: pageSchema(CompareItemDto), ...errors },
      },
    },
    async (req) => {
      const { items, nextCursor } = await offers.listForNeed(
        req.params.needId,
        {
          sort: req.query.sort,
          cursor: req.query.cursor,
          limit: req.query.limit,
          ...(req.query.status ? { status: req.query.status } : {}),
        },
        req.ctx,
      );
      return {
        data: items.map((v) => ({ ...toOffer(v), sellerDisplayName: v.sellerName })),
        page: { nextCursor },
      };
    },
  );

  app.get(
    '/api/v1/me/offers',
    {
      preHandler: authenticate,
      schema: {
        tags: ['offers'],
        summary: 'Offers I have made (seller)',
        ...secured,
        querystring: z.strictObject({
          ...PageQuerySchema.shape,
          status: z.enum(OfferStatuses).optional(),
        }),
        response: { 200: pageSchema(OfferDto), ...errors },
      },
    },
    async (req) => {
      const { items, nextCursor } = await offers.listMine(
        {
          cursor: req.query.cursor,
          limit: req.query.limit,
          ...(req.query.status ? { status: req.query.status } : {}),
        },
        req.ctx,
      );
      return { data: items.map(toOffer), page: { nextCursor } };
    },
  );

  app.get(
    '/api/v1/offers/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['offers'],
        summary: 'An offer with its negotiation rounds (buyer or seller only)',
        ...secured,
        params: OfferIdParams,
        response: { 200: Detail, ...errors },
      },
    },
    async (req) => ok(toDetail(await offers.getForParty(req.params.id, req.ctx))),
  );

  app.post(
    '/api/v1/offers/:id/counter',
    {
      preHandler: authenticate,
      schema: {
        tags: ['offers'],
        summary: 'Counter with new terms (party whose turn it is; Idempotency-Key required)',
        ...secured,
        headers: idempotencyHeader,
        params: OfferIdParams,
        body: CounterBody,
        response: { 200: Detail, ...errors },
      },
    },
    async (req, reply) =>
      once(req, reply, 'offer.counter', Detail, 200, async () =>
        ok(toDetail(await offers.counter(req.params.id, req.body, req.ctx))),
      ),
  );

  app.post(
    '/api/v1/offers/:id/accept',
    {
      preHandler: authenticate,
      schema: {
        tags: ['offers'],
        summary: 'Accept the latest terms (party whose turn it is; Idempotency-Key required)',
        description:
          'Exclusive: concurrent acceptances on one need serialize; the loser gets 409 with ' +
          'details.rule NEED_QUANTITY_EXHAUSTED. The transaction is created asynchronously from ' +
          'the OfferAccepted event.',
        ...secured,
        headers: idempotencyHeader,
        params: OfferIdParams,
        response: { 200: Detail, ...errors },
      },
    },
    async (req, reply) =>
      once(req, reply, 'offer.accept', Detail, 200, async () =>
        ok(toDetail(await offers.accept(req.params.id, req.ctx))),
      ),
  );

  app.post(
    '/api/v1/offers/:id/reject',
    {
      preHandler: authenticate,
      schema: {
        tags: ['offers'],
        summary: 'Reject an offer (buyer)',
        ...secured,
        params: OfferIdParams,
        response: { 200: Detail, ...errors },
      },
    },
    async (req) => ok(toDetail(await offers.reject(req.params.id, req.ctx))),
  );

  app.post(
    '/api/v1/offers/:id/withdraw',
    {
      preHandler: authenticate,
      schema: {
        tags: ['offers'],
        summary: 'Withdraw my offer (seller)',
        ...secured,
        params: OfferIdParams,
        response: { 200: Detail, ...errors },
      },
    },
    async (req) => ok(toDetail(await offers.withdraw(req.params.id, req.ctx))),
  );

  app.get(
    '/api/v1/admin/offers/:id',
    {
      preHandler: requirePermission('transaction:read:any'),
      schema: {
        tags: ['admin'],
        summary: 'Support view of an offer: full content, rounds and status history',
        ...secured,
        params: OfferIdParams,
        response: { 200: z.object({ data: AdminOfferDto }), ...errors },
      },
    },
    async (req) => ok(toAdmin(await offers.getForAdmin(req.params.id, req.ctx))),
  );
};
