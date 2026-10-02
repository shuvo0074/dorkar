import { BookingStatuses, MoneySchema, PageQuerySchema } from '@dorkar/contracts';
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
  PartyCommands,
  type BookingDetail,
  type BookingService,
  type PartyCommand,
} from '../../application/booking-service';
import type { CalendarService } from '../../application/calendar-service';
import type { Block, ListQuery } from '../../application/ports';
import type { Booking, RentalTerms } from '../../domain/booking';

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

const Money = z.object({ amount: z.number().int(), currency: z.literal('BDT') });

// ---------------------------------------------------------------- terms

const TermsDto = z.object({
  listingId: z.uuid(),
  instantBook: z.boolean(),
  minDurationHours: z.number().int(),
  maxDurationDays: z.number().int(),
  deposit: Money.nullable(),
  advanceNoticeHours: z.number().int(),
  bufferHours: z.number().int(),
  cancellationNote: z.string().nullable(),
  /** null: the listing uses the defaults. */
  updatedAt: iso.nullable(),
});
const toTermsDto = (t: RentalTerms): z.output<typeof TermsDto> => ({
  listingId: t.listingId,
  instantBook: t.instantBook,
  minDurationHours: t.minDurationHours,
  maxDurationDays: t.maxDurationDays,
  deposit: t.deposit,
  advanceNoticeHours: t.advanceNoticeHours,
  bufferHours: t.bufferHours,
  cancellationNote: t.cancellationNote,
  updatedAt: t.updatedAt,
});

const TermsBody = z.strictObject({
  instantBook: z.boolean(),
  minDurationHours: z.number().int().min(1).max(8760),
  maxDurationDays: z.number().int().min(1).max(365),
  deposit: MoneySchema.nullable(),
  advanceNoticeHours: z.number().int().min(0).max(720),
  bufferHours: z.number().int().min(0).max(168),
  cancellationNote: z.string().trim().min(1).max(500).nullable(),
});

// ---------------------------------------------------------------- calendar

const ListingParams = z.strictObject({ listingId: z.uuid() });
const BlockParams = z.strictObject({ listingId: z.uuid(), blockId: z.uuid() });

const WindowQuery = z.strictObject({ from: iso.optional(), to: iso.optional() });
const DAY = 86_400_000;
const windowOf = (q: z.output<typeof WindowQuery>, defaultDays: number) => {
  const from = q.from ?? new Date();
  return { from, to: q.to ?? new Date(from.getTime() + defaultDays * DAY) };
};

const IntervalDto = z.object({ startAt: iso, endAt: iso });
const AvailabilityDto = z.object({
  listingId: z.uuid(),
  from: iso,
  to: iso,
  /** Busy intervals, merged; nothing about who or why. */
  busy: z.array(IntervalDto),
});

const BlockDto = z.object({
  id: z.uuid(),
  listingId: z.uuid(),
  startAt: iso,
  endAt: iso,
  reason: z.string().nullable(),
  createdAt: iso,
});
const toBlockDto = (b: Block): z.output<typeof BlockDto> => ({
  id: b.id,
  listingId: b.listingId,
  startAt: b.startAt,
  endAt: b.endAt,
  reason: b.reason,
  createdAt: b.createdAt,
});
const BlockBody = z.strictObject({
  startAt: iso,
  endAt: iso,
  reason: z.string().trim().min(1).max(200).optional(),
});

// ---------------------------------------------------------------- bookings

const BookingDto = z.object({
  id: z.uuid(),
  listingId: z.uuid(),
  ownerId: z.uuid(),
  renterId: z.uuid(),
  status: z.enum(BookingStatuses),
  startAt: iso,
  endAt: iso,
  holdExpiresAt: iso.nullable(),
  amount: Money,
  deposit: Money.nullable(),
  terms: z.record(z.string(), z.unknown()),
  transactionId: z.uuid().nullable(),
  disputed: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
  version: z.number().int(),
});

const TransitionDto = z.object({
  from: z.enum(BookingStatuses),
  to: z.enum(BookingStatuses),
  command: z.string(),
  actorId: z.uuid().nullable(),
  actorRole: z.string(),
  reason: z.string().nullable(),
  at: iso,
});

const DetailDto = BookingDto.extend({
  note: z.string().nullable(),
  declineReason: z.string().nullable(),
  cancelReason: z.string().nullable(),
  overdueNotifiedAt: iso.nullable(),
  viewerRole: z.enum(['RENTER', 'OWNER']).nullable(),
  actions: z.array(z.enum(PartyCommands)),
  transitions: z.array(TransitionDto),
});
type Detail = z.output<typeof DetailDto>;

const toBookingDto = (b: Booking): z.output<typeof BookingDto> => ({
  id: b.id,
  listingId: b.listingId,
  ownerId: b.ownerId,
  renterId: b.renterId,
  status: b.status,
  startAt: b.startAt,
  endAt: b.endAt,
  holdExpiresAt: b.holdExpiresAt,
  amount: { amount: b.amount, currency: b.currency },
  deposit: b.deposit === null ? null : { amount: b.deposit, currency: b.currency },
  terms: b.terms,
  transactionId: b.transactionId,
  disputed: b.disputed,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
  version: b.version,
});

const toDetail = (d: BookingDetail): Detail => ({
  ...toBookingDto(d.booking),
  note: d.booking.note,
  declineReason: d.booking.declineReason,
  cancelReason: d.booking.cancelReason,
  overdueNotifiedAt: d.booking.overdueNotifiedAt,
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

const IdParams = z.strictObject({ id: z.uuid() });
const Reason = z.string().trim().min(3).max(500);
const NoBody = z.strictObject({}).nullish();
const CreateBody = z.strictObject({
  listingId: z.uuid(),
  startAt: iso,
  endAt: iso,
  note: z.string().trim().min(1).max(500).optional(),
});

const ListQuerySchema = z.strictObject({
  ...PageQuerySchema.shape,
  status: z.enum(BookingStatuses).optional(),
});
const MyListQuery = ListQuerySchema.extend({ role: z.enum(['renter', 'owner']).optional() });
const ListResponse = z.object({
  data: z.array(BookingDto),
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
  return { status: q.status, cursor: c, limit: q.limit };
}

const listPage = (rows: Booking[], limit: number) => {
  const { items, nextCursor } = paginate(rows, limit, (b) => ({
    k: b.createdAt.toISOString(),
    id: b.id,
  }));
  return { data: items.map(toBookingDto), page: { nextCursor } };
};

export interface RentalRouteDeps {
  bookings: BookingService;
  calendar: CalendarService;
  runtime: ServiceRuntime<never>;
  idempotencyDb: Kysely<IdempotencyTables>;
}

export const rentalRoutes: FastifyPluginAsyncZod<RentalRouteDeps> = async (
  app,
  { bookings, calendar, runtime, idempotencyDb },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };

  /**
   * Every command POST is idempotent: a retry with the same Idempotency-Key and body replays the
   * stored response (stored in wire form, so a replay is byte-identical).
   */
  const idempotent = async <S extends z.ZodType>(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    status: 200 | 201,
    dto: S,
    run: () => Promise<z.output<S>>,
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
      async () => ({ status, body: z.encode(dto, await run()) }),
    );
    return reply
      .status(r.status)
      .header('idempotent-replayed', String(r.replayed))
      .send(ok(z.decode(dto, r.body)));
  };

  // ---- rental terms

  app.get(
    '/api/v1/listings/:listingId/rental-terms',
    {
      schema: {
        tags: ['rental'],
        summary: 'Rental terms of a listing (defaults when the owner has not set any)',
        params: ListingParams,
        response: { 200: z.object({ data: TermsDto }), ...errors },
      },
    },
    async (req) => ok(toTermsDto(await calendar.getTerms(req.params.listingId))),
  );

  app.put(
    '/api/v1/listings/:listingId/rental-terms',
    {
      preHandler: authenticate,
      schema: {
        tags: ['rental'],
        summary: 'Owner: set rental terms',
        ...secured,
        params: ListingParams,
        body: TermsBody,
        response: { 200: z.object({ data: TermsDto }), ...errors },
      },
    },
    async (req) => ok(toTermsDto(await calendar.putTerms(req.params.listingId, req.body, req.ctx))),
  );

  // ---- calendar

  app.get(
    '/api/v1/listings/:listingId/availability',
    {
      schema: {
        tags: ['rental'],
        summary: 'Busy intervals in [from, to) (max 120 days; default the next 30 days)',
        params: ListingParams,
        querystring: WindowQuery,
        response: { 200: z.object({ data: AvailabilityDto }), ...errors },
      },
    },
    async (req) => {
      const { from, to } = windowOf(req.query, 30);
      const busy = await calendar.availability(req.params.listingId, from, to);
      return ok({ listingId: req.params.listingId, from, to, busy });
    },
  );

  app.get(
    '/api/v1/listings/:listingId/availability/blocks',
    {
      preHandler: authenticate,
      schema: {
        tags: ['rental'],
        summary: 'Owner: my blocks in [from, to) (default the next 120 days)',
        ...secured,
        params: ListingParams,
        querystring: WindowQuery,
        response: { 200: z.object({ data: z.array(BlockDto) }), ...errors },
      },
    },
    async (req) => {
      const { from, to } = windowOf(req.query, 120);
      const blocks = await calendar.listBlocks(req.params.listingId, from, to, req.ctx);
      return ok(blocks.map(toBlockDto));
    },
  );

  app.post(
    '/api/v1/listings/:listingId/availability/blocks',
    {
      preHandler: authenticate,
      schema: {
        tags: ['rental'],
        summary: 'Owner: block a period (requires Idempotency-Key)',
        ...secured,
        params: ListingParams,
        body: BlockBody,
        response: { 201: z.object({ data: BlockDto }), ...errors },
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'rental:block', 201, BlockDto, async () =>
        toBlockDto(
          await calendar.addBlock(
            req.params.listingId,
            {
              startAt: req.body.startAt,
              endAt: req.body.endAt,
              reason: req.body.reason ?? null,
            },
            req.ctx,
          ),
        ),
      ),
  );

  app.delete(
    '/api/v1/listings/:listingId/availability/blocks/:blockId',
    {
      preHandler: authenticate,
      schema: {
        tags: ['rental'],
        summary: 'Owner: remove a block',
        ...secured,
        params: BlockParams,
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      await calendar.removeBlock(req.params.listingId, req.params.blockId, req.ctx);
      return reply.status(204).send(null);
    },
  );

  // ---- bookings

  app.post(
    '/api/v1/bookings',
    {
      preHandler: requirePermission('booking:create'),
      schema: {
        tags: ['bookings'],
        summary:
          'Request a booking: HELD (instant book) or PENDING_APPROVAL (requires Idempotency-Key)',
        ...secured,
        body: CreateBody,
        response: { 201: z.object({ data: DetailDto }), ...errors },
      },
    },
    async (req, reply) =>
      idempotent(req, reply, 'booking:create', 201, DetailDto, async () =>
        toDetail(
          await bookings.create(
            {
              listingId: req.body.listingId,
              startAt: req.body.startAt,
              endAt: req.body.endAt,
              note: req.body.note ?? null,
            },
            req.ctx,
          ),
        ),
      ),
  );

  app.get(
    '/api/v1/bookings/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['bookings'],
        summary: 'A booking with its history and my next actions',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: DetailDto }), ...errors },
      },
    },
    async (req) => ok(toDetail(await bookings.get(req.params.id, req.ctx))),
  );

  const command = <B extends z.ZodType>(
    name: PartyCommand,
    summary: string,
    body: B,
    reasonOf: (b: z.output<B>) => string | undefined,
  ) =>
    app.post(
      `/api/v1/bookings/:id/${name}`,
      {
        preHandler: authenticate,
        schema: {
          tags: ['bookings'],
          summary: `${summary} (requires Idempotency-Key)`,
          ...secured,
          params: IdParams,
          body,
          response: { 200: z.object({ data: DetailDto }), ...errors },
        },
      },
      async (req, reply) =>
        idempotent(req, reply, `booking:${name}`, 200, DetailDto, async () =>
          toDetail(
            await bookings.command(
              req.params.id,
              name,
              { reason: reasonOf(req.body as z.output<B>) },
              req.ctx,
            ),
          ),
        ),
    );

  command('confirm', 'Renter: confirm a held instant booking', NoBody, () => undefined);
  command('approve', 'Owner: approve a booking request', NoBody, () => undefined);
  command(
    'decline',
    'Owner: decline a booking request',
    z.strictObject({ reason: Reason }),
    (b) => b.reason,
  );
  command(
    'cancel',
    'Renter: cancel before confirmation (afterwards, cancel the transaction)',
    z.strictObject({ reason: Reason.optional() }).nullish(),
    (b) => b?.reason,
  );

  app.get(
    '/api/v1/me/bookings',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'Bookings where I am the renter or the owner',
        ...secured,
        querystring: MyListQuery,
        response: { 200: ListResponse, ...errors },
      },
    },
    async (req) =>
      listPage(
        await bookings.listMine(req.query.role, listQuery(req.query), req.ctx),
        req.query.limit,
      ),
  );

  app.get(
    '/api/v1/admin/bookings',
    {
      preHandler: requirePermission('transaction:read:any'),
      schema: {
        tags: ['admin'],
        summary: 'All bookings, optionally by status',
        ...secured,
        querystring: ListQuerySchema,
        response: { 200: ListResponse, ...errors },
      },
    },
    async (req) => listPage(await bookings.listAll(listQuery(req.query)), req.query.limit),
  );
};
