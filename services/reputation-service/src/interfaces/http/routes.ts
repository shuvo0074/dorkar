import { decodeCursor, ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { ReputationService } from '../../application/reputation-service';
import { AuthorRoles, ReviewStatuses, type Review } from '../../domain/review';
import type { ReputationSignals } from '../../domain/signals';

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

/** Signals, side by side; deliberately not collapsed into a single score. */
const Summary = z.object({
  ratingAverage: z.number().nullable(),
  ratingCount: z.number().int(),
  completedCount: z.number().int(),
  cancelledCount: z.number().int(),
  disputedCount: z.number().int(),
  distinctCounterparties: z.number().int(),
});

/** Public view: who wrote it and what they said. No transaction id, no amounts. */
const PublicReviewDto = z.object({
  id: z.uuid(),
  authorId: z.uuid(),
  authorRole: z.enum(AuthorRoles),
  rating: z.number().int(),
  comment: z.string().nullable(),
  createdAt: iso,
});

/** Party / moderator view. */
const ReviewDto = PublicReviewDto.extend({
  transactionId: z.uuid(),
  subjectId: z.uuid(),
  status: z.enum(ReviewStatuses),
});

const toPublic = (r: Review): z.output<typeof PublicReviewDto> => ({
  id: r.id,
  authorId: r.authorId,
  authorRole: r.authorRole,
  rating: r.rating,
  comment: r.comment,
  createdAt: r.createdAt,
});

const toDto = (r: Review): z.output<typeof ReviewDto> => ({
  ...toPublic(r),
  transactionId: r.transactionId,
  subjectId: r.subjectId,
  status: r.status,
});

const toSummary = (s: ReputationSignals): z.output<typeof Summary> => ({
  ratingAverage: s.ratingAverage,
  ratingCount: s.ratingCount,
  completedCount: s.completedCount,
  cancelledCount: s.cancelledCount,
  disputedCount: s.disputedCount,
  distinctCounterparties: s.distinctCounterparties,
});

const CreateBody = z.strictObject({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).nullable().optional(),
});

const Page = z.object({ nextCursor: z.string().nullable() });
const limit = z.coerce.number().int().min(1).max(50).default(20);
const cursor = z.string().max(200).optional();

export interface ReputationRouteDeps {
  reputation: ReputationService;
  runtime: ServiceRuntime<never>;
}

export const reputationRoutes: FastifyPluginAsyncZod<ReputationRouteDeps> = async (
  app,
  { reputation, runtime },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  const txParams = z.strictObject({ transactionId: z.uuid() });

  app.post(
    '/api/v1/transactions/:transactionId/reviews',
    {
      preHandler: authenticate,
      schema: {
        tags: ['reviews'],
        summary: 'Review the other party of a completed transaction',
        ...secured,
        params: txParams,
        body: CreateBody,
        response: { 201: z.object({ data: ReviewDto }), ...errors },
      },
    },
    async (req, reply) => {
      const review = await reputation.createReview(req.params.transactionId, req.body, req.ctx);
      return reply.code(201).send(ok(toDto(review)));
    },
  );

  app.get(
    '/api/v1/transactions/:transactionId/reviews',
    {
      preHandler: authenticate,
      schema: {
        tags: ['reviews'],
        summary: 'Reviews of one transaction (parties only)',
        ...secured,
        params: txParams,
        response: { 200: z.object({ data: z.array(ReviewDto) }), ...errors },
      },
    },
    async (req) =>
      ok((await reputation.transactionReviews(req.params.transactionId, req.ctx)).map(toDto)),
  );

  app.get(
    '/api/v1/users/:userId/reviews',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Public reviews about a user, newest first, with reputation signals',
        params: z.strictObject({ userId: z.uuid() }),
        querystring: z.strictObject({ cursor, limit }),
        response: {
          200: z.object({ data: z.array(PublicReviewDto), page: Page, summary: Summary }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const page = await reputation.publicReviews(req.params.userId, {
        cursor: decodeCursor(req.query.cursor),
        limit: req.query.limit,
      });
      void reply.header('cache-control', 'public, max-age=60');
      return {
        data: page.items.map(toPublic),
        page: { nextCursor: page.nextCursor },
        summary: toSummary(page.summary),
      };
    },
  );

  app.get(
    '/api/v1/admin/reviews',
    {
      preHandler: requirePermission('moderation:case:read'),
      schema: {
        tags: ['admin'],
        summary: 'All reviews, for moderation',
        ...secured,
        querystring: z.strictObject({ status: z.enum(ReviewStatuses).optional(), cursor, limit }),
        response: { 200: z.object({ data: z.array(ReviewDto), page: Page }), ...errors },
      },
    },
    async (req) => {
      const page = await reputation.adminReviews({
        status: req.query.status ?? null,
        cursor: decodeCursor(req.query.cursor),
        limit: req.query.limit,
      });
      return { data: page.items.map(toDto), page: { nextCursor: page.nextCursor } };
    },
  );
};
