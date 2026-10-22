import { randomUUID } from 'node:crypto';
import { CatalogEvents, EventEnvelopeSchema } from '@dorkar/contracts';
import { startTestService, type TestService } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { SEED_CATEGORIES } from '../../migrations/0002_seed_categories';
import { buildCatalogService } from '../../src/app';

let t: TestService<Awaited<ReturnType<typeof buildCatalogService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

const seedId = (slug: string) => SEED_CATEGORIES.find((c) => c.slug === slug)!.id;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'catalog',
    migrations,
    build: (env, logger, verifier) =>
      buildCatalogService(env, logger, {
        verifier,
        verification: { evaluate: async () => ({ satisfied: true, missing: [] }) },
      }),
  });
});
afterAll(() => t.close());

const admin = () => t.auth.as(randomUUID(), ['ADMIN']);
const slug = () => `test-${randomUUID().slice(0, 8)}`;
const createCategory = async (body: Record<string, unknown>) =>
  app().inject({
    method: 'POST',
    url: '/api/v1/admin/categories',
    headers: await admin(),
    payload: { slug: slug(), nameEn: 'Test', nameBn: 'পরীক্ষা', modes: ['BUY'], ...body },
  });

describe('seeded category tree', () => {
  it('serves the active tree, nested, cacheable with an ETag', async () => {
    const res = await app().inject({ url: '/api/v1/categories' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const etag = res.headers['etag'] as string;
    expect(etag).toMatch(/^".+"$/);

    const roots = res.json().data as Array<{ slug: string; children: Array<{ slug: string }> }>;
    expect(roots.map((r) => r.slug)).toEqual([
      'electronics',
      'vehicles',
      'home-living',
      'fashion',
      'services',
      'events',
      'sourcing',
    ]);
    const electronics = roots[0]!;
    expect(electronics.children.map((c) => c.slug)).toEqual(['mobile-phones', 'laptops']);
    expect(roots.find((r) => r.slug === 'services')!.children).toHaveLength(7);
    expect(JSON.stringify(roots)).toContain('মোবাইল ফোন');

    const again = await app().inject({
      url: '/api/v1/categories',
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('serves one category with its attribute schema for forms', async () => {
    const res = await app().inject({ url: `/api/v1/categories/${seedId('cars')}` });
    expect(res.statusCode).toBe(200);
    const c = res.json().data;
    expect(c).toMatchObject({
      slug: 'cars',
      parentId: seedId('vehicles'),
      modes: ['BUY', 'RENT'],
    });
    expect(c.attributeSchema.properties.fuel.enum).toEqual([
      'Petrol',
      'Diesel',
      'Octane',
      'CNG',
      'Hybrid',
    ]);
    expect(c.attributeSchema.required).toEqual(['brand', 'model', 'year']);
    expect((await app().inject({ url: `/api/v1/categories/${randomUUID()}` })).statusCode).toBe(
      404,
    );
  });

  it('wrote one valid CategoryUpserted outbox row per seeded category', async () => {
    const rows = await db()
      .selectFrom('outbox')
      .selectAll()
      .where('type', '=', CatalogEvents.CategoryUpserted.type)
      .execute();
    expect(rows).toHaveLength(SEED_CATEGORIES.length);
    for (const seed of SEED_CATEGORIES) {
      const row = rows.find((r) => r.aggregate_id === seed.id);
      expect(row, seed.slug).toBeDefined();
      expect(row!.id).toMatch(UUID_V7);
      expect(row!.version).toBe(1);
      expect(row!.published_at).toBeNull();
      const env = EventEnvelopeSchema.parse({
        id: row!.id,
        type: row!.type,
        version: row!.version,
        occurredAt: new Date(row!.occurred_at).toISOString(),
        producer: 'catalog',
        aggregateId: row!.aggregate_id,
        payload: row!.payload,
      });
      const p = CatalogEvents.CategoryUpserted.schema.parse(env.payload);
      expect(p).toMatchObject({
        categoryId: seed.id,
        parentId: seed.parentId,
        slug: seed.slug,
        nameBn: seed.nameBn,
        modes: seed.modes,
        active: true,
      });
      expect(p.attributeSchema).toEqual(seed.attributeSchema);
    }
  });

  it('publishes its OpenAPI document (recursive tree schema included)', async () => {
    const res = await app().inject({ url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/api/v1/categories');
  });
});

describe('admin categories', () => {
  it('requires category:manage', async () => {
    const body = { slug: slug(), nameEn: 'X', nameBn: 'এক্স', modes: ['BUY'] };
    expect(
      (await app().inject({ method: 'POST', url: '/api/v1/admin/categories', payload: body }))
        .statusCode,
    ).toBe(401);
    for (const role of ['MEMBER', 'MODERATOR'] as const) {
      const res = await app().inject({
        method: 'POST',
        url: '/api/v1/admin/categories',
        headers: await t.auth.as(randomUUID(), [role]),
        payload: body,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('creates a category under a parent, emits CategoryUpserted and audits it', async () => {
    const res = await createCategory({
      parentId: seedId('services'),
      nameEn: 'Cook',
      nameBn: 'রাঁধুনি',
      modes: ['HIRE', 'HIRE'],
      attributeSchema: {
        properties: {
          cuisine: {
            type: 'string',
            label: { en: 'Cuisine', bn: 'রান্নার ধরন' },
            enum: ['Bangali', 'Chinese'],
          },
        },
        required: ['cuisine'],
      },
    });
    expect(res.statusCode).toBe(201);
    const c = res.json().data;
    expect(c).toMatchObject({ parentId: seedId('services'), modes: ['HIRE'], active: true });
    expect(c.id).toMatch(UUID_V7);

    const ev = await db()
      .selectFrom('outbox')
      .select(['type', 'payload'])
      .where('aggregate_id', '=', c.id)
      .executeTakeFirstOrThrow();
    expect(ev.type).toBe('catalog.CategoryUpserted');
    expect(CatalogEvents.CategoryUpserted.schema.parse(ev.payload).slug).toBe(c.slug);
    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'actor_type'])
      .where('target_id', '=', c.id)
      .execute();
    expect(audit).toEqual([{ action: 'category.created', actor_type: 'ADMIN' }]);

    const tree = (await app().inject({ url: '/api/v1/categories' })).json().data;
    const services = tree.find((n: { slug: string }) => n.slug === 'services');
    expect(services.children.map((n: { id: string }) => n.id)).toContain(c.id);
  });

  it('rejects a structurally invalid attribute schema (400)', async () => {
    const res = await createCategory({
      attributeSchema: {
        properties: { colour: { type: 'date', label: { en: 'Colour', bn: 'রং' } } },
      },
    });
    expect(res.statusCode).toBe(400);
    const bad = await createCategory({
      attributeSchema: {
        properties: { 'Bad Key': { type: 'boolean', label: { en: 'x', bn: 'x' } } },
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('rejects an incoherent attribute schema (422)', async () => {
    const res = await createCategory({
      attributeSchema: {
        properties: {
          year: { type: 'integer', label: { en: 'Year', bn: 'সাল' }, minimum: 2030, maximum: 1990 },
        },
        required: ['colour'],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('INVALID_ATTRIBUTE_SCHEMA');
  });

  it('rejects unknown parents, duplicate slugs, bad modes and unknown fields', async () => {
    const orphan = await createCategory({ parentId: randomUUID() });
    expect(orphan.statusCode).toBe(422);
    expect(orphan.json().error.details.rule).toBe('PARENT_NOT_FOUND');

    expect((await createCategory({ slug: 'mobile-phones' })).statusCode).toBe(409);
    expect((await createCategory({ modes: ['STEAL'] })).statusCode).toBe(400);
    expect((await createCategory({ modes: [] })).statusCode).toBe(400);
    expect((await createCategory({ slug: 'Bad Slug' })).statusCode).toBe(400);
    expect((await createCategory({ version: 9 })).statusCode).toBe(400);
  });

  it('updates, refuses cycles, and hides deactivated categories from the public', async () => {
    const a = (await createCategory({})).json().data;
    const b = (await createCategory({ parentId: a.id })).json().data;
    const patch = async (id: string, payload: Record<string, unknown>) =>
      app().inject({
        method: 'PATCH',
        url: `/api/v1/admin/categories/${id}`,
        headers: await admin(),
        payload,
      });

    const cycle = await patch(a.id, { parentId: b.id });
    expect(cycle.statusCode).toBe(422);
    expect(cycle.json().error.details.rule).toBe('CATEGORY_CYCLE');
    expect((await patch(a.id, { parentId: a.id })).json().error.details.rule).toBe(
      'CATEGORY_CYCLE',
    );
    expect((await patch(randomUUID(), { nameEn: 'Nope' })).statusCode).toBe(404);
    expect((await patch(a.id, {})).statusCode).toBe(400);

    const off = await patch(b.id, { active: false, nameEn: 'Retired' });
    expect(off.statusCode).toBe(200);
    expect(off.json().data).toMatchObject({ active: false, nameEn: 'Retired', version: 1 });
    expect((await app().inject({ url: `/api/v1/categories/${b.id}` })).statusCode).toBe(404);

    const events = await db()
      .selectFrom('outbox')
      .select('payload')
      .where('aggregate_id', '=', b.id)
      .orderBy('occurred_at')
      .execute();
    expect(events.map((e) => (e.payload as { active: boolean }).active)).toEqual([true, false]);
  });

  it('lists inactive categories to staff so they can be switched back on', async () => {
    const c = (await createCategory({ active: false })).json().data;
    const get = async (url: string, headers?: Record<string, string>) =>
      app().inject({ url, ...(headers ? { headers } : {}) });

    expect((await get('/api/v1/admin/categories')).statusCode).toBe(401);
    expect(
      (await get('/api/v1/admin/categories', await t.auth.as(randomUUID(), ['MODERATOR'])))
        .statusCode,
    ).toBe(403);

    const list = await get('/api/v1/admin/categories', await admin());
    expect(list.statusCode).toBe(200);
    const all = list.json().data as Array<{ id: string; active: boolean; slug: string }>;
    expect(all.find((x) => x.id === c.id)).toMatchObject({ active: false });
    expect(all.map((x) => x.slug)).toContain('mobile-phones');

    const one = await get(`/api/v1/admin/categories/${c.id}`, await admin());
    expect(one.json().data).toMatchObject({ id: c.id, active: false, version: 0 });
    expect((await get(`/api/v1/admin/categories/${randomUUID()}`, await admin())).statusCode).toBe(
      404,
    );

    const on = await app().inject({
      method: 'PATCH',
      url: `/api/v1/admin/categories/${c.id}`,
      headers: await admin(),
      payload: { active: true },
    });
    expect(on.json().data).toMatchObject({ active: true });
    expect((await get(`/api/v1/categories/${c.id}`)).statusCode).toBe(200);
  });
});
