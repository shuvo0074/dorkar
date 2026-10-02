import { createHash } from 'node:crypto';
import { AttributeSchemaSchema, NeedModes } from '@dorkar/contracts';
import { ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { CategoryService } from '../../application/category-service';
import type { Category, CategoryNode } from '../../domain/category';
import { errors, iso, secured } from './common';

const CategoryNodeDto = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameEn: z.string(),
  nameBn: z.string(),
  modes: z.array(z.enum(NeedModes)),
  sort: z.number().int(),
  get children(): z.ZodArray<typeof CategoryNodeDto> {
    return z.array(CategoryNodeDto);
  },
});

/** What a client needs to render the need/listing form for one category. */
const CategoryDto = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  slug: z.string(),
  nameEn: z.string(),
  nameBn: z.string(),
  modes: z.array(z.enum(NeedModes)),
  attributeSchema: AttributeSchemaSchema,
  sort: z.number().int(),
});

const AdminCategoryDto = CategoryDto.extend({
  active: z.boolean(),
  version: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});

const toDto = (c: Category): z.output<typeof CategoryDto> => ({
  id: c.id,
  parentId: c.parentId,
  slug: c.slug,
  nameEn: c.nameEn,
  nameBn: c.nameBn,
  modes: c.modes,
  attributeSchema: c.attributeSchema,
  sort: c.sort,
});
const toAdminDto = (c: Category): z.output<typeof AdminCategoryDto> => ({
  ...toDto(c),
  active: c.active,
  version: c.version,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

const toNodeDto = (n: CategoryNode): z.output<typeof CategoryNodeDto> => ({
  id: n.id,
  slug: n.slug,
  nameEn: n.nameEn,
  nameBn: n.nameBn,
  modes: n.modes,
  sort: n.sort,
  children: n.children.map(toNodeDto),
});

const fields = {
  parentId: z.uuid().nullable(),
  slug: z
    .string()
    .max(60)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase words separated by dashes'),
  nameEn: z.string().trim().min(1).max(80),
  nameBn: z.string().trim().min(1).max(80),
  modes: z.array(z.enum(NeedModes)).min(1).max(NeedModes.length),
  attributeSchema: AttributeSchemaSchema,
  sort: z.number().int().min(0).max(100_000),
  active: z.boolean(),
};

const CreateBody = z.strictObject({
  ...fields,
  parentId: fields.parentId.default(null),
  attributeSchema: fields.attributeSchema.default({ properties: {}, required: [] }),
  sort: fields.sort.default(0),
  active: fields.active.default(true),
});

const PatchBody = z
  .strictObject(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const PUBLIC_CACHE = 'public, max-age=300';

export interface CategoryRouteDeps {
  categories: CategoryService;
  runtime: ServiceRuntime<never>;
}

export const categoryRoutes: FastifyPluginAsyncZod<CategoryRouteDeps> = async (
  app,
  { categories, runtime },
) => {
  const manage = runtime.auth.requirePermission('category:manage');

  app.get(
    '/api/v1/categories',
    {
      schema: {
        tags: ['categories'],
        summary: 'Active category tree (cached, ETag)',
        response: { 200: z.object({ data: z.array(CategoryNodeDto) }), ...errors },
      },
    },
    async (req, reply) => {
      const body = ok((await categories.tree()).map(toNodeDto));
      const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 27)}"`;
      void reply.header('cache-control', PUBLIC_CACHE).header('etag', etag);
      const inm = req.headers['if-none-match'];
      if (inm && inm.split(',').some((t) => t.trim() === etag || t.trim() === '*')) {
        return reply.code(304).send(undefined as never); // no body on 304
      }
      return body;
    },
  );

  app.get(
    '/api/v1/categories/:id',
    {
      schema: {
        tags: ['categories'],
        summary: 'One category with its attribute schema (for form rendering)',
        params: z.strictObject({ id: z.uuid() }),
        response: { 200: z.object({ data: CategoryDto }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.header('cache-control', PUBLIC_CACHE);
      return ok(toDto(await categories.getActive(req.params.id)));
    },
  );

  app.post(
    '/api/v1/admin/categories',
    {
      preHandler: manage,
      schema: {
        tags: ['admin'],
        ...secured,
        body: CreateBody,
        response: { 201: z.object({ data: AdminCategoryDto }), ...errors },
      },
    },
    async (req, reply) => {
      const c = await categories.create(req.body, req.ctx);
      return reply.code(201).send(ok(toAdminDto(c)));
    },
  );

  app.patch(
    '/api/v1/admin/categories/:id',
    {
      preHandler: manage,
      schema: {
        tags: ['admin'],
        ...secured,
        params: z.strictObject({ id: z.uuid() }),
        body: PatchBody,
        response: { 200: z.object({ data: AdminCategoryDto }), ...errors },
      },
    },
    async (req) => ok(toAdminDto(await categories.update(req.params.id, req.body, req.ctx))),
  );
};
