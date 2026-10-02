import {
  Conditions,
  DeliveryModes,
  DistrictSchema,
  MoneySchema,
  PageQuerySchema,
} from '@dorkar/contracts';
import { decodeCursor, ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { ListingService } from '../../application/listing-service';
import {
  ListingKinds,
  ListingStatuses,
  PriceUnits,
  type Listing,
  type OwnerAction,
} from '../../domain/listing';
import { errors, iso, optionalAuth, pageOf, secured } from './common';

/**
 * Public listing view. Never carries moderation internals (hidden reason, pre-hide state) and
 * exposes the seller only by id.
 */
const ListingDto = z.object({
  id: z.uuid(),
  sellerId: z.uuid(),
  categoryId: z.uuid(),
  kind: z.enum(ListingKinds),
  condition: z.enum(Conditions).nullable(),
  title: z.string(),
  description: z.string(),
  price: MoneySchema,
  priceUnit: z.enum(PriceUnits),
  quantityAvailable: z.number().int(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  district: DistrictSchema,
  area: z.string().nullable(),
  deliveryModes: z.array(z.enum(DeliveryModes)),
  mediaIds: z.array(z.uuid()),
  status: z.enum(ListingStatuses),
  publishedAt: iso.nullable(),
  createdAt: iso,
  updatedAt: iso,
});

const toDto = (l: Listing): z.output<typeof ListingDto> => ({
  id: l.id,
  sellerId: l.sellerId,
  categoryId: l.categoryId,
  kind: l.kind,
  condition: l.condition,
  title: l.title,
  description: l.description,
  price: l.price,
  priceUnit: l.priceUnit,
  quantityAvailable: l.quantityAvailable,
  attributes: l.attributes,
  district: l.district,
  area: l.area,
  deliveryModes: l.deliveryModes,
  mediaIds: l.mediaIds,
  status: l.status,
  publishedAt: l.publishedAt,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});

const fields = {
  categoryId: z.uuid(),
  kind: z.enum(ListingKinds),
  condition: z.enum(Conditions).nullable(),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(4000),
  price: MoneySchema,
  priceUnit: z.enum(PriceUnits),
  quantityAvailable: z.number().int().min(0).max(1_000_000),
  attributes: z.record(z.string(), z.unknown()),
  district: DistrictSchema,
  area: z.string().trim().min(1).max(80).nullable(),
  deliveryModes: z.array(z.enum(DeliveryModes)).max(DeliveryModes.length),
  mediaIds: z.array(z.uuid()).max(10),
};

const CreateBody = z.strictObject({
  ...fields,
  condition: fields.condition.default(null),
  description: fields.description.default(''),
  priceUnit: fields.priceUnit.default('TOTAL'),
  quantityAvailable: fields.quantityAvailable.default(1),
  attributes: fields.attributes.default({}),
  area: fields.area.default(null),
  deliveryModes: fields.deliveryModes.default([]),
  mediaIds: fields.mediaIds.default([]),
});

const PatchBody = z
  .strictObject(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const money = z.coerce.number().int().min(0).max(100_000_000_000);

const SearchQuery = z
  .strictObject({
    q: z.string().trim().min(1).max(100).optional(),
    categoryId: z.uuid().optional(),
    district: DistrictSchema.optional(),
    kind: z.enum(ListingKinds).optional(),
    condition: z.enum(Conditions).optional(),
    /** Poisha, like every amount in the API. */
    minPrice: money.optional(),
    maxPrice: money.optional(),
    sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
    ...PageQuerySchema.shape,
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice must not exceed maxPrice',
    path: ['minPrice'],
  });

const MineQuery = z.strictObject({
  status: z.enum(ListingStatuses).optional(),
  ...PageQuerySchema.shape,
});

const IdParams = z.strictObject({ id: z.uuid() });
const ReasonBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

const OWNER_ACTIONS: ReadonlyArray<[path: string, action: OwnerAction]> = [
  ['publish', 'publish'],
  ['pause', 'pause'],
  ['resume', 'resume'],
  ['mark-sold-out', 'markSoldOut'],
  ['withdraw', 'withdraw'],
];

export interface ListingRouteDeps {
  listings: ListingService;
  runtime: ServiceRuntime<never>;
}

export const listingRoutes: FastifyPluginAsyncZod<ListingRouteDeps> = async (
  app,
  { listings, runtime },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const one = { 200: z.object({ data: ListingDto }), ...errors };

  app.post(
    '/api/v1/listings',
    {
      preHandler: requirePermission('listing:create'),
      schema: {
        tags: ['listings'],
        summary: 'Create a draft listing',
        ...secured,
        body: CreateBody,
        response: { 201: z.object({ data: ListingDto }), ...errors },
      },
    },
    async (req, reply) => reply.code(201).send(ok(toDto(await listings.create(req.body, req.ctx)))),
  );

  app.patch(
    '/api/v1/listings/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['listings'],
        summary: 'Edit my listing (draft, published or paused)',
        ...secured,
        params: IdParams,
        body: PatchBody,
        response: one,
      },
    },
    async (req) => ok(toDto(await listings.update(req.params.id, req.body, req.ctx))),
  );

  for (const [path, action] of OWNER_ACTIONS) {
    app.post(
      `/api/v1/listings/:id/${path}`,
      {
        preHandler: authenticate,
        schema: { tags: ['listings'], ...secured, params: IdParams, response: one },
      },
      async (req) => ok(toDto(await listings.ownerAction(req.params.id, action, req.ctx))),
    );
  }

  app.get(
    '/api/v1/listings',
    {
      schema: {
        tags: ['listings'],
        summary: 'Search published listings',
        querystring: SearchQuery,
        response: { 200: pageOf(ListingDto), ...errors },
      },
    },
    async (req) => {
      const { cursor, ...q } = req.query;
      const page = await listings.search({ ...q, cursor: decodeCursor(cursor) });
      return { data: page.items.map(toDto), page: { nextCursor: page.nextCursor } };
    },
  );

  app.get(
    '/api/v1/listings/:id',
    {
      preHandler: optionalAuth(runtime),
      schema: {
        tags: ['listings'],
        summary: 'A published listing (or my own in any state)',
        params: IdParams,
        response: one,
      },
    },
    async (req) => ok(toDto(await listings.get(req.params.id, req.ctx.actor?.id ?? null))),
  );

  app.get(
    '/api/v1/me/listings',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        ...secured,
        querystring: MineQuery,
        response: { 200: pageOf(ListingDto), ...errors },
      },
    },
    async (req) => {
      const { cursor, ...q } = req.query;
      const page = await listings.listMine({ ...q, cursor: decodeCursor(cursor) }, req.ctx);
      return { data: page.items.map(toDto), page: { nextCursor: page.nextCursor } };
    },
  );

  app.post(
    '/api/v1/admin/listings/:id/hide',
    {
      preHandler: requirePermission('moderation:content:hide'),
      schema: { tags: ['admin'], ...secured, params: IdParams, body: ReasonBody, response: one },
    },
    async (req) =>
      ok(toDto(await listings.moderate(req.params.id, 'hide', req.body.reason, req.ctx))),
  );

  app.post(
    '/api/v1/admin/listings/:id/restore',
    {
      preHandler: requirePermission('moderation:content:restore'),
      schema: { tags: ['admin'], ...secured, params: IdParams, body: ReasonBody, response: one },
    },
    async (req) =>
      ok(toDto(await listings.moderate(req.params.id, 'restore', req.body.reason, req.ctx))),
  );
};
