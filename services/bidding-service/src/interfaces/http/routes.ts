import {
  AuctionKinds,
  AuctionStatuses,
  AuctionSubjects,
  BidStatuses,
  DistrictSchema,
  MoneySchema,
  NeedModes,
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
  AdminAuctionDetail,
  AuctionSummary,
  AuctionView,
  BiddingService,
  BidResult,
  BidView,
} from '../../application/bidding-service';
import type { MyBid } from '../../application/ports';
import { AuctionActions, bidderAlias, type Bid } from '../../domain/auction';

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
  503: ErrorResponse,
};

// ---------------------------------------------------------------- DTOs

const AuctionDto = z.object({
  id: z.uuid(),
  kind: z.enum(AuctionKinds),
  ownerId: z.uuid(),
  subjectType: z.enum(AuctionSubjects),
  subjectId: z.uuid(),
  categoryId: z.uuid(),
  title: z.string(),
  district: DistrictSchema,
  mode: z.enum(NeedModes),
  /** The bid amount is the total price for this quantity. */
  quantity: z.number().int(),
  /** FORWARD: opening price. REVERSE: ceiling. */
  startPrice: MoneySchema,
  minIncrement: MoneySchema,
  /** Only the owner and staff see it; null for everyone else. */
  reservePrice: MoneySchema.nullable(),
  reserveMet: z.boolean(),
  startsAt: iso,
  endsAt: iso,
  antiSnipeSeconds: z.number().int(),
  status: z.enum(AuctionStatuses),
  leadingAmount: MoneySchema.nullable(),
  bidCount: z.number().int(),
  /** Hidden by moderation (only the owner and staff can see it at all). */
  hidden: z.boolean(),
  cancelReason: z.string().nullable(),
  closedAt: iso.nullable(),
  createdAt: iso,
});

const MyBidDto = z.object({
  id: z.uuid(),
  amount: MoneySchema,
  status: z.enum(BidStatuses),
  placedAt: iso,
});

const AuctionDetailDto = AuctionDto.extend({
  /** What the caller may do now. Render these; do not re-derive the rules client-side. */
  actions: z.array(z.enum(AuctionActions)),
  /** The caller's most recent bid on this auction. */
  myBid: MyBidDto.nullable(),
  /** FORWARD: bid at least `minimum`. REVERSE: bid at most `maximum`. Null when bidding is closed. */
  nextBid: z.object({ minimum: MoneySchema, maximum: MoneySchema.nullable() }).nullable(),
  /** Set once awarded, for the owner, the winner and staff. */
  winnerId: z.uuid().nullable(),
});

const BidDto = z.object({
  id: z.uuid(),
  /** Stable per-auction alias; account ids are never exposed. */
  bidder: z.string(),
  isMine: z.boolean(),
  amount: MoneySchema,
  status: z.enum(BidStatuses),
  placedAt: iso,
});

const MyBidListDto = MyBidDto.extend({
  auction: z.object({
    id: z.uuid(),
    kind: z.enum(AuctionKinds),
    title: z.string(),
    status: z.enum(AuctionStatuses),
    endsAt: iso,
    leadingAmount: MoneySchema.nullable(),
  }),
});

const AdminAuctionDto = AuctionDto.extend({
  history: z.array(
    z.object({
      from: z.enum(AuctionStatuses).nullable(),
      to: z.enum(AuctionStatuses),
      reason: z.string(),
      actorId: z.uuid().nullable(),
      at: iso,
    }),
  ),
});

const BidResultDto = z.object({ bid: BidDto, auction: AuctionDetailDto });

const toAuction = (v: AuctionSummary): z.output<typeof AuctionDto> => {
  const a = v.auction;
  return {
    id: a.id,
    kind: a.kind,
    ownerId: a.ownerId,
    subjectType: a.subjectType,
    subjectId: a.subjectId,
    categoryId: a.categoryId,
    title: a.title,
    district: a.district,
    mode: a.mode,
    quantity: a.quantity,
    startPrice: a.startPrice,
    minIncrement: a.minIncrement,
    reservePrice: v.reserveVisible ? a.reservePrice : null,
    reserveMet: v.reserveMet,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    antiSnipeSeconds: a.antiSnipeSeconds,
    status: a.status,
    leadingAmount: a.leadingAmount,
    bidCount: a.bidCount,
    hidden: a.hidden,
    cancelReason: a.cancelReason,
    closedAt: a.closedAt,
    createdAt: a.createdAt,
  };
};

const toMyBid = (b: Bid): z.output<typeof MyBidDto> => ({
  id: b.id,
  amount: b.amount,
  status: b.status,
  placedAt: b.placedAt,
});

const toDetail = (v: AuctionView): z.output<typeof AuctionDetailDto> => ({
  ...toAuction(v),
  actions: v.actions,
  myBid: v.myBid ? toMyBid(v.myBid) : null,
  nextBid: v.nextBid,
  winnerId: v.winnerId,
});

const toBid = (v: BidView): z.output<typeof BidDto> => ({
  id: v.bid.id,
  bidder: bidderAlias(v.bid.alias),
  isMine: v.isMine,
  amount: v.bid.amount,
  status: v.bid.status,
  placedAt: v.bid.placedAt,
});

const toBidResult = (r: BidResult): z.output<typeof BidResultDto> => ({
  bid: toBid({ bid: r.bid, isMine: true }),
  auction: toDetail(r.auction),
});

const toMyBidRow = (r: MyBid): z.output<typeof MyBidListDto> => ({
  ...toMyBid(r.bid),
  auction: {
    id: r.auction.id,
    kind: r.auction.kind,
    title: r.auction.title,
    status: r.auction.status,
    endsAt: r.auction.endsAt,
    leadingAmount: r.auction.leadingAmount,
  },
});

const toAdmin = (d: AdminAuctionDetail): z.output<typeof AdminAuctionDto> => ({
  ...toAuction(d),
  history: d.history,
});

// ---------------------------------------------------------------- requests

const CreateBody = z.strictObject({
  kind: z.enum(AuctionKinds),
  /** FORWARD: one of my PRODUCT listings. REVERSE: one of my OPEN needs (mode SOURCE or BUY). */
  subjectId: z.uuid(),
  /** FORWARD only (default 1, at most the listing's stock). REVERSE uses the need's quantity. */
  quantity: z.number().int().min(1).max(1_000_000).optional(),
  /** FORWARD: opening price (required). REVERSE: ceiling (defaults to the need's budgetMax). */
  startPrice: MoneySchema.optional(),
  /** Secret reserve; bidders only learn whether it is met. */
  reservePrice: MoneySchema.nullable().optional(),
  minIncrement: MoneySchema.refine((m) => m.amount > 0, 'Must be more than zero.'),
  /** Defaults to now (opens immediately). At most 7 days ahead. */
  startsAt: z.iso.datetime({ offset: true }).optional(),
  /** At least 1 hour after the start, at most BIDDING_MAX_DURATION_DAYS. */
  endsAt: z.iso.datetime({ offset: true }),
  antiSnipeSeconds: z.number().int().min(0).max(600).optional(),
});

const BidBody = z.strictObject({
  /** Total price for the auctioned quantity, in poisha. */
  amount: MoneySchema,
});

/** Optional: an empty body is fine. */
const CancelBody = z
  .strictObject({ reason: z.string().trim().min(1).max(500).optional() })
  .nullish();
const AdminCancelBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

const IdParams = z.strictObject({ id: z.uuid() });

export interface BiddingRouteDeps {
  bidding: BiddingService;
  runtime: ServiceRuntime<never>;
  db: Kysely<IdempotencyTables>;
}

export const biddingRoutes: FastifyPluginAsyncZod<BiddingRouteDeps> = async (
  app,
  { bidding, runtime, db },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  const idempotencyHeader = z.object({ 'idempotency-key': z.string().optional() }).loose();
  /** Public routes that show more to a signed-in caller: authenticate only if a token is sent. */
  const optionalAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization) await authenticate(req, reply);
  };
  const keyOf = (req: FastifyRequest) => {
    const key = req.headers['idempotency-key'];
    return typeof key === 'string' ? key : undefined;
  };

  /**
   * Runs a command at most once per Idempotency-Key. The stored body is the wire form, so a
   * replay returns byte-identical JSON; it is decoded back so the response schema can serialize
   * either path the same way.
   */
  const once = async <S extends z.ZodType>(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    schema: S,
    status: number,
    run: () => Promise<z.output<S>>,
  ): Promise<z.output<S>> => {
    const r = await withIdempotency(
      db,
      {
        actorId: req.ctx.actor!.id,
        scope,
        key: keyOf(req),
        fingerprint: requestFingerprint({ params: req.params, body: req.body ?? null }),
        required: true,
      },
      async () => ({ status, body: z.encode(schema, await run()) }),
    );
    void reply.code(r.status);
    return z.decode(schema, r.body);
  };

  const Detail = z.object({ data: AuctionDetailDto });
  const BidResultBody = z.object({ data: BidResultDto });

  // ------------------------------------------------------------ auctions

  app.post(
    '/api/v1/auctions',
    {
      preHandler: requirePermission('auction:create'),
      schema: {
        tags: ['auctions'],
        summary: 'Start an auction on my listing (FORWARD) or need (REVERSE)',
        description: 'Idempotency-Key required. Opens immediately when startsAt is now or omitted.',
        ...secured,
        headers: idempotencyHeader,
        body: CreateBody,
        response: { 201: Detail, ...errors },
      },
    },
    async (req, reply) =>
      once(req, reply, 'auction.create', Detail, 201, async () => {
        const b = req.body;
        return ok(
          toDetail(
            await bidding.create(
              {
                kind: b.kind,
                subjectId: b.subjectId,
                quantity: b.quantity,
                startPrice: b.startPrice,
                reservePrice: b.reservePrice,
                minIncrement: b.minIncrement,
                startsAt: b.startsAt ? new Date(b.startsAt) : undefined,
                endsAt: new Date(b.endsAt),
                antiSnipeSeconds: b.antiSnipeSeconds,
              },
              req.ctx,
            ),
          ),
        );
      }),
  );

  app.get(
    '/api/v1/auctions',
    {
      schema: {
        tags: ['auctions'],
        summary: 'Browse auctions (public), ending soonest first',
        querystring: z.strictObject({
          ...PageQuerySchema.shape,
          kind: z.enum(AuctionKinds).optional(),
          categoryId: z.uuid().optional(),
          district: DistrictSchema.optional(),
          status: z.enum(AuctionStatuses).default('OPEN'),
        }),
        response: { 200: pageSchema(AuctionDto), ...errors },
      },
    },
    async (req) => {
      const q = req.query;
      const page = await bidding.browse({
        status: q.status,
        kind: q.kind,
        categoryId: q.categoryId,
        district: q.district,
        cursor: q.cursor,
        limit: q.limit,
      });
      return { data: page.items.map(toAuction), page: { nextCursor: page.nextCursor } };
    },
  );

  app.get(
    '/api/v1/auctions/:id',
    {
      preHandler: optionalAuth,
      schema: {
        tags: ['auctions'],
        summary: 'An auction: leader, bid count, reserve met, my bid and my actions',
        params: IdParams,
        response: { 200: Detail, ...errors },
      },
    },
    async (req) => ok(toDetail(await bidding.get(req.params.id, req.ctx))),
  );

  app.get(
    '/api/v1/auctions/:id/bids',
    {
      preHandler: optionalAuth,
      schema: {
        tags: ['auctions'],
        summary: 'Bid history, newest first (bidders shown as per-auction aliases)',
        params: IdParams,
        querystring: z.strictObject({ ...PageQuerySchema.shape }),
        response: { 200: pageSchema(BidDto), ...errors },
      },
    },
    async (req) => {
      const page = await bidding.listBids(
        req.params.id,
        { cursor: req.query.cursor, limit: req.query.limit },
        req.ctx,
      );
      return { data: page.items.map(toBid), page: { nextCursor: page.nextCursor } };
    },
  );

  app.post(
    '/api/v1/auctions/:id/bids',
    {
      preHandler: requirePermission('bid:create'),
      schema: {
        tags: ['auctions'],
        summary: 'Place a bid (Idempotency-Key required)',
        description:
          'Bids on one auction serialize on the auction row. FORWARD: at least the opening ' +
          'price, then the leading bid plus the minimum increment. REVERSE: at most the ceiling, ' +
          'then the leading bid minus the minimum increment. A bid in the anti-sniping window ' +
          'extends the end. 10 bids per minute per auction.',
        ...secured,
        headers: idempotencyHeader,
        params: IdParams,
        body: BidBody,
        response: { 201: BidResultBody, ...errors },
      },
    },
    async (req, reply) => {
      await bidding.assertBidRate(req.params.id, req.ctx);
      return once(req, reply, 'bid.place', BidResultBody, 201, async () =>
        ok(
          toBidResult(
            await bidding.placeBid(
              req.params.id,
              { amount: req.body.amount, idempotencyKey: keyOf(req) ?? null },
              req.ctx,
            ),
          ),
        ),
      );
    },
  );

  app.post(
    '/api/v1/auctions/:id/bids/:bidId/retract',
    {
      preHandler: authenticate,
      schema: {
        tags: ['auctions'],
        summary: 'Retract my bid shortly after placing it (Idempotency-Key required)',
        ...secured,
        headers: idempotencyHeader,
        params: z.strictObject({ id: z.uuid(), bidId: z.uuid() }),
        response: { 200: BidResultBody, ...errors },
      },
    },
    async (req, reply) =>
      once(req, reply, 'bid.retract', BidResultBody, 200, async () =>
        ok(toBidResult(await bidding.retract(req.params.id, req.params.bidId, req.ctx))),
      ),
  );

  app.post(
    '/api/v1/auctions/:id/cancel',
    {
      preHandler: authenticate,
      schema: {
        tags: ['auctions'],
        summary: 'Cancel my auction (scheduled, or open without bids; Idempotency-Key required)',
        ...secured,
        headers: idempotencyHeader,
        params: IdParams,
        body: CancelBody,
        response: { 200: Detail, ...errors },
      },
    },
    async (req, reply) =>
      once(req, reply, 'auction.cancel', Detail, 200, async () =>
        ok(toDetail(await bidding.cancel(req.params.id, req.body?.reason ?? null, req.ctx))),
      ),
  );

  // ------------------------------------------------------------ mine

  app.get(
    '/api/v1/me/auctions',
    {
      preHandler: authenticate,
      schema: {
        tags: ['auctions'],
        summary: 'Auctions I run',
        ...secured,
        querystring: z.strictObject({
          ...PageQuerySchema.shape,
          status: z.enum(AuctionStatuses).optional(),
        }),
        response: { 200: pageSchema(AuctionDto), ...errors },
      },
    },
    async (req) => {
      const page = await bidding.listMine(
        { status: req.query.status, cursor: req.query.cursor, limit: req.query.limit },
        req.ctx,
      );
      return { data: page.items.map(toAuction), page: { nextCursor: page.nextCursor } };
    },
  );

  app.get(
    '/api/v1/me/bids',
    {
      preHandler: authenticate,
      schema: {
        tags: ['auctions'],
        summary: 'Bids I placed, newest first',
        ...secured,
        querystring: z.strictObject({
          ...PageQuerySchema.shape,
          status: z.enum(BidStatuses).optional(),
        }),
        response: { 200: pageSchema(MyBidListDto), ...errors },
      },
    },
    async (req) => {
      const page = await bidding.listMyBids(
        { status: req.query.status, cursor: req.query.cursor, limit: req.query.limit },
        req.ctx,
      );
      return { data: page.items.map(toMyBidRow), page: { nextCursor: page.nextCursor } };
    },
  );

  // ------------------------------------------------------------ admin

  app.get(
    '/api/v1/admin/auctions',
    {
      preHandler: requirePermission('auction:manage'),
      schema: {
        tags: ['admin'],
        summary: 'All auctions (including hidden), newest first',
        ...secured,
        querystring: z.strictObject({
          ...PageQuerySchema.shape,
          status: z.enum(AuctionStatuses).optional(),
        }),
        response: { 200: pageSchema(AuctionDto), ...errors },
      },
    },
    async (req) => {
      const page = await bidding.listAdmin({
        status: req.query.status,
        cursor: req.query.cursor,
        limit: req.query.limit,
      });
      return { data: page.items.map(toAuction), page: { nextCursor: page.nextCursor } };
    },
  );

  app.get(
    '/api/v1/admin/auctions/:id',
    {
      preHandler: requirePermission('auction:manage'),
      schema: {
        tags: ['admin'],
        summary: 'An auction with its status history',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: AdminAuctionDto }), ...errors },
      },
    },
    async (req) => ok(toAdmin(await bidding.getForAdmin(req.params.id))),
  );

  app.post(
    '/api/v1/admin/auctions/:id/cancel',
    {
      preHandler: requirePermission('auction:manage'),
      schema: {
        tags: ['admin'],
        summary: 'Cancel any live auction, with a reason (Idempotency-Key required)',
        ...secured,
        headers: idempotencyHeader,
        params: IdParams,
        body: AdminCancelBody,
        response: { 200: Detail, ...errors },
      },
    },
    async (req, reply) =>
      once(req, reply, 'auction.admin_cancel', Detail, 200, async () =>
        ok(toDetail(await bidding.adminCancel(req.params.id, req.body.reason, req.ctx))),
      ),
  );
};
