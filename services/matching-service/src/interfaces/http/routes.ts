import { DistrictSchema, MoneySchema, NeedModes, PageQuerySchema } from '@dorkar/contracts';
import { type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { MatchingService } from '../../application/matching-service';
import type { MatchedNeed, MatchRecord } from '../../application/ports';
import { MatchStatuses } from '../../domain/matching';

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
};

const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: z.object({ nextCursor: z.string().nullable() }) });

const PageQuery = z.strictObject(PageQuerySchema.shape);

/** Per-factor points; they add up to `score`. */
const Reasons = z.record(z.string(), z.number());

const MatchDto = z.object({
  matchId: z.uuid(),
  candidateType: z.enum(['LISTING', 'SELLER']),
  sellerId: z.uuid(),
  listingId: z.uuid().nullable(),
  score: z.number(),
  reasons: Reasons,
  status: z.enum(MatchStatuses),
});

const money = (amount: number | null) =>
  amount === null ? null : { amount, currency: 'BDT' as const };

const MatchedNeedDto = z.object({
  matchId: z.uuid(),
  status: z.enum(['NEW', 'RESPONDED']),
  score: z.number(),
  reasons: Reasons,
  listingId: z.uuid().nullable(),
  matchedAt: iso,
  need: z.object({
    id: z.uuid(),
    title: z.string(),
    mode: z.enum(NeedModes),
    categoryId: z.uuid(),
    quantity: z.number().int(),
    district: DistrictSchema,
    budget: z.object({ min: MoneySchema.nullable(), max: MoneySchema.nullable() }),
    expiresAt: iso,
  }),
});

const toMatchDto = (m: MatchRecord): z.output<typeof MatchDto> => ({
  matchId: m.id,
  candidateType: m.candidateType,
  sellerId: m.sellerId,
  listingId: m.listingId,
  score: m.score,
  reasons: m.reasons,
  status: m.status,
});

const toMatchedNeedDto = ({ match, need }: MatchedNeed): z.output<typeof MatchedNeedDto> => ({
  matchId: match.id,
  status: match.status === 'RESPONDED' ? 'RESPONDED' : 'NEW',
  score: match.score,
  reasons: match.reasons,
  listingId: match.listingId,
  matchedAt: match.createdAt,
  need: {
    id: need.needId,
    title: need.title,
    mode: need.mode,
    categoryId: need.categoryId,
    quantity: need.quantity,
    district: need.district,
    budget: { min: money(need.budgetMin), max: money(need.budgetMax) },
    expiresAt: need.expiresAt,
  },
});

export interface MatchingRouteDeps {
  matching: MatchingService;
  runtime: ServiceRuntime<never>;
}

export const matchingRoutes: FastifyPluginAsyncZod<MatchingRouteDeps> = async (
  app,
  { matching, runtime },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };

  app.get(
    '/api/v1/needs/:needId/matches',
    {
      preHandler: [authenticate, requirePermission('need:create')],
      schema: {
        tags: ['matches'],
        summary: 'Ranked candidates for my need, with the reasons behind each score',
        ...secured,
        params: z.strictObject({ needId: z.uuid() }),
        querystring: PageQuery,
        response: { 200: page(MatchDto), ...errors },
      },
    },
    async (req) => {
      const p = await matching.listForNeed(req.params.needId, req.query, req.ctx);
      return { data: p.items.map(toMatchDto), page: { nextCursor: p.nextCursor } };
    },
  );

  app.get(
    '/api/v1/me/matched-needs',
    {
      preHandler: [authenticate, requirePermission('offer:create')],
      schema: {
        tags: ['matches'],
        summary: 'Open needs matched to me as a seller, newest first',
        ...secured,
        querystring: PageQuery,
        response: { 200: page(MatchedNeedDto), ...errors },
      },
    },
    async (req) => {
      const p = await matching.listMine(req.query, req.ctx);
      return { data: p.items.map(toMatchedNeedDto), page: { nextCursor: p.nextCursor } };
    },
  );

  app.post(
    '/api/v1/me/matched-needs/:matchId/dismiss',
    {
      preHandler: [authenticate, requirePermission('offer:create')],
      schema: {
        tags: ['matches'],
        summary: 'Hide a matched need from my feed',
        ...secured,
        params: z.strictObject({ matchId: z.uuid() }),
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      await matching.dismiss(req.params.matchId, req.ctx);
      return reply.code(204).send(null);
    },
  );
};
