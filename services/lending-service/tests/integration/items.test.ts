import { randomUUID } from 'node:crypto';
import { LendingEvents, ModerationEvents } from '@dorkar/contracts';
import { envelope } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { helpers, startLending, verification, type Lending } from './harness';

let t: Lending;
const h = helpers(() => t);

beforeAll(async () => {
  t = await startLending('lending_items');
});
afterAll(() => t.close());
beforeEach(() => {
  verification.mode = 'ok';
  verification.calls = [];
});

const published = async (itemId: string) =>
  (await h.outbox(itemId, LendingEvents.LendItemPublished.type)).map((e) =>
    LendingEvents.LendItemPublished.schema.parse(e.payload),
  );

const moderate = (itemId: string, action: 'HIDE' | 'RESTORE') =>
  envelope(ModerationEvents.ContentModerated, {
    caseId: randomUUID(),
    targetType: 'LEND_ITEM',
    targetId: itemId,
    action,
    reason: 'Reported as misleading',
    moderatorId: randomUUID(),
  });

describe('creating lend items', () => {
  it('publishes an item with requirements and emits LendItemPublished', async () => {
    const lender = randomUUID();
    const categoryId = await h.category();
    const res = await h.post(
      '/api/v1/lend-items',
      lender,
      h.itemBody(categoryId, {
        mediaIds: [randomUUID()],
        requirements: { nidVerified: true, minCompletedDeals: 2, minRating: 4.5 },
      }),
    );
    expect(res.statusCode).toBe(201);
    const item = res.json().data;
    expect(item).toMatchObject({
      lenderId: lender,
      categoryId,
      title: 'Bosch cordless drill',
      deposit: { amount: 50_000, currency: 'BDT' },
      maxLoanDays: 14,
      requirements: { nidVerified: true, minCompletedDeals: 2, minRating: 4.5 },
      active: true,
      hidden: false,
    });
    expect(await published(item.id)).toEqual([
      {
        itemId: item.id,
        lenderId: lender,
        categoryId,
        title: 'Bosch cordless drill',
        district: 'dhaka',
        active: true,
      },
    ]);
    expect(verification.calls).toEqual([
      { accountId: lender, action: 'LEND_ITEM_PUBLISH', amount: 50_000 },
    ]);
  });

  it('defaults to no deposit and no requirements', async () => {
    const res = await h.post('/api/v1/lend-items', randomUUID(), {
      categoryId: await h.category(),
      title: 'Ladder 8ft',
      condition: 'USED',
      district: 'gazipur',
      maxLoanDays: 3,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({
      deposit: null,
      description: '',
      mediaIds: [],
      requirements: { nidVerified: false, minCompletedDeals: 0, minRating: null },
    });
  });

  it('requires lending:create, a lendable category and a sane loan length', async () => {
    const categoryId = await h.category();
    const noPerm = await h.post('/api/v1/lend-items', randomUUID(), h.itemBody(categoryId), {
      roles: ['MODERATOR'],
    });
    expect(noPerm.statusCode).toBe(403);
    const anonymous = await h.app().inject({
      method: 'POST',
      url: '/api/v1/lend-items',
      payload: h.itemBody(categoryId),
    });
    expect(anonymous.statusCode).toBe(401);

    for (const cat of [
      await h.category(['BUY', 'RENT']),
      await h.category(['BORROW'], false),
      randomUUID(),
    ]) {
      const res = await h.post('/api/v1/lend-items', randomUUID(), h.itemBody(cat));
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details.rule).toBe('CATEGORY_NOT_LENDABLE');
    }

    const tooLong = await h.post(
      '/api/v1/lend-items',
      randomUUID(),
      h.itemBody(categoryId, { maxLoanDays: 61 }),
    );
    expect(tooLong.statusCode).toBe(422);
    expect(tooLong.json().error.details.rule).toBe('MAX_LOAN_DAYS_EXCEEDED');

    const invalid = [
      { mediaIds: Array.from({ length: 9 }, () => randomUUID()) },
      { title: 'x'.repeat(121) },
      { description: 'x'.repeat(2001) },
      { requirements: { minRating: 6 } },
      { requirements: { minCompletedDeals: -1 } },
      { sneaky: true },
    ];
    for (const over of invalid) {
      const res = await h.post('/api/v1/lend-items', randomUUID(), h.itemBody(categoryId, over));
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
    }
  });

  it('rejects contact details in the title and description', async () => {
    const categoryId = await h.category();
    const phone = await h.post(
      '/api/v1/lend-items',
      randomUUID(),
      h.itemBody(categoryId, { title: 'Drill — call ০১৭১২-৩৪৫৬৭৮' }),
    );
    expect(phone.statusCode).toBe(422);
    expect(phone.json().error.details).toEqual({ rule: 'NO_CONTACT_INFO', field: 'title' });

    const email = await h.post(
      '/api/v1/lend-items',
      randomUUID(),
      h.itemBody(categoryId, { description: 'write to rahim@example.com' }),
    );
    expect(email.statusCode).toBe(422);
    expect(email.json().error.details).toEqual({ rule: 'NO_CONTACT_INFO', field: 'description' });
  });

  it('fails closed on the LEND_ITEM_PUBLISH policy', async () => {
    const categoryId = await h.category();
    verification.mode = 'deny';
    const denied = await h.post('/api/v1/lend-items', randomUUID(), h.itemBody(categoryId));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      details: { action: 'LEND_ITEM_PUBLISH', missing: ['NID'] },
    });
    verification.mode = 'down';
    expect(
      (await h.post('/api/v1/lend-items', randomUUID(), h.itemBody(categoryId))).statusCode,
    ).toBe(503);
  });

  it('requires an Idempotency-Key and replays a retry', async () => {
    const lender = randomUUID();
    const categoryId = await h.category();
    const missing = await h.post('/api/v1/lend-items', lender, h.itemBody(categoryId), {
      key: null,
    });
    expect(missing.statusCode).toBe(400);

    const key = randomUUID();
    const first = await h.post('/api/v1/lend-items', lender, h.itemBody(categoryId), { key });
    const again = await h.post('/api/v1/lend-items', lender, h.itemBody(categoryId), { key });
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const mine = await h.getAs('/api/v1/me/lend-items', lender);
    expect(mine.json().data).toHaveLength(1);

    const reused = await h.post(
      '/api/v1/lend-items',
      lender,
      h.itemBody(categoryId, { title: 'Something else' }),
      { key },
    );
    expect(reused.statusCode).toBe(409);
  });
});

describe('editing and deactivating', () => {
  it('lets only the owner edit; others get 404', async () => {
    const { id, lender } = await h.item();
    const stranger = await h.app().inject({
      method: 'PATCH',
      url: `/api/v1/lend-items/${id}`,
      headers: await t.auth.as(randomUUID()),
      payload: { title: 'Mine now' },
    });
    expect(stranger.statusCode).toBe(404);

    const res = await h.app().inject({
      method: 'PATCH',
      url: `/api/v1/lend-items/${id}`,
      headers: await t.auth.as(lender),
      payload: { title: 'Bosch drill with bits', deposit: null, maxLoanDays: 7 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      title: 'Bosch drill with bits',
      deposit: null,
      maxLoanDays: 7,
      version: 1,
    });
    expect((await published(id)).map((p) => p.title)).toEqual([
      'Bosch cordless drill',
      'Bosch drill with bits',
    ]);

    const phone = await h.app().inject({
      method: 'PATCH',
      url: `/api/v1/lend-items/${id}`,
      headers: await t.auth.as(lender),
      payload: { description: 'whatsapp +8801712345678' },
    });
    expect(phone.statusCode).toBe(422);
  });

  it('deactivates (owner only), then re-lists through the publish policy', async () => {
    const { id, lender } = await h.item();
    expect((await h.post(`/api/v1/lend-items/${id}/deactivate`, randomUUID())).statusCode).toBe(
      404,
    );
    const off = await h.post(`/api/v1/lend-items/${id}/deactivate`, lender);
    expect(off.statusCode).toBe(200);
    expect(off.json().data.active).toBe(false);
    // Deactivating twice is harmless and emits nothing new.
    expect((await h.post(`/api/v1/lend-items/${id}/deactivate`, lender)).statusCode).toBe(200);
    expect((await published(id)).map((p) => p.active)).toEqual([true, false]);

    verification.calls = [];
    const on = await h.app().inject({
      method: 'PATCH',
      url: `/api/v1/lend-items/${id}`,
      headers: await t.auth.as(lender),
      payload: { active: true },
    });
    expect(on.statusCode).toBe(200);
    expect(verification.calls.map((c) => c.action)).toEqual(['LEND_ITEM_PUBLISH']);
    expect((await published(id)).map((p) => p.active)).toEqual([true, false, true]);
  });
});

describe('browsing and search', () => {
  it('finds active items by words, category and district, newest first, with cursors', async () => {
    const categoryId = await h.category();
    const tag = `zx${randomUUID().slice(0, 6)}`;
    const a = await h.item({ categoryId, title: `Camping tent ${tag}`, district: 'sylhet' });
    const b = await h.item({ categoryId, title: `Tent pegs ${tag}`, district: 'dhaka' });
    const c = await h.item({
      categoryId,
      title: 'Pressure washer',
      description: `Great for a ${tag} car wash`,
      district: 'dhaka',
    });
    const off = await h.item({ categoryId, title: `Old tent ${tag}` });
    await h.post(`/api/v1/lend-items/${off.id}/deactivate`, off.lender);

    const ids = async (qs: string) =>
      (await h.app().inject({ url: `/api/v1/lend-items?${qs}` }))
        .json()
        .data.map((i: { id: string }) => i.id);

    expect(await ids(`q=${tag}`)).toEqual([c.id, b.id, a.id]);
    expect(await ids(`q=tent ${tag}`)).toEqual([b.id, a.id]);
    expect(await ids(`categoryId=${categoryId}&district=dhaka`)).toEqual([c.id, b.id]);
    expect(await ids(`q=${tag}&district=sylhet`)).toEqual([a.id]);

    const p1 = await h.app().inject({ url: `/api/v1/lend-items?q=${tag}&limit=2` });
    expect(p1.json().data).toHaveLength(2);
    const cursor = p1.json().page.nextCursor as string;
    const p2 = await h
      .app()
      .inject({ url: `/api/v1/lend-items?q=${tag}&limit=2&cursor=${cursor}` });
    expect(p2.json().data.map((i: { id: string }) => i.id)).toEqual([a.id]);
    expect(p2.json().page.nextCursor).toBeNull();

    expect((await h.app().inject({ url: '/api/v1/lend-items?cursor=garbage' })).statusCode).toBe(
      400,
    );
    expect((await h.app().inject({ url: '/api/v1/lend-items?district=atlantis' })).statusCode).toBe(
      400,
    );
  });

  it('shows the item with requirements and lender stats, never contact info', async () => {
    const { id, lender } = await h.item({
      requirements: { nidVerified: true, minCompletedDeals: 1, minRating: null },
    });
    const res = await h.app().inject({ url: `/api/v1/lend-items/${id}` });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d).toMatchObject({
      id,
      lenderId: lender,
      requirements: { nidVerified: true, minCompletedDeals: 1, minRating: null },
      lenderStats: { completedLoans: 0, onTimeReturnRate: null },
      viewerIsOwner: false,
    });
    expect(d).not.toHaveProperty('hidden');
    expect(JSON.stringify(d)).not.toMatch(/phone|email|nid_number/i);
    expect((await h.app().inject({ url: `/api/v1/lend-items/${randomUUID()}` })).statusCode).toBe(
      404,
    );
  });
});

describe('moderation', () => {
  it('hides an item from everyone but its owner, and restores it', async () => {
    const tag = `mod${randomUUID().slice(0, 6)}`;
    const { id, lender } = await h.item({ title: `Sewing machine ${tag}` });
    const search = async () =>
      (await h.app().inject({ url: `/api/v1/lend-items?q=${tag}` })).json().data.length;
    expect(await search()).toBe(1);

    const hide = moderate(id, 'HIDE');
    expect(await t.svc.runtime.deliver(hide)).toBe(true);
    expect(await t.svc.runtime.deliver(hide)).toBe(false); // redelivery is a no-op
    expect(await search()).toBe(0);
    expect((await h.app().inject({ url: `/api/v1/lend-items/${id}` })).statusCode).toBe(404);
    const owner = await h.getAs(`/api/v1/lend-items/${id}`, lender);
    expect(owner.statusCode).toBe(200);
    expect(owner.json().data).toMatchObject({ viewerIsOwner: true, hidden: true });
    expect((await h.request(id, randomUUID())).statusCode).toBe(404);
    expect((await published(id)).map((p) => p.active)).toEqual([true, false]);

    await t.svc.runtime.deliver(moderate(id, 'RESTORE'));
    expect(await search()).toBe(1);
    expect((await published(id)).map((p) => p.active)).toEqual([true, false, true]);
  });

  it('ignores moderation of other target types', async () => {
    const { id } = await h.item();
    await t.svc.runtime.deliver(
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'LISTING',
        targetId: id,
        action: 'HIDE',
        reason: 'x',
        moderatorId: randomUUID(),
      }),
    );
    expect((await h.app().inject({ url: `/api/v1/lend-items/${id}` })).statusCode).toBe(200);
  });
});
