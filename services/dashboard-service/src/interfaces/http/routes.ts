import { Readable } from 'node:stream';
import { ActorTypes } from '@dorkar/contracts';
import { ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { ActivityService } from '../../application/activity-service';
import type { MetricsService, PersonalDashboardService } from '../../application/metrics-service';
import { STAFF_DISPLAY_NAME, type ActivityEntry, type ActivityFilter } from '../../domain/activity';
import { labelFor } from '../../domain/labels';
import { Metrics } from '../../domain/metrics';

const iso = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});
const queryDate = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .optional();

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
};

const Money = z.object({ amount: z.number().int(), currency: z.literal('BDT') });
const Counts = z.record(z.string(), z.number().int());
const PageInfo = z.object({ nextCursor: z.string().nullable() });

// ---------------------------------------------------------------- activity DTOs

const Target = z.object({ type: z.string().nullable(), id: z.string().nullable() }).nullable();
const target = (e: ActivityEntry) =>
  e.targetType || e.targetId ? { type: e.targetType, id: e.targetId } : null;

const ActivityDto = z.object({
  id: z.uuid(),
  service: z.string(),
  action: z.string(),
  label: z.string(),
  actor: z.object({
    id: z.uuid().nullable(),
    type: z.enum(ActorTypes),
    displayName: z.string().nullable(),
  }),
  target: Target,
  requestId: z.string().nullable(),
  ipHash: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  occurredAt: iso,
});
const toActivity = (e: ActivityEntry): z.output<typeof ActivityDto> => ({
  id: e.id,
  service: e.service,
  action: e.action,
  label: labelFor(e.action),
  actor: { id: e.actorId, type: e.actorType, displayName: e.actorName },
  target: target(e),
  requestId: e.requestId,
  ipHash: e.ipHash,
  metadata: e.metadata,
  occurredAt: e.occurredAt,
});

/** What a member may see: no ip hash, request id, metadata, or staff identity. */
const MyActivityDto = z.object({
  id: z.uuid(),
  service: z.string(),
  action: z.string(),
  label: z.string(),
  target: Target,
  /** null for your own actions; "Dorkar team" for staff actions on your account. */
  actor: z.object({ displayName: z.string() }).nullable(),
  occurredAt: iso,
});

const filterShape = {
  actorId: z.uuid().optional(),
  targetType: z.string().trim().min(1).max(50).optional(),
  targetId: z.string().trim().min(1).max(100).optional(),
  service: z
    .string()
    .regex(/^[a-z]{1,30}$/)
    .optional(),
  /** Prefix, e.g. `transaction.` */
  action: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,100}$/)
    .optional(),
  actorType: z.enum(ActorTypes).optional(),
  from: queryDate,
  to: queryDate,
};
const ActivityQuery = z.strictObject({
  ...filterShape,
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
const ExportQuery = z.strictObject(filterShape);

const toFilter = (q: z.output<typeof ExportQuery>): ActivityFilter => ({
  actorId: q.actorId,
  targetType: q.targetType,
  targetId: q.targetId,
  service: q.service,
  actionPrefix: q.action,
  actorType: q.actorType,
  from: q.from,
  to: q.to,
});

// ---------------------------------------------------------------- metrics DTOs

const Day = z.iso.date();
const ChangeDto = z.object({
  metric: z.enum(Metrics),
  current: z.number(),
  previous: z.number(),
  change: z.number(),
  changePct: z.number().nullable(),
});
const SummaryDto = z.object({
  generatedAt: z.string(),
  today: Day,
  gauges: z.object({
    needsByStatus: Counts,
    activeListings: z.number().int(),
    transactionsByState: z.array(
      z.object({ state: z.string(), count: z.number().int(), amount: Money }),
    ),
    openDisputes: z.number().int(),
    pendingVerifications: z.number().int(),
    liveAuctions: z.number().int(),
    upcomingBookings: z.number().int(),
    activeBookings: z.number().int(),
    activeLoans: z.number().int(),
  }),
  periods: z.array(
    z.object({
      days: z.number().int(),
      from: Day,
      to: Day,
      previousFrom: Day,
      previousTo: Day,
      metrics: z.array(ChangeDto),
    }),
  ),
});

const SeriesDto = z.object({
  metric: z.enum(Metrics),
  dimension: z.string(),
  interval: z.enum(['day', 'week']),
  from: Day,
  to: Day,
  total: z.number(),
  points: z.array(z.object({ start: Day, value: z.number() })),
});

const FunnelDto = z.object({
  from: Day,
  to: Day,
  steps: z.array(
    z.object({
      step: z.enum(['needsPublished', 'needsWithOffer', 'offersAccepted', 'transactionsCompleted']),
      count: z.number().int(),
      conversionPct: z.number().nullable(),
    }),
  ),
});

const PersonalDto = z.object({
  buyer: z.object({
    openNeeds: z.number().int(),
    offersAwaitingResponse: z.number().int(),
    transactionsByState: Counts,
    totalSpent: Money,
  }),
  seller: z.object({
    offersByStatus: Counts,
    transactionsByState: Counts,
    earnings: Money,
    rating: z
      .object({
        average: z.number().nullable(),
        count: z.number().int(),
        completedCount: z.number().int(),
      })
      .nullable(),
  }),
  auctions: z.object({
    owned: z.number().int(),
    bidding: z.number().int(),
    live: z.array(
      z.object({
        auctionId: z.uuid(),
        role: z.enum(['OWNER', 'BIDDER']),
        endsAt: iso.nullable(),
      }),
    ),
  }),
  bookings: z.object({
    asRenter: z.number().int(),
    asOwner: z.number().int(),
    items: z.array(
      z.object({
        bookingId: z.uuid(),
        listingId: z.uuid(),
        role: z.enum(['OWNER', 'RENTER']),
        status: z.string(),
        startAt: iso.nullable(),
        endAt: iso.nullable(),
      }),
    ),
  }),
  loans: z.object({
    asLender: z.number().int(),
    asBorrower: z.number().int(),
    items: z.array(
      z.object({
        loanId: z.uuid(),
        itemId: z.uuid(),
        role: z.enum(['LENDER', 'BORROWER']),
        status: z.string(),
        returnBy: iso.nullable(),
      }),
    ),
  }),
  disputes: z.object({
    open: z.number().int(),
    items: z.array(
      z.object({
        disputeId: z.uuid(),
        transactionId: z.uuid(),
        role: z.enum(['BUYER', 'SELLER']),
        status: z.string(),
      }),
    ),
  }),
});

export interface DashboardRouteDeps {
  activity: ActivityService;
  metrics: MetricsService;
  personal: PersonalDashboardService;
  runtime: ServiceRuntime<never>;
}

export const dashboardRoutes: FastifyPluginAsyncZod<DashboardRouteDeps> = async (
  app,
  { activity, metrics, personal, runtime },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  const auditRead = requirePermission('audit:read');
  const dashboardRead = requirePermission('dashboard:read');
  const noStore = { 'cache-control': 'private, no-store' };

  // ---------------------------------------------------------------- admin: activity log

  app.get(
    '/api/v1/admin/activity',
    {
      preHandler: auditRead,
      schema: {
        tags: ['admin', 'activity'],
        summary: 'Cross-service activity log (newest first, keyset paginated)',
        ...secured,
        querystring: ActivityQuery,
        response: { 200: z.object({ data: z.array(ActivityDto), page: PageInfo }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.headers(noStore);
      const { cursor, limit, ...f } = req.query;
      const page = await activity.list(toFilter(f), cursor, limit);
      return { data: page.items.map(toActivity), page: { nextCursor: page.nextCursor } };
    },
  );

  app.get(
    '/api/v1/admin/activity/facets',
    {
      preHandler: auditRead,
      schema: {
        tags: ['admin', 'activity'],
        summary: 'Services and actions with counts, for filter dropdowns',
        ...secured,
        querystring: z.strictObject({
          days: z.coerce.number().int().min(1).max(365).default(30),
        }),
        response: {
          200: z.object({
            data: z.object({
              since: iso,
              services: z.array(z.object({ service: z.string(), count: z.number().int() })),
              actions: z.array(
                z.object({ action: z.string(), label: z.string(), count: z.number().int() }),
              ),
            }),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const f = await activity.facets(req.query.days);
      return ok({
        since: f.since,
        services: f.services,
        actions: f.actions.map((a) => ({ ...a, label: labelFor(a.action) })),
      });
    },
  );

  app.get(
    '/api/v1/admin/activity/export',
    {
      preHandler: auditRead,
      schema: {
        tags: ['admin', 'activity'],
        summary: 'CSV export of the filtered log (max 10,000 rows; audited)',
        ...secured,
        querystring: ExportQuery,
        response: { 200: z.string().describe('text/csv'), ...errors },
      },
    },
    async (req, reply) => {
      const lines = await activity.export(toFilter(req.query), req.ctx);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      async function* withBom() {
        yield '﻿'; // so spreadsheet apps read Bangla names as UTF-8
        yield* lines;
      }
      return (
        reply
          .headers({
            ...noStore,
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="dorkar-activity-${stamp}.csv"`,
          })
          // Streams bypass the response serializer; the 200 schema documents the CSV body.
          .send(Readable.from(withBom()) as unknown as string)
      );
    },
  );

  app.get(
    '/api/v1/admin/activity/:id',
    {
      preHandler: auditRead,
      schema: {
        tags: ['admin', 'activity'],
        ...secured,
        params: z.strictObject({ id: z.uuid() }),
        response: { 200: z.object({ data: ActivityDto }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.headers(noStore);
      return ok(toActivity(await activity.get(req.params.id)));
    },
  );

  // ---------------------------------------------------------------- admin: metrics

  app.get(
    '/api/v1/admin/dashboard/summary',
    {
      preHandler: dashboardRead,
      schema: {
        tags: ['admin', 'dashboard'],
        summary: 'Gauges and 1/7/30-day totals vs the previous period (cached briefly)',
        ...secured,
        response: { 200: z.object({ data: SummaryDto }), ...errors },
      },
    },
    async (_req, reply) => {
      void reply.headers(noStore);
      return ok(await metrics.summary());
    },
  );

  app.get(
    '/api/v1/admin/dashboard/timeseries',
    {
      preHandler: dashboardRead,
      schema: {
        tags: ['admin', 'dashboard'],
        summary: 'Zero-filled daily or weekly series of one counter (Asia/Dhaka days)',
        ...secured,
        querystring: z.strictObject({
          metric: z.enum(Metrics),
          dimension: z.string().max(80).default(''),
          from: Day.optional(),
          to: Day.optional(),
          interval: z.enum(['day', 'week']).default('day'),
        }),
        response: { 200: z.object({ data: SeriesDto }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.headers(noStore);
      const range = metrics.defaultRange();
      return ok(
        await metrics.timeseries({
          metric: req.query.metric,
          dimension: req.query.dimension,
          from: req.query.from ?? range.from,
          to: req.query.to ?? range.to,
          interval: req.query.interval,
        }),
      );
    },
  );

  app.get(
    '/api/v1/admin/dashboard/funnel',
    {
      preHandler: dashboardRead,
      schema: {
        tags: ['admin', 'dashboard'],
        summary: 'Needs published → got an offer → offers accepted → deals completed',
        ...secured,
        querystring: z.strictObject({ from: Day.optional(), to: Day.optional() }),
        response: { 200: z.object({ data: FunnelDto }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.headers(noStore);
      const range = metrics.defaultRange();
      return ok(await metrics.funnel(req.query.from ?? range.from, req.query.to ?? range.to));
    },
  );

  // ---------------------------------------------------------------- me

  app.get(
    '/api/v1/me/dashboard',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'My dashboard as buyer, seller, renter, lender and bidder',
        ...secured,
        response: { 200: z.object({ data: PersonalDto }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.headers(noStore);
      return ok(await personal.get(req.ctx));
    },
  );

  app.get(
    '/api/v1/me/activity',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'What I did (`mine`) or what Dorkar staff did on my account (`about-me`)',
        ...secured,
        querystring: z.strictObject({
          scope: z.enum(['mine', 'about-me']).default('mine'),
          cursor: z.string().max(300).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        response: { 200: z.object({ data: z.array(MyActivityDto), page: PageInfo }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.headers(noStore);
      const { scope, cursor, limit } = req.query;
      const page = await activity.mine(scope, cursor, limit, req.ctx);
      return {
        data: page.items.map((e): z.output<typeof MyActivityDto> => ({
          id: e.id,
          service: e.service,
          action: e.action,
          label: labelFor(e.action),
          target: target(e),
          actor: scope === 'about-me' ? { displayName: STAFF_DISPLAY_NAME } : null,
          occurredAt: e.occurredAt,
        })),
        page: { nextCursor: page.nextCursor },
      };
    },
  );
};
