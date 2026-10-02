import { Conditions, DistrictSchema, MoneySchema, PageQuerySchema } from '@dorkar/contracts';
import {
  ok,
  paginate,
  type FastifyPluginAsyncZod,
  type IdempotencyTables,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { ItemDetail, LendItemService } from '../../application/lend-item-service';
import type { LendItemPatch } from '../../application/ports';
import type { LendItem } from '../../domain/lend-item';
import {
  errors,
  IdParams,
  idempotentReply,
  iso,
  Money,
  optionalAuth,
  pageOf,
  secured,
  timeCursor,
} from './common';

// ---------------------------------------------------------------- DTOs

const RequirementsDto = z.object({
  nidVerified: z.boolean(),
  minCompletedDeals: z.number().int(),
  minRating: z.number().nullable(),
});

/** What anyone may see. Never contact details: people reach the lender through Dorkar. */
const ItemDto = z.object({
  id: z.uuid(),
  lenderId: z.uuid(),
  categoryId: z.uuid(),
  title: z.string(),
  description: z.string(),
  condition: z.enum(Conditions),
  district: DistrictSchema,
  mediaIds: z.array(z.uuid()),
  deposit: Money.nullable(),
  maxLoanDays: z.number().int(),
  requirements: RequirementsDto,
  active: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
});

/** The owner's view adds moderation state. */
const MyItemDto = ItemDto.extend({ hidden: z.boolean(), version: z.number().int() });

const ItemDetailDto = ItemDto.extend({
  lenderStats: z.object({
    completedLoans: z.number().int(),
    onTimeReturnRate: z.number().min(0).max(1).nullable(),
  }),
  viewerIsOwner: z.boolean(),
  /** Present for the owner only. */
  hidden: z.boolean().optional(),
});

const toItem = (i: LendItem): z.output<typeof ItemDto> => ({
  id: i.id,
  lenderId: i.lenderId,
  categoryId: i.categoryId,
  title: i.title,
  description: i.description,
  condition: i.condition,
  district: i.district,
  mediaIds: i.mediaIds,
  deposit: i.depositAmount === null ? null : { amount: i.depositAmount, currency: 'BDT' },
  maxLoanDays: i.maxLoanDays,
  requirements: { ...i.requirements },
  active: i.active,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
});

const toMine = (i: LendItem): z.output<typeof MyItemDto> => ({
  ...toItem(i),
  hidden: i.hidden,
  version: i.version,
});

const toDetail = (d: ItemDetail): z.output<typeof ItemDetailDto> => ({
  ...toItem(d.item),
  lenderStats: d.lenderStats,
  viewerIsOwner: d.viewerIsOwner,
  ...(d.viewerIsOwner ? { hidden: d.item.hidden } : {}),
});

// ---------------------------------------------------------------- requests

const RequirementsBody = z.strictObject({
  nidVerified: z.boolean().default(false),
  minCompletedDeals: z.number().int().min(0).max(10_000).default(0),
  minRating: z.number().min(1).max(5).nullable().default(null),
});

const Fields = {
  categoryId: z.uuid(),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000),
  condition: z.enum(Conditions),
  district: DistrictSchema,
  mediaIds: z.array(z.uuid()).max(8),
  deposit: MoneySchema.nullable(),
  maxLoanDays: z.number().int().min(1).max(365),
  requirements: RequirementsBody,
};

const CreateBody = z.strictObject({
  ...Fields,
  description: Fields.description.default(''),
  mediaIds: Fields.mediaIds.default([]),
  deposit: Fields.deposit.default(null),
  requirements: RequirementsBody.default({
    nidVerified: false,
    minCompletedDeals: 0,
    minRating: null,
  }),
});

const PatchBody = z
  .strictObject({ ...Fields, active: z.boolean() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const toPatch = (b: z.output<typeof PatchBody>): LendItemPatch => {
  const { deposit, ...rest } = b;
  return {
    ...rest,
    ...(deposit !== undefined ? { depositAmount: deposit === null ? null : deposit.amount } : {}),
  };
};

const SearchQuery = z.strictObject({
  ...PageQuerySchema.shape,
  q: z.string().trim().min(1).max(200).optional(),
  categoryId: z.uuid().optional(),
  district: DistrictSchema.optional(),
});
const MineQuery = z.strictObject({ ...PageQuerySchema.shape });

const itemPage = <T>(rows: LendItem[], limit: number, map: (i: LendItem) => T) => {
  const { items, nextCursor } = paginate(rows, limit, (i) => ({
    k: i.createdAt.toISOString(),
    id: i.id,
  }));
  return { data: items.map(map), page: { nextCursor } };
};

export interface ItemRouteDeps {
  items: LendItemService;
  runtime: ServiceRuntime<never>;
  idempotencyDb: Kysely<IdempotencyTables>;
}

export const itemRoutes: FastifyPluginAsyncZod<ItemRouteDeps> = async (
  app,
  { items, runtime, idempotencyDb },
) => {
  const { authenticate, requirePermission } = runtime.auth;

  app.post(
    '/api/v1/lend-items',
    {
      preHandler: requirePermission('lending:create'),
      schema: {
        tags: ['lending'],
        summary: 'Put an item on my lending shelf (requires Idempotency-Key)',
        ...secured,
        body: CreateBody,
        response: { 201: z.object({ data: MyItemDto }), ...errors },
      },
    },
    async (req, reply) =>
      idempotentReply(
        idempotencyDb,
        req,
        reply,
        { scope: 'lending:item:create', status: 201, schema: MyItemDto },
        async () => {
          const { deposit, ...rest } = req.body;
          return toMine(
            await items.create({ ...rest, depositAmount: deposit?.amount ?? null }, req.ctx),
          );
        },
      ),
  );

  app.patch(
    '/api/v1/lend-items/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['lending'],
        summary: 'Edit my lend item',
        ...secured,
        params: IdParams,
        body: PatchBody,
        response: { 200: z.object({ data: MyItemDto }), ...errors },
      },
    },
    async (req) => ok(toMine(await items.update(req.params.id, toPatch(req.body), req.ctx))),
  );

  app.post(
    '/api/v1/lend-items/:id/deactivate',
    {
      preHandler: authenticate,
      schema: {
        tags: ['lending'],
        summary: 'Take my item off the shelf (requires Idempotency-Key)',
        ...secured,
        params: IdParams,
        body: z.strictObject({}).nullish(),
        response: { 200: z.object({ data: MyItemDto }), ...errors },
      },
    },
    async (req, reply) =>
      idempotentReply(
        idempotencyDb,
        req,
        reply,
        { scope: 'lending:item:deactivate', status: 200, schema: MyItemDto },
        async () => toMine(await items.deactivate(req.params.id, req.ctx)),
      ),
  );

  app.get(
    '/api/v1/lend-items',
    {
      schema: {
        tags: ['lending'],
        summary: 'Browse items neighbours lend (full-text, category, district)',
        querystring: SearchQuery,
        response: { 200: pageOf(ItemDto), ...errors },
      },
    },
    async (req) => {
      const q = req.query;
      const rows = await items.search({
        q: q.q,
        categoryId: q.categoryId,
        district: q.district,
        cursor: timeCursor(q.cursor),
        limit: q.limit,
      });
      return itemPage(rows, q.limit, toItem);
    },
  );

  app.get(
    '/api/v1/lend-items/:id',
    {
      preHandler: optionalAuth(runtime),
      schema: {
        tags: ['lending'],
        summary: 'An item with its requirements and the lender’s lending record',
        params: IdParams,
        response: { 200: z.object({ data: ItemDetailDto }), ...errors },
      },
    },
    async (req) => ok(toDetail(await items.get(req.params.id, req.ctx))),
  );

  app.get(
    '/api/v1/me/lend-items',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'My lending shelf',
        ...secured,
        querystring: MineQuery,
        response: { 200: pageOf(MyItemDto), ...errors },
      },
    },
    async (req) => {
      const rows = await items.mine(
        { cursor: timeCursor(req.query.cursor), limit: req.query.limit },
        req.ctx,
      );
      return itemPage(rows, req.query.limit, toMine);
    },
  );
};
