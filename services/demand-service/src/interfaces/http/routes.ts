import {
  Conditions,
  Districts,
  DistrictSchema,
  Divisions,
  NeedModes,
  NeedStatuses,
  type Division,
} from '@dorkar/contracts';
import {
  decodeCursor,
  ok,
  paginate,
  type FastifyPluginAsyncZod,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { NeedInput, NeedPatch, NeedService, NeedView } from '../../application/need-service';
import { DeliveryPreferences, Visibilities, type Need } from '../../domain/need';

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

const divisionKeys = Object.keys(Divisions) as [Division, ...Division[]];

// ---------------------------------------------------------------- DTOs

const Money = z.object({ amount: z.number().int(), currency: z.literal('BDT') });

const HistoryDto = z.object({
  from: z.enum(NeedStatuses).nullable(),
  to: z.enum(NeedStatuses),
  reason: z.string(),
  at: iso,
});

/** Public view. Owner-only fields are optional and only set by `toOwner`. */
const NeedDto = z.object({
  id: z.uuid(),
  requesterId: z.uuid(),
  mode: z.enum(NeedModes),
  categoryId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  quantity: z.number().int(),
  acceptedQuantity: z.number().int(),
  budget: z.object({ min: Money.nullable(), max: Money.nullable(), flexible: z.boolean() }),
  condition: z.array(z.enum(Conditions)),
  attributes: z.record(z.string(), z.unknown()),
  modeTerms: z.record(z.string(), z.unknown()),
  location: z.object({
    division: z.enum(divisionKeys),
    district: DistrictSchema,
    area: z.string().nullable(),
  }),
  deliveryPreference: z.enum(DeliveryPreferences),
  requiredBy: z.iso.date().nullable(),
  status: z.enum(NeedStatuses),
  offerCount: z.number().int(),
  maxOffers: z.number().int(),
  expiresAt: iso.nullable(),
  publishedAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
  // owner only
  visibility: z.enum(Visibilities).optional(),
  renewals: z.number().int().optional(),
  version: z.number().int().optional(),
  history: z.array(HistoryDto).optional(),
});
type NeedDtoOut = z.output<typeof NeedDto>;

const money = (amount: number | null) =>
  amount === null ? null : { amount, currency: 'BDT' as const };

const toPublic = (n: Need): NeedDtoOut => ({
  id: n.id,
  requesterId: n.requesterId,
  mode: n.mode,
  categoryId: n.categoryId,
  title: n.title,
  description: n.description,
  quantity: n.quantity,
  acceptedQuantity: n.acceptedQuantity,
  budget: { min: money(n.budgetMin), max: money(n.budgetMax), flexible: n.budgetFlexible },
  condition: n.conditions,
  attributes: n.attributes,
  modeTerms: n.modeTerms,
  location: { division: Districts[n.district].division, district: n.district, area: n.area },
  deliveryPreference: n.deliveryPref,
  requiredBy: n.requiredBy,
  status: n.status,
  offerCount: n.offerCount,
  maxOffers: n.maxOffers,
  expiresAt: n.expiresAt,
  publishedAt: n.publishedAt,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
});

const toOwner = (n: Need, history: NeedView['history']): NeedDtoOut => ({
  ...toPublic(n),
  visibility: n.visibility,
  renewals: n.renewals,
  version: n.version,
  ...(history
    ? {
        history: history.map((h) => ({
          from: h.from,
          to: h.to,
          // Moderator notes stay internal; the owner sees that moderation happened.
          reason: h.reason.startsWith('MODERATION') ? 'MODERATION' : h.reason,
          at: h.at,
        })),
      }
    : {}),
});

const toDto = (v: NeedView): NeedDtoOut =>
  v.isOwner ? toOwner(v.need, v.history) : toPublic(v.need);

// ---------------------------------------------------------------- requests

const MoneyIn = z.strictObject({
  amount: z.number().int().min(0).max(100_000_000_000),
  currency: z.literal('BDT'),
});
const BudgetIn = z.strictObject({
  min: MoneyIn.nullable().optional(),
  max: MoneyIn.nullable().optional(),
  flexible: z.boolean().optional(),
});
/** Division is derived from the district, never trusted; accepted for client convenience. */
const LocationIn = z.strictObject({
  division: z.enum(divisionKeys).optional(),
  district: DistrictSchema,
  area: z.string().trim().min(1).max(80).optional(),
});

const fields = {
  mode: z.enum(NeedModes),
  categoryId: z.uuid(),
  title: z.string().trim().min(5).max(120),
  description: z.string().trim().max(2000),
  quantity: z.number().int().min(1).max(1_000_000),
  budget: BudgetIn,
  condition: z.array(z.enum(Conditions)).max(Conditions.length),
  attributes: z.record(z.string(), z.unknown()),
  modeTerms: z.record(z.string(), z.unknown()),
  location: LocationIn,
  deliveryPreference: z.enum(DeliveryPreferences),
  requiredBy: z.iso.date(),
  visibility: z.enum(Visibilities),
};

const CreateBody = z.strictObject({
  ...fields,
  description: fields.description.optional(),
  quantity: fields.quantity.default(1),
  budget: fields.budget.optional(),
  condition: fields.condition.optional(),
  attributes: fields.attributes.optional(),
  modeTerms: fields.modeTerms.optional(),
  deliveryPreference: fields.deliveryPreference.optional(),
  requiredBy: fields.requiredBy.optional(),
  visibility: fields.visibility.optional(),
  /** Ask for a shorter life than the default. */
  expiresInDays: z.number().int().min(1).max(365).optional(),
  publish: z.boolean().default(false),
});

const PatchBody = z
  .strictObject({
    ...fields,
    description: fields.description.nullable(),
    budget: fields.budget.nullable(),
    requiredBy: fields.requiredBy.nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const budgetOf = (b: z.output<typeof BudgetIn> | null | undefined) =>
  b === null || b === undefined
    ? b
    : { min: b.min?.amount ?? null, max: b.max?.amount ?? null, flexible: b.flexible ?? false };

const toInput = (b: z.output<typeof CreateBody>): NeedInput & { publish: boolean } => ({
  mode: b.mode,
  categoryId: b.categoryId,
  title: b.title,
  description: b.description ?? null,
  quantity: b.quantity,
  budget: budgetOf(b.budget),
  conditions: b.condition,
  attributes: b.attributes,
  modeTerms: b.modeTerms,
  district: b.location.district,
  area: b.location.area ?? null,
  deliveryPref: b.deliveryPreference,
  requiredBy: b.requiredBy ?? null,
  expiresInDays: b.expiresInDays,
  visibility: b.visibility,
  publish: b.publish,
});

const toPatch = (b: z.output<typeof PatchBody>): NeedPatch => ({
  ...(b.mode !== undefined ? { mode: b.mode } : {}),
  ...(b.categoryId !== undefined ? { categoryId: b.categoryId } : {}),
  ...(b.title !== undefined ? { title: b.title } : {}),
  ...(b.description !== undefined ? { description: b.description } : {}),
  ...(b.quantity !== undefined ? { quantity: b.quantity } : {}),
  ...(b.budget !== undefined ? { budget: budgetOf(b.budget) } : {}),
  ...(b.condition !== undefined ? { conditions: b.condition } : {}),
  ...(b.attributes !== undefined ? { attributes: b.attributes } : {}),
  ...(b.modeTerms !== undefined ? { modeTerms: b.modeTerms } : {}),
  ...(b.location !== undefined
    ? { district: b.location.district, area: b.location.area ?? null }
    : {}),
  ...(b.deliveryPreference !== undefined ? { deliveryPref: b.deliveryPreference } : {}),
  ...(b.requiredBy !== undefined ? { requiredBy: b.requiredBy } : {}),
  ...(b.visibility !== undefined ? { visibility: b.visibility } : {}),
});

const IdParams = z.strictObject({ id: z.uuid() });
const PageQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
};
const FeedQuery = z.strictObject({
  q: z.string().trim().min(1).max(100).optional(),
  categoryId: z.uuid().optional(),
  mode: z.enum(NeedModes).optional(),
  district: DistrictSchema.optional(),
  /** Sellers looking for needs whose budget reaches at least this (poisha). */
  budgetMaxAtLeast: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
  ...PageQuery,
});
const MineQuery = z.strictObject({ status: z.enum(NeedStatuses).optional(), ...PageQuery });
const ModerationBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

const NeedFactsDto = z.object({
  id: z.uuid(),
  status: z.enum(NeedStatuses),
  requesterId: z.uuid(),
  mode: z.enum(NeedModes),
  categoryId: z.uuid(),
  visibility: z.enum(Visibilities),
  quantity: z.number().int(),
  acceptedQuantity: z.number().int(),
  maxOffers: z.number().int(),
  offerCount: z.number().int(),
  expiresAt: iso.nullable(),
  budget: z.object({ min: Money.nullable(), max: Money.nullable(), flexible: z.boolean() }),
});

const Page = z.object({
  data: z.array(NeedDto),
  page: z.object({ nextCursor: z.string().nullable() }),
});
const One = z.object({ data: NeedDto });

export interface NeedRouteDeps {
  needs: NeedService;
  runtime: ServiceRuntime<never>;
}

export const needRoutes: FastifyPluginAsyncZod<NeedRouteDeps> = async (app, { needs, runtime }) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  /** Anonymous allowed; a bearer token, if sent, must be valid. */
  const optionalAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization) await authenticate(req, reply);
  };

  app.post(
    '/api/v1/needs',
    {
      preHandler: requirePermission('need:create'),
      schema: {
        tags: ['needs'],
        summary: 'Post a need (draft, or publish immediately with `publish: true`)',
        ...secured,
        body: CreateBody,
        response: { 201: One, ...errors },
      },
    },
    async (req, reply) => {
      const v = await needs.create(toInput(req.body), req.ctx);
      void reply.status(201);
      return ok(toDto(v));
    },
  );

  app.get(
    '/api/v1/needs',
    {
      schema: {
        tags: ['needs'],
        summary: 'Open needs feed, newest first',
        querystring: FeedQuery,
        response: { 200: Page, ...errors },
      },
    },
    async (req) => {
      const { limit, cursor, ...filter } = req.query;
      const rows = await needs.feed(filter, decodeCursor(cursor), limit);
      const { items, nextCursor } = paginate(rows, limit, (n) => ({
        k: n.publishedAt!.toISOString(),
        id: n.id,
      }));
      return { data: items.map(toPublic), page: { nextCursor } };
    },
  );

  app.get(
    '/api/v1/needs/:id',
    {
      preHandler: optionalAuth,
      schema: {
        tags: ['needs'],
        summary: 'A need (the requester also sees private fields)',
        params: IdParams,
        response: { 200: One, ...errors },
      },
    },
    async (req) => ok(toDto(await needs.get(req.params.id, req.ctx))),
  );

  app.patch(
    '/api/v1/needs/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['needs'],
        summary: 'Edit my need (material-edit rules apply once offers exist)',
        ...secured,
        params: IdParams,
        body: PatchBody,
        response: { 200: One, ...errors },
      },
    },
    async (req) => ok(toDto(await needs.update(req.params.id, toPatch(req.body), req.ctx))),
  );

  const commands = {
    publish: (id: string, req: FastifyRequest) => needs.publish(id, req.ctx),
    pause: (id: string, req: FastifyRequest) => needs.pause(id, req.ctx),
    resume: (id: string, req: FastifyRequest) => needs.resume(id, req.ctx),
    close: (id: string, req: FastifyRequest) => needs.close(id, req.ctx),
    renew: (id: string, req: FastifyRequest) => needs.renew(id, req.ctx),
  } as const;
  for (const [name, run] of Object.entries(commands)) {
    app.post(
      `/api/v1/needs/:id/${name}`,
      {
        preHandler: authenticate,
        schema: {
          tags: ['needs'],
          summary: `${name[0]!.toUpperCase()}${name.slice(1)} my need`,
          ...secured,
          params: IdParams,
          response: { 200: One, ...errors },
        },
      },
      async (req) => ok(toDto(await run(req.params.id, req))),
    );
  }

  app.get(
    '/api/v1/me/needs',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'My needs, newest first',
        ...secured,
        querystring: MineQuery,
        response: { 200: Page, ...errors },
      },
    },
    async (req) => {
      const { status, limit, cursor } = req.query;
      const rows = await needs.mine(status, decodeCursor(cursor), limit, req.ctx);
      const { items, nextCursor } = paginate(rows, limit, (n) => ({ k: n.id, id: n.id }));
      return { data: items.map((n) => toOwner(n, null)), page: { nextCursor } };
    },
  );

  for (const action of ['hide', 'restore'] as const) {
    app.post(
      `/api/v1/admin/needs/:id/${action}`,
      {
        preHandler: requirePermission(
          action === 'hide' ? 'moderation:content:hide' : 'moderation:content:restore',
        ),
        schema: {
          tags: ['admin'],
          summary: `${action === 'hide' ? 'Hide' : 'Restore'} a need (moderation, audited)`,
          ...secured,
          params: IdParams,
          body: ModerationBody,
          response: {
            200: z.object({ data: z.object({ id: z.uuid(), status: z.enum(NeedStatuses) }) }),
            ...errors,
          },
        },
      },
      async (req) => {
        const n = await needs.moderate(req.params.id, action, req.body.reason, req.ctx);
        return ok({ id: n.id, status: n.status });
      },
    );
  }

  // offer-service validates submissions against these facts.
  app.get(
    '/internal/v1/needs/:id',
    {
      preHandler: runtime.internalOnly,
      schema: {
        hide: true,
        params: IdParams,
        response: { 200: z.object({ data: NeedFactsDto }), ...errors },
      },
    },
    async (req) => {
      const n = await needs.internalFacts(req.params.id);
      return ok({
        id: n.id,
        status: n.status,
        requesterId: n.requesterId,
        mode: n.mode,
        categoryId: n.categoryId,
        visibility: n.visibility,
        quantity: n.quantity,
        acceptedQuantity: n.acceptedQuantity,
        maxOffers: n.maxOffers,
        offerCount: n.offerCount,
        expiresAt: n.expiresAt,
        budget: { min: money(n.budgetMin), max: money(n.budgetMax), flexible: n.budgetFlexible },
      });
    },
  );
};
