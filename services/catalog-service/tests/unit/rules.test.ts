import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AttributeSchemaSchema, type AttributeSchema } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_CATEGORIES } from '../../migrations/0002_seed_categories';
import {
  assertAttributeSchemaCoherent,
  assertValidParent,
  buildTree,
  MAX_CATEGORY_DEPTH,
  type Category,
} from '../../src/domain/category';
import {
  assertPublishable,
  modeForKind,
  validateDraftAttributes,
  type CategoryFacts,
  type ListingContent,
} from '../../src/domain/listing';
import { httpVerificationGateway } from '../../src/infrastructure/http-verification-gateway';

const phoneSchema: AttributeSchema = AttributeSchemaSchema.parse({
  properties: {
    brand: { type: 'string', label: { en: 'Brand', bn: 'ব্র্যান্ড' }, enum: ['Samsung', 'Apple'] },
    storageGb: { type: 'integer', label: { en: 'Storage', bn: 'স্টোরেজ' }, minimum: 1 },
  },
  required: ['brand'],
});
const phones: CategoryFacts = {
  active: true,
  modes: ['BUY', 'RENT'],
  attributeSchema: phoneSchema,
};

const content = (over: Partial<ListingContent> = {}): ListingContent => ({
  categoryId: '0192ca7a-0000-7000-8000-000000000101',
  kind: 'PRODUCT',
  condition: 'USED',
  title: 'Samsung Galaxy S23, 256GB',
  description: 'Lightly used, box and charger included.',
  price: { amount: 6_500_000, currency: 'BDT' },
  priceUnit: 'TOTAL',
  quantityAvailable: 1,
  attributes: { brand: 'Samsung', storageGb: 256 },
  district: 'dhaka',
  area: 'Mirpur 10',
  deliveryModes: ['BUYER_PICKUP'],
  mediaIds: [],
  ...over,
});

const ruleOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return (e.details?.['rule'] as string | undefined) ?? e.code;
    throw e;
  }
  return undefined;
};

describe('publish rules', () => {
  it('accepts a complete listing', () => {
    expect(ruleOf(() => assertPublishable(content(), phones))).toBeUndefined();
  });

  it.each([
    ['inactive category', content(), { ...phones, active: false }, 'CATEGORY_INACTIVE'],
    [
      'mode not allowed',
      content({ kind: 'SERVICE', condition: null }),
      phones,
      'CATEGORY_MODE_NOT_ALLOWED',
    ],
    ['phone in title', content({ title: 'Call 01712345678 now' }), phones, 'NO_CONTACT_INFO'],
    [
      'bengali phone in description',
      content({ description: 'ফোন: ০১৭১২-৩৪৫৬৭৮' }),
      phones,
      'NO_CONTACT_INFO',
    ],
    [
      'email in description',
      content({ description: 'mail me a@b.com' }),
      phones,
      'NO_CONTACT_INFO',
    ],
    ['zero price', content({ price: { amount: 0, currency: 'BDT' } }), phones, 'PRICE_REQUIRED'],
    ['no quantity', content({ quantityAvailable: 0 }), phones, 'QUANTITY_REQUIRED'],
    [
      'missing required attribute',
      content({ attributes: { storageGb: 128 } }),
      phones,
      'INVALID_ATTRIBUTES',
    ],
    [
      'rental in a RENT category',
      content({ kind: 'RENTAL', condition: null }),
      { ...phones, modes: ['RENT'] },
      undefined,
    ],
  ] as const)('%s', (_name, c, cat, rule) => {
    expect(ruleOf(() => assertPublishable(c, cat))).toBe(rule);
  });

  it('rejects a condition on services', () => {
    const svc: CategoryFacts = { active: true, modes: ['HIRE'], attributeSchema: phoneSchema };
    expect(
      ruleOf(() => assertPublishable(content({ kind: 'SERVICE', condition: 'NEW' }), svc)),
    ).toBe('CONDITION_NOT_APPLICABLE');
  });

  it('maps listing kinds to need modes', () => {
    expect([modeForKind('PRODUCT'), modeForKind('RENTAL'), modeForKind('SERVICE')]).toEqual([
      'BUY',
      'RENT',
      'HIRE',
    ]);
  });

  it('lets drafts be incomplete but never malformed', () => {
    expect(validateDraftAttributes(phoneSchema, { storageGb: 64 })).toEqual({ storageGb: 64 });
    expect(ruleOf(() => validateDraftAttributes(phoneSchema, { color: 'red' }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(ruleOf(() => validateDraftAttributes(phoneSchema, { brand: 'Nokia' }))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('category rules', () => {
  it('rejects incoherent attribute schemas', () => {
    const bad = AttributeSchemaSchema.parse({
      properties: {
        year: { type: 'integer', label: { en: 'Year', bn: 'সাল' }, minimum: 2030, maximum: 1990 },
      },
      required: ['colour'],
    });
    let err: AppError | undefined;
    try {
      assertAttributeSchemaCoherent(bad);
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.details).toMatchObject({ rule: 'INVALID_ATTRIBUTE_SCHEMA' });
    expect((err?.details?.['issues'] as unknown[]).length).toBe(2);
  });

  it('prevents cycles and over-deep trees', () => {
    expect(ruleOf(() => assertValidParent('a', ['b', 'a', 'root']))).toBe('CATEGORY_CYCLE');
    expect(ruleOf(() => assertValidParent('a', ['a']))).toBe('CATEGORY_CYCLE');
    expect(ruleOf(() => assertValidParent('a', ['b', 'root']))).toBeUndefined();
    const deep = Array.from({ length: MAX_CATEGORY_DEPTH }, (_, i) => `p${i}`);
    expect(ruleOf(() => assertValidParent(null, deep))).toBe('CATEGORY_TOO_DEEP');
  });

  it('builds a sorted tree of active categories only', () => {
    const cat = (id: string, parentId: string | null, sort: number, active = true): Category => ({
      id,
      parentId,
      slug: id,
      nameEn: id,
      nameBn: id,
      modes: ['BUY'],
      attributeSchema: { properties: {}, required: [] },
      sort,
      active,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const tree = buildTree([
      cat('b', null, 2),
      cat('a', null, 1),
      cat('a2', 'a', 2),
      cat('a1', 'a', 1),
      cat('off', null, 0, false),
      cat('orphan', 'off', 0),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['a', 'b']);
    expect(tree[0]!.children.map((n) => n.id)).toEqual(['a1', 'a2']);
  });

  it('seed tree is valid: unique ids/slugs, coherent schemas, parents first', () => {
    const ids = new Set<string>();
    const slugs = new Set<string>();
    for (const c of SEED_CATEGORIES) {
      expect(c.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(ids.has(c.id)).toBe(false);
      expect(slugs.has(c.slug)).toBe(false);
      if (c.parentId) expect(ids.has(c.parentId)).toBe(true);
      ids.add(c.id);
      slugs.add(c.slug);
      expect(() => assertAttributeSchemaCoherent(c.attributeSchema)).not.toThrow();
      expect(c.modes.length).toBeGreaterThan(0);
    }
  });
});

describe('verification gateway (fails closed)', () => {
  let server: Server;
  let baseUrl: string;
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  let lastUrl = '';
  let lastToken: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      lastUrl = req.url ?? '';
      lastToken = req.headers['x-internal-token'] as string | undefined;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const q = {
    accountId: '0192ca7a-0000-7000-8000-00000000aaaa',
    action: 'LISTING_PUBLISH' as const,
    categoryId: '0192ca7a-0000-7000-8000-000000000101',
    amount: 6_500_000,
  };
  const ctx = { requestId: 'req-12345678', correlationId: 'corr-12345678' };
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return (e as AppError).code;
    }
  };

  it('passes the query and token, and reads the { data } envelope', async () => {
    reply = { status: 200, body: { data: { satisfied: false, missing: ['NID'] } } };
    const gw = httpVerificationGateway({ baseUrl, token: 'secret-token' });
    expect(await gw.evaluate(q, ctx)).toEqual({ satisfied: false, missing: ['NID'] });
    expect(lastToken).toBe('secret-token');
    const url = new URL(lastUrl, baseUrl);
    expect(url.pathname).toBe('/internal/v1/verification/evaluate');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      accountId: q.accountId,
      action: 'LISTING_PUBLISH',
      categoryId: q.categoryId,
      amount: '6500000',
    });
  });

  it.each([
    ['5xx', { status: 500, body: {} }],
    [
      '4xx with error envelope',
      { status: 404, body: { error: { code: 'NOT_FOUND', message: 'x' } } },
    ],
    ['malformed body', { status: 200, body: { data: { ok: true } } }],
  ])('%s → 503', async (_n, r) => {
    reply = r;
    const gw = httpVerificationGateway({ baseUrl, token: 'secret-token' });
    expect(await codeOf(gw.evaluate(q, ctx))).toBe('UNAVAILABLE');
  });

  it('unreachable → 503', async () => {
    const gw = httpVerificationGateway({
      baseUrl: 'http://127.0.0.1:9',
      token: 't',
      timeoutMs: 300,
    });
    expect(await codeOf(gw.evaluate(q, ctx))).toBe('UNAVAILABLE');
  });
});
