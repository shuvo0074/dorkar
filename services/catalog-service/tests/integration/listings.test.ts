import { randomUUID } from 'node:crypto';
import { CatalogEvents, ModerationEvents } from '@dorkar/contracts';
import { Errors } from '@dorkar/kernel';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { SEED_CATEGORIES } from '../../migrations/0002_seed_categories';
import { buildCatalogService } from '../../src/app';
import type { VerificationDecision, VerificationGateway } from '../../src/application/ports';

let t: TestService<Awaited<ReturnType<typeof buildCatalogService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;
const seedId = (slug: string) => SEED_CATEGORIES.find((c) => c.slug === slug)!.id;
const PHONES = () => seedId('mobile-phones');

/** Fake verification port: tests switch its answer. */
const gate = {
  decide: async (): Promise<VerificationDecision> => ({ satisfied: true, missing: [] }),
  calls: [] as Array<Parameters<VerificationGateway['evaluate']>[0]>,
};
const fakeVerification: VerificationGateway = {
  async evaluate(q) {
    gate.calls.push(q);
    return gate.decide();
  },
};

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'catalog',
    migrations,
    build: (env, logger, verifier) =>
      buildCatalogService(env, logger, { verifier, verification: fakeVerification }),
  });
});
afterAll(() => t.close());
beforeEach(() => {
  gate.decide = async () => ({ satisfied: true, missing: [] });
  gate.calls = [];
});

const phoneBody = (over: Record<string, unknown> = {}) => ({
  categoryId: PHONES(),
  kind: 'PRODUCT',
  condition: 'USED',
  title: 'Samsung Galaxy S23 256GB',
  description: 'Lightly used, with box and charger.',
  price: { amount: 6_500_000, currency: 'BDT' },
  attributes: { brand: 'Samsung', model: 'Galaxy S23', storageGb: 256, officialWarranty: true },
  district: 'dhaka',
  area: 'Mirpur 10',
  deliveryModes: ['BUYER_PICKUP', 'SELLER_DELIVERY'],
  ...over,
});

const create = async (owner: string, over: Record<string, unknown> = {}) =>
  app().inject({
    method: 'POST',
    url: '/api/v1/listings',
    headers: await t.auth.as(owner),
    payload: phoneBody(over),
  });

const createDraft = async (owner: string, over: Record<string, unknown> = {}) => {
  const res = await create(owner, over);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data as { id: string; status: string };
};

const act = async (owner: string, id: string, action: string) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/listings/${id}/${action}`,
    headers: await t.auth.as(owner),
  });

const published = async (owner: string, over: Record<string, unknown> = {}) => {
  const l = await createDraft(owner, over);
  const res = await act(owner, l.id, 'publish');
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as { id: string; publishedAt: string; price: { amount: number } };
};

const events = async (id: string) =>
  db()
    .selectFrom('outbox')
    .select(['type', 'payload'])
    .where('aggregate_id', '=', id)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();

const history = async (id: string) =>
  db()
    .selectFrom('listing_status_history')
    .select(['from_status', 'to_status', 'actor_type', 'reason'])
    .where('listing_id', '=', id)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();

describe('create and publish', () => {
  it('creates a draft, publishes it after the verification check, emits ListingPublished', async () => {
    const owner = randomUUID();
    const draft = await createDraft(owner);
    expect(draft.status).toBe('DRAFT');
    expect(await events(draft.id)).toEqual([]); // drafts are not announced

    const res = await act(owner, draft.id, 'publish');
    expect(res.statusCode).toBe(200);
    const l = res.json().data;
    expect(l).toMatchObject({ status: 'PUBLISHED', sellerId: owner, district: 'dhaka' });
    expect(l.publishedAt).toBeTruthy();
    expect(gate.calls).toEqual([
      { accountId: owner, action: 'LISTING_PUBLISH', categoryId: PHONES(), amount: 6_500_000 },
    ]);

    const ev = await events(draft.id);
    expect(ev.map((e) => e.type)).toEqual(['catalog.ListingPublished']);
    const p = CatalogEvents.ListingPublished.schema.parse(ev[0]!.payload);
    expect(p).toMatchObject({
      listingId: draft.id,
      sellerId: owner,
      categoryId: PHONES(),
      kind: 'PRODUCT',
      price: { amount: 6_500_000, currency: 'BDT' },
      district: 'dhaka',
      attributes: { brand: 'Samsung', storageGb: 256 },
    });
    expect(await history(draft.id)).toEqual([
      { from_status: null, to_status: 'DRAFT', actor_type: 'USER', reason: null },
      { from_status: 'DRAFT', to_status: 'PUBLISHED', actor_type: 'USER', reason: null },
    ]);

    const pub = await app().inject({ url: `/api/v1/listings/${draft.id}` });
    expect(pub.statusCode).toBe(200);
    expect(Object.keys(pub.json().data)).not.toEqual(
      expect.arrayContaining(['hiddenReason', 'hiddenFrom', 'version']),
    );
    expect(pub.json().data).not.toHaveProperty('hiddenReason');
  });

  it('requires authentication and the listing:create permission', async () => {
    expect(
      (await app().inject({ method: 'POST', url: '/api/v1/listings', payload: phoneBody() }))
        .statusCode,
    ).toBe(401);
    const mod = await app().inject({
      method: 'POST',
      url: '/api/v1/listings',
      headers: await t.auth.as(randomUUID(), ['MODERATOR']),
      payload: phoneBody(),
    });
    expect(mod.statusCode).toBe(403);
  });

  it('validates attributes against the category schema', async () => {
    const owner = randomUUID();
    const unknown = await create(owner, { attributes: { brand: 'Samsung', colour: 'red' } });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.details.issues).toEqual([
      { path: 'colour', message: 'unknown attribute' },
    ]);
    const badEnum = await create(owner, { attributes: { brand: 'Nokla' } });
    expect(badEnum.statusCode).toBe(400);
    const badType = await create(owner, { attributes: { storageGb: '256' } });
    expect(badType.statusCode).toBe(400);

    // Drafts may be incomplete; publishing enforces `required`.
    const draft = await createDraft(owner, { attributes: { storageGb: 128 } });
    const res = await act(owner, draft.id, 'publish');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toMatchObject({ rule: 'INVALID_ATTRIBUTES' });
    expect(
      res
        .json()
        .error.details.issues.map((i: { path: string }) => i.path)
        .sort(),
    ).toEqual(['brand', 'model']);
  });

  it('rejects contact details in public text', async () => {
    const owner = randomUUID();
    const res = await create(owner, { title: 'iPhone 13 call 01712-345678' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toMatchObject({ rule: 'NO_CONTACT_INFO', field: 'title' });
    const bn = await create(owner, { description: 'যোগাযোগ: ০১৭১২৩৪৫৬৭৮' });
    expect(bn.json().error.details).toMatchObject({
      rule: 'NO_CONTACT_INFO',
      field: 'description',
    });
    const mail = await create(owner, { description: 'email rahim@example.com' });
    expect(mail.statusCode).toBe(422);
  });

  it('enforces the category mode, price and quantity rules', async () => {
    const owner = randomUUID();
    const service = await create(owner, { kind: 'SERVICE', condition: null });
    expect(service.statusCode).toBe(422);
    expect(service.json().error.details.rule).toBe('CATEGORY_MODE_NOT_ALLOWED');

    const tutor = await create(owner, {
      categoryId: seedId('tutor'),
      kind: 'PRODUCT',
      attributes: {},
    });
    expect(tutor.json().error.details.rule).toBe('CATEGORY_MODE_NOT_ALLOWED');

    const unknownCat = await create(owner, { categoryId: randomUUID() });
    expect(unknownCat.json().error.details.rule).toBe('CATEGORY_NOT_FOUND');

    const free = await createDraft(owner, { price: { amount: 0, currency: 'BDT' } });
    const r1 = await act(owner, free.id, 'publish');
    expect(r1.json().error.details.rule).toBe('PRICE_REQUIRED');

    const none = await createDraft(owner, { quantityAvailable: 0 });
    expect((await act(owner, none.id, 'publish')).json().error.details.rule).toBe(
      'QUANTITY_REQUIRED',
    );

    // A tutor offering (SERVICE → HIRE) is fine in a HIRE category.
    const ok = await createDraft(owner, {
      categoryId: seedId('tutor'),
      kind: 'SERVICE',
      condition: null,
      title: 'HSC Physics and Math tutor',
      priceUnit: 'PER_HOUR',
      price: { amount: 80_000, currency: 'BDT' },
      attributes: { subject: 'Physics', classLevel: 'HSC' },
    });
    expect((await act(owner, ok.id, 'publish')).statusCode).toBe(200);
  });

  it('rejects unknown fields and invalid input', async () => {
    const owner = randomUUID();
    expect((await create(owner, { status: 'PUBLISHED' })).statusCode).toBe(400);
    expect((await create(owner, { district: 'atlantis' })).statusCode).toBe(400);
    expect((await create(owner, { title: 'ab' })).statusCode).toBe(400);
    expect(
      (await create(owner, { mediaIds: Array.from({ length: 11 }, () => randomUUID()) }))
        .statusCode,
    ).toBe(400);
  });
});

describe('verification policy', () => {
  it('403 VERIFICATION_REQUIRED with the missing kinds', async () => {
    const owner = randomUUID();
    const draft = await createDraft(owner, { price: { amount: 15_000_000, currency: 'BDT' } });
    gate.decide = async () => ({ satisfied: false, missing: ['NID'] });
    const res = await act(owner, draft.id, 'publish');
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      details: { missing: ['NID'] },
    });
    const mine = await app().inject({
      url: `/api/v1/listings/${draft.id}`,
      headers: await t.auth.as(owner),
    });
    expect(mine.json().data.status).toBe('DRAFT');
    expect(await events(draft.id)).toEqual([]);
  });

  it('fails closed (503) when verification is unavailable', async () => {
    const owner = randomUUID();
    const draft = await createDraft(owner);
    gate.decide = async () => {
      throw Errors.unavailable('down');
    };
    const res = await act(owner, draft.id, 'publish');
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UNAVAILABLE');
    expect(res.headers['retry-after']).toBe('5');
    expect(await events(draft.id)).toEqual([]);
  });

  it('re-checks verification when a published listing is edited', async () => {
    const owner = randomUUID();
    const l = await published(owner);
    gate.decide = async () => ({ satisfied: false, missing: ['NID'] });
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/v1/listings/${l.id}`,
      headers: await t.auth.as(owner),
      payload: { price: { amount: 90_000_000, currency: 'BDT' } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('ownership and visibility', () => {
  it("hides others' drafts (404) and refuses edits/actions by non-owners (404)", async () => {
    const owner = randomUUID();
    const other = randomUUID();
    const draft = await createDraft(owner);
    expect((await app().inject({ url: `/api/v1/listings/${draft.id}` })).statusCode).toBe(404);
    expect(
      (
        await app().inject({
          url: `/api/v1/listings/${draft.id}`,
          headers: await t.auth.as(other),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app().inject({
          url: `/api/v1/listings/${draft.id}`,
          headers: await t.auth.as(owner),
        })
      ).json().data.status,
    ).toBe('DRAFT');

    const patch = await app().inject({
      method: 'PATCH',
      url: `/api/v1/listings/${draft.id}`,
      headers: await t.auth.as(other),
      payload: { title: 'Mine now' },
    });
    expect(patch.statusCode).toBe(404);
    for (const a of ['publish', 'pause', 'withdraw']) {
      expect((await act(other, draft.id, a)).statusCode).toBe(404);
    }
    expect((await app().inject({ url: `/api/v1/listings/${randomUUID()}` })).statusCode).toBe(404);
  });

  it('lists my listings in any state with cursor pagination and status filter', async () => {
    const owner = randomUUID();
    const a = await createDraft(owner, { title: 'Listing A phone' });
    const b = await published(owner, { title: 'Listing B phone' });
    const c = await createDraft(owner, { title: 'Listing C phone' });
    await act(owner, c.id, 'withdraw');
    await createDraft(randomUUID()); // someone else's

    const headers = await t.auth.as(owner);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: Awaited<ReturnType<ReturnType<typeof app>['inject']>> = await app().inject({
        url: `/api/v1/me/listings?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().data.map((l: { id: string }) => l.id));
      cursor = res.json().page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([c.id, b.id, a.id]);

    const pub = await app().inject({ url: '/api/v1/me/listings?status=PUBLISHED', headers });
    expect(pub.json().data.map((l: { id: string }) => l.id)).toEqual([b.id]);
    expect((await app().inject({ url: '/api/v1/me/listings' })).statusCode).toBe(401);
  });
});

describe('owner transitions and edits', () => {
  it('pause → resume → sold out → withdraw, each with its event', async () => {
    const owner = randomUUID();
    const l = await published(owner);
    expect((await act(owner, l.id, 'pause')).json().data.status).toBe('PAUSED');
    expect((await app().inject({ url: `/api/v1/listings/${l.id}` })).statusCode).toBe(404);
    expect((await act(owner, l.id, 'resume')).json().data.status).toBe('PUBLISHED');
    expect((await act(owner, l.id, 'mark-sold-out')).json().data.status).toBe('SOLD_OUT');
    const resume = await act(owner, l.id, 'resume');
    expect(resume.statusCode).toBe(409);
    expect(resume.json().error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await act(owner, l.id, 'withdraw')).json().data.status).toBe('WITHDRAWN');
    expect((await act(owner, l.id, 'publish')).statusCode).toBe(409);

    const ev = await events(l.id);
    expect(
      ev.map((e) =>
        e.type === 'catalog.ListingUnavailable'
          ? `Unavailable:${CatalogEvents.ListingUnavailable.schema.parse(e.payload).reason}`
          : e.type.split('.')[1],
      ),
    ).toEqual([
      'ListingPublished',
      'Unavailable:PAUSED',
      'ListingPublished',
      'Unavailable:SOLD_OUT',
      'Unavailable:WITHDRAWN',
    ]);
  });

  it('edits drafts silently and published listings with ListingUpdated; refuses frozen states', async () => {
    const owner = randomUUID();
    const headers = await t.auth.as(owner);
    const draft = await createDraft(owner);
    const d = await app().inject({
      method: 'PATCH',
      url: `/api/v1/listings/${draft.id}`,
      headers,
      payload: { title: 'Samsung S23 Ultra 512GB' },
    });
    expect(d.statusCode).toBe(200);
    expect(await events(draft.id)).toEqual([]);

    const l = await published(owner);
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/v1/listings/${l.id}`,
      headers,
      payload: { price: { amount: 6_000_000, currency: 'BDT' }, quantityAvailable: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ price: { amount: 6_000_000 }, quantityAvailable: 2 });
    const ev = await events(l.id);
    expect(ev.map((e) => e.type)).toEqual(['catalog.ListingPublished', 'catalog.ListingUpdated']);
    expect(CatalogEvents.ListingUpdated.schema.parse(ev[1]!.payload).price.amount).toBe(6_000_000);

    // Published edits must stay publishable.
    const broken = await app().inject({
      method: 'PATCH',
      url: `/api/v1/listings/${l.id}`,
      headers,
      payload: { attributes: { storageGb: 64 } },
    });
    expect(broken.statusCode).toBe(422);
    expect(broken.json().error.details.rule).toBe('INVALID_ATTRIBUTES');
    const phone = await app().inject({
      method: 'PATCH',
      url: `/api/v1/listings/${l.id}`,
      headers,
      payload: { description: 'WhatsApp +880 1712 345678' },
    });
    expect(phone.json().error.details.rule).toBe('NO_CONTACT_INFO');

    await act(owner, l.id, 'mark-sold-out');
    const frozen = await app().inject({
      method: 'PATCH',
      url: `/api/v1/listings/${l.id}`,
      headers,
      payload: { title: 'Back in stock' },
    });
    expect(frozen.statusCode).toBe(409);
    expect(
      (
        await app().inject({
          method: 'PATCH',
          url: `/api/v1/listings/${l.id}`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });

  it('concurrent publishes of one draft: exactly one transition and one event', async () => {
    const owner = randomUUID();
    const draft = await createDraft(owner);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => act(owner, draft.id, 'publish')),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    expect((await events(draft.id)).map((e) => e.type)).toEqual(['catalog.ListingPublished']);
    expect((await history(draft.id)).filter((h) => h.to_status === 'PUBLISHED')).toHaveLength(1);
  });
});

describe('moderation', () => {
  it('moderator hides and restores via the admin endpoints (audited)', async () => {
    const owner = randomUUID();
    const moderator = randomUUID();
    const l = await published(owner);
    const url = (a: string) => `/api/v1/admin/listings/${l.id}/${a}`;
    const payload = { reason: 'Counterfeit suspected' };

    expect(
      (
        await app().inject({
          method: 'POST',
          url: url('hide'),
          headers: await t.auth.as(randomUUID()),
          payload,
        })
      ).statusCode,
    ).toBe(403);

    const modHeaders = await t.auth.as(moderator, ['MODERATOR']);
    const hide = await app().inject({
      method: 'POST',
      url: url('hide'),
      headers: modHeaders,
      payload,
    });
    expect(hide.statusCode).toBe(200);
    expect(hide.json().data.status).toBe('HIDDEN');
    expect(hide.json().data).not.toHaveProperty('hiddenReason');
    expect((await app().inject({ url: `/api/v1/listings/${l.id}` })).statusCode).toBe(404);
    const own = await app().inject({
      url: `/api/v1/listings/${l.id}`,
      headers: await t.auth.as(owner),
    });
    expect(own.json().data.status).toBe('HIDDEN');
    expect(JSON.stringify(own.json())).not.toContain('Counterfeit');
    // The owner cannot un-hide by resuming.
    expect((await act(owner, l.id, 'resume')).statusCode).toBe(409);

    const again = await app().inject({
      method: 'POST',
      url: url('hide'),
      headers: modHeaders,
      payload,
    });
    expect(again.statusCode).toBe(409);

    const restore = await app().inject({
      method: 'POST',
      url: url('restore'),
      headers: modHeaders,
      payload: { reason: 'Seller showed receipts' },
    });
    expect(restore.json().data.status).toBe('PUBLISHED');

    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'actor_id', 'actor_type'])
      .where('target_id', '=', l.id)
      .orderBy('occurred_at')
      .execute();
    expect(audit).toEqual([
      { action: 'listing.hidden', actor_id: moderator, actor_type: 'ADMIN' },
      { action: 'listing.restored', actor_id: moderator, actor_type: 'ADMIN' },
    ]);
    const h = await history(l.id);
    expect(h.slice(-2)).toEqual([
      {
        from_status: 'PUBLISHED',
        to_status: 'HIDDEN',
        actor_type: 'ADMIN',
        reason: 'Counterfeit suspected',
      },
      {
        from_status: 'HIDDEN',
        to_status: 'PUBLISHED',
        actor_type: 'ADMIN',
        reason: 'Seller showed receipts',
      },
    ]);
    expect((await events(l.id)).map((e) => e.type)).toEqual([
      'catalog.ListingPublished',
      'catalog.ListingUnavailable',
      'catalog.ListingPublished',
    ]);
    expect(
      (
        await app().inject({
          method: 'POST',
          url: `/api/v1/admin/listings/${randomUUID()}/hide`,
          headers: modHeaders,
          payload,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('restores a hidden listing to the state it was hidden from', async () => {
    const owner = randomUUID();
    const l = await published(owner);
    await act(owner, l.id, 'pause');
    const modHeaders = await t.auth.as(randomUUID(), ['MODERATOR']);
    const post = (a: string) =>
      app().inject({
        method: 'POST',
        url: `/api/v1/admin/listings/${l.id}/${a}`,
        headers: modHeaders,
        payload: { reason: 'Review complete' },
      });
    expect((await post('hide')).json().data.status).toBe('HIDDEN');
    expect((await post('restore')).json().data.status).toBe('PAUSED');
  });

  it('applies ContentModerated events exactly once and ignores other targets', async () => {
    const owner = randomUUID();
    const l = await published(owner);
    const moderatorId = randomUUID();
    const hide = envelope(ModerationEvents.ContentModerated, {
      caseId: randomUUID(),
      targetType: 'LISTING',
      targetId: l.id,
      action: 'HIDE',
      reason: 'Prohibited item',
      moderatorId,
    });
    expect(await t.svc.runtime.deliver(hide)).toBe(true);
    expect(await t.svc.runtime.deliver(hide)).toBe(false);
    expect((await app().inject({ url: `/api/v1/listings/${l.id}` })).statusCode).toBe(404);

    const unavailable = (await events(l.id)).filter((e) => e.type === 'catalog.ListingUnavailable');
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.payload).toMatchObject({ reason: 'HIDDEN', sellerId: owner });
    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'actor_id'])
      .where('target_id', '=', l.id)
      .execute();
    expect(audit).toEqual([{ action: 'listing.hidden', actor_id: moderatorId }]);

    // A second HIDE (different case) is a no-op, not an error.
    expect(
      await t.svc.runtime.deliver(
        envelope(ModerationEvents.ContentModerated, {
          ...hide.payload,
          caseId: randomUUID(),
        }),
      ),
    ).toBe(true);

    // Other target types and unknown listings are ignored.
    for (const targetType of ['NEED', 'LISTING'] as const) {
      await t.svc.runtime.deliver(
        envelope(ModerationEvents.ContentModerated, {
          ...hide.payload,
          caseId: randomUUID(),
          targetType,
          targetId: targetType === 'NEED' ? l.id : randomUUID(),
          action: 'RESTORE',
        }),
      );
    }
    expect((await app().inject({ url: `/api/v1/listings/${l.id}` })).statusCode).toBe(404);

    await t.svc.runtime.deliver(
      envelope(ModerationEvents.ContentModerated, {
        ...hide.payload,
        caseId: randomUUID(),
        action: 'RESTORE',
        reason: 'Appeal accepted',
      }),
    );
    expect((await app().inject({ url: `/api/v1/listings/${l.id}` })).statusCode).toBe(200);
  });
});

describe('search', () => {
  const tag = `zq${randomUUID().slice(0, 6)}`;
  type Row = { id: string; publishedAt: string; price: { amount: number }; categoryId: string };
  let all: Row[] = [];
  const seller = randomUUID();

  beforeAll(async () => {
    const make = (title: string, amount: number, over: Record<string, unknown> = {}) =>
      published(seller, {
        title: `${title} ${tag}`,
        price: { amount, currency: 'BDT' },
        district: 'sylhet',
        ...over,
      });
    const laptop = {
      categoryId: seedId('laptops'),
      attributes: { brand: 'Lenovo', model: 'ThinkPad T14' },
    };
    // Duplicate prices exercise the id tie-breaker in the cursor.
    for (const [title, amount, over] of [
      ['Samsung A54', 3_500_000, {}],
      ['iPhone 13', 6_000_000, { attributes: { brand: 'Apple', model: 'iPhone 13' } }],
      ['Xiaomi Note 12', 2_000_000, { condition: 'NEW' }],
      ['Realme 11', 2_000_000, {}],
      ['Pixel 7', 4_500_000, {}],
      ['Lenovo ThinkPad', 9_000_000, laptop],
      ['Samsung S21', 3_500_000, {}],
      ['Old Nokia', 300_000, { district: 'rajshahi' }],
    ] as const) {
      await make(title, amount, over);
    }
    const draft = await createDraft(seller, { title: `Draft phone ${tag}`, district: 'sylhet' });
    const paused = await published(seller, { title: `Paused phone ${tag}`, district: 'sylhet' });
    await act(seller, paused.id, 'pause');
    expect(draft.id).toBeTruthy();

    const res = await app().inject({ url: `/api/v1/listings?q=${tag}&limit=100` });
    all = res.json().data;
  });

  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const search = async (qs: string) => {
    const res = await app().inject({ url: `/api/v1/listings?${qs}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ data: Row[]; page: { nextCursor: string | null } }>();
  };
  const pageThrough = async (qs: string, limit: number) => {
    const out: Row[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await search(`${qs}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      out.push(...r.data);
      cursor = r.page.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    return { out, pages };
  };

  it('full-text finds only published listings', () => {
    expect(all).toHaveLength(8);
    expect(all.every((r) => (r as unknown as { status: string }).status === 'PUBLISHED')).toBe(
      true,
    );
  });

  it('matches title words (q) case-insensitively', async () => {
    const r = await search(`q=${encodeURIComponent(`SAMSUNG ${tag}`)}`);
    expect(r.data).toHaveLength(2);
  });

  it.each([
    ['newest', (a: Row, b: Row) => cmp(b.publishedAt, a.publishedAt) || cmp(b.id, a.id)],
    ['price_asc', (a: Row, b: Row) => a.price.amount - b.price.amount || cmp(a.id, b.id)],
    ['price_desc', (a: Row, b: Row) => b.price.amount - a.price.amount || cmp(b.id, a.id)],
  ] as const)('pages through sort=%s without duplicates or skips', async (sort, order) => {
    const expected = [...all].sort(order);
    const { out, pages } = await pageThrough(`q=${tag}&sort=${sort}`, 3);
    expect(pages).toBe(3);
    expect(ids(out)).toEqual(ids(expected));
    expect(new Set(ids(out)).size).toBe(8);
  });

  it('filters by category (including direct children), district, kind, condition and price', async () => {
    const electronics = await search(`q=${tag}&categoryId=${seedId('electronics')}&limit=100`);
    expect(electronics.data).toHaveLength(8);
    const laptops = await search(`q=${tag}&categoryId=${seedId('laptops')}`);
    expect(laptops.data.map((r) => r.categoryId)).toEqual([seedId('laptops')]);
    const phones = await search(`q=${tag}&categoryId=${PHONES()}&limit=100`);
    expect(phones.data).toHaveLength(7);
    const vehicles = await search(`q=${tag}&categoryId=${seedId('vehicles')}`);
    expect(vehicles.data).toHaveLength(0);

    const sylhet = await search(`q=${tag}&district=sylhet&limit=100`);
    expect(sylhet.data).toHaveLength(7);
    const isNew = await search(`q=${tag}&condition=NEW`);
    expect(isNew.data).toHaveLength(1);
    expect((await search(`q=${tag}&kind=RENTAL`)).data).toHaveLength(0);

    const range = await pageThrough(`q=${tag}&minPrice=2000000&maxPrice=4500000&sort=price_asc`, 2);
    expect(range.out.map((r) => r.price.amount)).toEqual([
      2_000_000, 2_000_000, 3_500_000, 3_500_000, 4_500_000,
    ]);
  });

  it('rejects bad queries and cursors', async () => {
    const bad = async (qs: string) =>
      (await app().inject({ url: `/api/v1/listings?${qs}` })).statusCode;
    expect(await bad('minPrice=500&maxPrice=100')).toBe(400);
    expect(await bad('sort=random')).toBe(400);
    expect(await bad('district=atlantis')).toBe(400);
    expect(await bad('foo=bar')).toBe(400);
    expect(await bad('cursor=not-a-cursor')).toBe(400);
    const first = await search(`q=${tag}&sort=price_asc&limit=2`);
    expect(await bad(`q=${tag}&sort=newest&cursor=${first.page.nextCursor}`)).toBe(400);
  });
});
