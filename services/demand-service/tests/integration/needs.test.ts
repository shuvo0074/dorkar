import { randomUUID } from 'node:crypto';
import { DemandEvents, MatchingEvents } from '@dorkar/contracts';
import { TEST_INTERNAL_TOKEN, envelope, type TestService } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { needBody, seedCategory, startDemand, type FakeVerification, type Svc } from './harness';

let t: TestService<Svc>;
let verification: FakeVerification;
const app = () => t.svc.runtime.app;
const inFuture = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ t, verification } = await startDemand({ NEED_MAX_OPEN_PER_USER: '3' }));
});
afterAll(() => t.close());
beforeEach(() => {
  verification.mode = 'ok';
});

const post = async (user: string, body: unknown) =>
  app().inject({
    method: 'POST',
    url: '/api/v1/needs',
    headers: await t.auth.as(user),
    payload: body as Record<string, unknown>,
  });

const command = async (user: string, id: string, name: string) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/needs/${id}/${name}`,
    headers: await t.auth.as(user),
  });

const outbox = async (needId: string) =>
  t.svc.runtime.db
    .selectFrom('outbox')
    .select(['type', 'payload'])
    .where('aggregate_id', '=', needId)
    .execute();

describe('POST /api/v1/needs', () => {
  it('publishes the documented example and emits a contract-valid NeedPublished', async () => {
    const cat = await seedCategory(t);
    const user = randomUUID();
    const res = await post(user, needBody(cat, { requiredBy: inFuture(10) }));
    expect(res.statusCode).toBe(201);
    const n = res.json().data;
    expect(n).toMatchObject({
      requesterId: user,
      status: 'OPEN',
      mode: 'BUY',
      quantity: 1,
      budget: { min: null, max: { amount: 8_000_000, currency: 'BDT' }, flexible: false },
      condition: ['USED'],
      location: { division: 'dhaka', district: 'dhaka', area: 'mirpur' },
      visibility: 'PUBLIC',
      renewals: 0,
      offerCount: 0,
      maxOffers: 50,
    });
    expect(n.history.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'OPEN']);
    // Default TTL 14 days from publication.
    const ttl = Date.parse(n.expiresAt) - Date.parse(n.publishedAt);
    expect(ttl).toBe(14 * 86_400_000);

    const events = await outbox(n.id);
    // Same transaction, same millisecond: the outbox has no intra-transaction order.
    expect(events.map((e) => e.type).sort()).toEqual([
      'demand.NeedPublished',
      'demand.NeedStatusChanged',
    ]);
    const byType = (type: string) => events.find((e) => e.type === type)!.payload;
    const published = DemandEvents.NeedPublished.schema.parse(byType('demand.NeedPublished'));
    expect(published).toMatchObject({
      needId: n.id,
      requesterId: user,
      categoryId: cat,
      budgetMax: { amount: 8_000_000, currency: 'BDT' },
      district: 'dhaka',
      attributes: { brand: 'Apple', storageGb: 256 },
      maxOffers: 50,
    });
    expect(
      DemandEvents.NeedStatusChanged.schema.parse(byType('demand.NeedStatusChanged')),
    ).toMatchObject({
      from: 'DRAFT',
      to: 'OPEN',
    });
    expect(verification.calls.at(-1)).toMatchObject({
      accountId: user,
      action: 'NEED_PUBLISH',
      categoryId: cat,
      mode: 'BUY',
      amount: 8_000_000,
    });
  });

  it('saves a draft without verification and honours a shorter requested expiry at publish', async () => {
    const cat = await seedCategory(t);
    const user = randomUUID();
    const calls = verification.calls.length;
    const res = await post(user, needBody(cat, { publish: false, expiresInDays: 3 }));
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({ status: 'DRAFT', expiresAt: null, publishedAt: null });
    expect(verification.calls.length).toBe(calls);
    expect(await outbox(res.json().data.id)).toEqual([]);

    const pub = await command(user, res.json().data.id, 'publish');
    expect(pub.statusCode).toBe(200);
    const n = pub.json().data;
    expect(Date.parse(n.expiresAt) - Date.parse(n.publishedAt)).toBe(3 * 86_400_000);
    expect((await command(user, n.id, 'publish')).statusCode).toBe(409);
  });

  it('refuses a missing, inactive or mode-incompatible category', async () => {
    const user = randomUUID();
    const missing = await post(user, needBody(randomUUID()));
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.details.rule).toBe('CATEGORY_UNAVAILABLE');

    const inactive = await seedCategory(t, { active: false });
    expect((await post(user, needBody(inactive))).json().error.details.rule).toBe(
      'CATEGORY_UNAVAILABLE',
    );

    const buyOnly = await seedCategory(t, { modes: ['BUY'] });
    const rent = await post(
      user,
      needBody(buyOnly, {
        mode: 'RENT',
        modeTerms: { startAt: '2026-11-01T09:00:00Z', endAt: '2026-11-03T09:00:00Z' },
      }),
    );
    expect(rent.statusCode).toBe(422);
    expect(rent.json().error.details.rule).toBe('MODE_NOT_ALLOWED');
  });

  it('refuses invalid attributes and mode terms', async () => {
    const cat = await seedCategory(t);
    const user = randomUUID();
    const attrs = await post(
      user,
      needBody(cat, { attributes: { brand: 'Apple', colour: 'red' } }),
    );
    expect(attrs.statusCode).toBe(422);
    expect(attrs.json().error.details).toMatchObject({
      rule: 'INVALID_ATTRIBUTES',
      issues: [{ path: 'colour', message: 'unknown attribute' }],
    });

    const terms = await post(
      user,
      needBody(cat, {
        mode: 'BORROW',
        modeTerms: { startAt: '2026-11-03T09:00:00Z', returnBy: '2026-11-01T09:00:00Z' },
      }),
    );
    expect(terms.statusCode).toBe(422);
    expect(terms.json().error.details).toMatchObject({
      rule: 'INVALID_MODE_TERMS',
      mode: 'BORROW',
    });

    const hire = await post(
      user,
      needBody(cat, { mode: 'HIRE', modeTerms: { acceptsUsed: true } }),
    );
    expect(hire.json().error.details.rule).toBe('INVALID_MODE_TERMS');

    const past = await post(user, needBody(cat, { requiredBy: '2020-01-01' }));
    expect(past.json().error.details.rule).toBe('REQUIRED_BY_IN_PAST');

    const budget = await post(
      user,
      needBody(cat, {
        budget: {
          min: { amount: 9_000_000, currency: 'BDT' },
          max: { amount: 1, currency: 'BDT' },
        },
      }),
    );
    expect(budget.json().error.details.rule).toBe('BUDGET_RANGE');

    // Schema-level: unknown fields and bad values are 400.
    expect((await post(user, needBody(cat, { status: 'OPEN' }))).statusCode).toBe(400);
    expect((await post(user, needBody(cat, { title: 'abc' }))).statusCode).toBe(400);
    expect((await post(user, needBody(cat, { quantity: 0 }))).statusCode).toBe(400);
  });

  it('refuses phone numbers and emails in public text', async () => {
    const cat = await seedCategory(t);
    const user = randomUUID();
    const title = await post(user, needBody(cat, { title: 'Need iPhone call 01712345678' }));
    expect(title.statusCode).toBe(422);
    expect(title.json().error.details).toMatchObject({ rule: 'NO_CONTACT_INFO', field: 'title' });
    const desc = await post(user, needBody(cat, { description: 'email me at x@y.com' }));
    expect(desc.json().error.details).toMatchObject({
      rule: 'NO_CONTACT_INFO',
      field: 'description',
    });
  });

  it('enforces the open-need limit per requester', async () => {
    const cat = await seedCategory(t);
    const user = randomUUID();
    for (let i = 0; i < 3; i++) expect((await post(user, needBody(cat))).statusCode).toBe(201);
    const fourth = await post(user, needBody(cat));
    expect(fourth.statusCode).toBe(422);
    expect(fourth.json().error.details).toMatchObject({ rule: 'OPEN_NEED_LIMIT', limit: 3 });
    // Drafts do not count; another user is unaffected.
    expect((await post(user, needBody(cat, { publish: false }))).statusCode).toBe(201);
    expect((await post(randomUUID(), needBody(cat))).statusCode).toBe(201);
  });

  it('requires verification when policy says so and fails closed when it cannot be checked', async () => {
    const cat = await seedCategory(t);
    const user = randomUUID();
    verification.mode = 'missing';
    const missing = await post(user, needBody(cat));
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      details: { missing: ['NID'] },
    });

    verification.mode = 'down';
    const down = await post(user, needBody(cat));
    expect(down.statusCode).toBe(503);
    expect(down.headers['retry-after']).toBe('5');

    // Nothing was created by the refused requests.
    const mine = await app().inject({ url: '/api/v1/me/needs', headers: await t.auth.as(user) });
    expect(mine.json().data).toEqual([]);
  });

  it('requires authentication and the need:create permission', async () => {
    const cat = await seedCategory(t);
    expect(
      (await app().inject({ method: 'POST', url: '/api/v1/needs', payload: needBody(cat) }))
        .statusCode,
    ).toBe(401);
    const mod = await app().inject({
      method: 'POST',
      url: '/api/v1/needs',
      headers: await t.auth.as(randomUUID(), ['MODERATOR']),
      payload: needBody(cat),
    });
    expect(mod.statusCode).toBe(403);
  });
});

describe('GET /api/v1/needs/:id', () => {
  it('shows drafts only to their owner (others get 404) and hides private fields', async () => {
    const cat = await seedCategory(t);
    const owner = randomUUID();
    const draft = (await post(owner, needBody(cat, { publish: false }))).json().data;
    const url = `/api/v1/needs/${draft.id}`;

    expect((await app().inject({ url })).statusCode).toBe(404);
    expect((await app().inject({ url, headers: await t.auth.as(randomUUID()) })).statusCode).toBe(
      404,
    );
    const mine = await app().inject({ url, headers: await t.auth.as(owner) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data).toMatchObject({ status: 'DRAFT', visibility: 'PUBLIC', renewals: 0 });

    await command(owner, draft.id, 'publish');
    const pub = (await app().inject({ url })).json().data;
    expect(pub.status).toBe('OPEN');
    for (const k of ['visibility', 'renewals', 'version', 'history'])
      expect(pub).not.toHaveProperty(k);
  });

  it('rejects an invalid token even on public reads, and 404s unknown ids', async () => {
    const res = await app().inject({
      url: `/api/v1/needs/${randomUUID()}`,
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.statusCode).toBe(401);
    expect((await app().inject({ url: `/api/v1/needs/${randomUUID()}` })).statusCode).toBe(404);
  });

  it('shows MATCHED_ONLY needs to matched sellers only, and keeps them out of the feed', async () => {
    const cat = await seedCategory(t);
    const owner = randomUUID();
    const n = (await post(owner, needBody(cat, { visibility: 'MATCHED_ONLY' }))).json().data;
    const seller = randomUUID();
    const url = `/api/v1/needs/${n.id}`;
    expect((await app().inject({ url, headers: await t.auth.as(seller) })).statusCode).toBe(404);
    await t.svc.runtime.deliver(
      envelope(MatchingEvents.MatchFound, {
        matchId: randomUUID(),
        needId: n.id,
        requesterId: owner,
        sellerId: seller,
        listingId: null,
        score: 0.9,
      }),
    );
    expect((await app().inject({ url, headers: await t.auth.as(seller) })).statusCode).toBe(200);
    const feed = await app().inject({ url: `/api/v1/needs?categoryId=${cat}` });
    expect(feed.json().data).toEqual([]);
  });
});

describe('GET /api/v1/needs (feed)', () => {
  it('filters by category (incl. children), mode, district, budget and text', async () => {
    const parent = await seedCategory(t);
    const child = await seedCategory(t, { parentId: parent });
    const other = await seedCategory(t);
    const u = randomUUID();
    const a = (await post(u, needBody(parent, { title: 'Samsung Galaxy S24 wanted' }))).json().data;
    const b = (
      await post(
        u,
        needBody(child, {
          mode: 'RENT',
          title: 'Rent a DSLR camera',
          modeTerms: { startAt: '2026-11-01T09:00:00Z', endAt: '2026-11-03T09:00:00Z' },
          location: { district: 'chattogram' },
          budget: { max: { amount: 500_000, currency: 'BDT' } },
        }),
      )
    ).json().data;
    await post(u, needBody(other));
    await post(randomUUID(), needBody(parent, { publish: false })); // drafts never in the feed

    // Order is covered by the pagination test; here only membership matters.
    const ids = async (qs: string) =>
      (await app().inject({ url: `/api/v1/needs?${qs}` }))
        .json()
        .data.map((n: { id: string }) => n.id)
        .sort();

    expect(await ids(`categoryId=${parent}`)).toEqual([a.id, b.id].sort());
    expect(await ids(`categoryId=${child}`)).toEqual([b.id]);
    expect(await ids(`categoryId=${parent}&mode=RENT`)).toEqual([b.id]);
    expect(await ids(`categoryId=${parent}&district=dhaka`)).toEqual([a.id]);
    expect(await ids(`categoryId=${parent}&budgetMaxAtLeast=1000000`)).toEqual([a.id]);
    expect(await ids(`categoryId=${parent}&q=dslr`)).toEqual([b.id]);
    expect(await ids(`categoryId=${parent}&q=galaxy`)).toEqual([a.id]);

    await command(u, a.id, 'pause');
    expect(await ids(`categoryId=${parent}`)).toEqual([b.id]);

    expect((await app().inject({ url: '/api/v1/needs?district=atlantis' })).statusCode).toBe(400);
    expect((await app().inject({ url: '/api/v1/needs?cursor=garbage' })).statusCode).toBe(400);
  });

  it('paginates newest first with a keyset cursor, without duplicates or gaps', async () => {
    const cat = await seedCategory(t);
    const created: string[] = [];
    for (let i = 0; i < 7; i++) {
      created.push(
        (await post(randomUUID(), needBody(cat, { title: `Need number ${i}` }))).json().data.id,
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Awaited<ReturnType<ReturnType<typeof app>['inject']>> = await app().inject({
        url: `/api/v1/needs?categoryId=${cat}&limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      });
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().data.map((n: { id: string }) => n.id));
      cursor = res.json().page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    // Same as one big page (newest first), and exactly the created set.
    const all = await app().inject({ url: `/api/v1/needs?categoryId=${cat}&limit=100` });
    const allIds = all.json().data.map((n: { id: string; publishedAt: string }) => n.id);
    expect(seen).toEqual(allIds);
    expect([...seen].sort()).toEqual([...created].sort());
    const times = all.json().data.map((n: { publishedAt: string }) => Date.parse(n.publishedAt));
    expect(times).toEqual([...times].sort((x: number, y: number) => y - x));
  });
});

describe('GET /api/v1/me/needs', () => {
  it('lists only my needs, filtered by status, with pagination', async () => {
    const cat = await seedCategory(t);
    const me = randomUUID();
    const ids = [];
    for (let i = 0; i < 3; i++)
      ids.push((await post(me, needBody(cat, { publish: i !== 1 }))).json().data.id);
    await post(randomUUID(), needBody(cat));
    const headers = await t.auth.as(me);

    const all = (await app().inject({ url: '/api/v1/me/needs', headers }))
      .json()
      .data.map((n: { id: string }) => n.id);
    expect([...all].sort()).toEqual([...ids].sort());
    const p1 = await app().inject({ url: '/api/v1/me/needs?limit=2', headers });
    expect(p1.json().data.map((n: { id: string }) => n.id)).toEqual(all.slice(0, 2));
    expect(p1.json().data[0]).toHaveProperty('visibility', 'PUBLIC');
    const p2 = await app().inject({
      url: `/api/v1/me/needs?limit=2&cursor=${p1.json().page.nextCursor}`,
      headers,
    });
    expect(p2.json().data.map((n: { id: string }) => n.id)).toEqual(all.slice(2));
    expect(p2.json().page.nextCursor).toBeNull();

    const drafts = await app().inject({ url: '/api/v1/me/needs?status=DRAFT', headers });
    expect(drafts.json().data.map((n: { id: string }) => n.id)).toEqual([ids[1]]);
    expect((await app().inject({ url: '/api/v1/me/needs' })).statusCode).toBe(401);
  });
});

describe('PATCH /api/v1/needs/:id', () => {
  it('edits an open need, emits NeedUpdated, and refuses non-owners', async () => {
    const cat = await seedCategory(t);
    const owner = randomUUID();
    const n = (await post(owner, needBody(cat))).json().data;
    const patch = (user: string, payload: Record<string, unknown>) =>
      t.auth
        .as(user)
        .then((headers) =>
          app().inject({ method: 'PATCH', url: `/api/v1/needs/${n.id}`, headers, payload }),
        );

    const res = await patch(owner, { title: 'iPhone 15 Pro Max', quantity: 2, description: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      title: 'iPhone 15 Pro Max',
      quantity: 2,
      description: null,
    });
    expect((await outbox(n.id)).map((e) => e.type)).toContain('demand.NeedUpdated');

    expect((await patch(randomUUID(), { title: 'Hijacked title' })).statusCode).toBe(404);
    expect((await patch(owner, {})).statusCode).toBe(400);
    expect((await patch(owner, { title: 'Call 01812345678 now' })).statusCode).toBe(422);
    expect((await patch(owner, { requesterId: randomUUID() })).statusCode).toBe(400);

    await command(owner, n.id, 'close');
    const closed = await patch(owner, { title: 'Too late to edit' });
    expect(closed.statusCode).toBe(409);
  });

  it('does not emit NeedUpdated for drafts', async () => {
    const cat = await seedCategory(t);
    const owner = randomUUID();
    const n = (await post(owner, needBody(cat, { publish: false }))).json().data;
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/v1/needs/${n.id}`,
      headers: await t.auth.as(owner),
      payload: {
        mode: 'HIRE',
        modeTerms: { serviceDate: inFuture(5), skills: ['repair'] },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.mode).toBe('HIRE');
    expect(await outbox(n.id)).toEqual([]);
  });
});

describe('owner commands', () => {
  it('pauses, resumes and closes; refuses invalid transitions and non-owners', async () => {
    const cat = await seedCategory(t);
    const owner = randomUUID();
    const n = (await post(owner, needBody(cat))).json().data;

    expect((await command(randomUUID(), n.id, 'pause')).statusCode).toBe(404);
    expect((await command(owner, n.id, 'resume')).statusCode).toBe(409);
    expect((await command(owner, n.id, 'pause')).json().data.status).toBe('PAUSED');
    expect((await command(owner, n.id, 'pause')).statusCode).toBe(409);
    expect((await command(owner, n.id, 'resume')).json().data.status).toBe('OPEN');
    const closed = await command(owner, n.id, 'close');
    expect(closed.json().data.status).toBe('CLOSED');
    expect(closed.json().data.history.map((h: { to: string }) => h.to)).toEqual([
      'DRAFT',
      'OPEN',
      'PAUSED',
      'OPEN',
      'CLOSED',
    ]);
    expect((await command(owner, n.id, 'resume')).statusCode).toBe(409);
    expect((await command(owner, n.id, 'renew')).statusCode).toBe(409);

    const types = (await outbox(n.id)).map((e) => e.type);
    // publish + resume each emit NeedPublished; every transition emits NeedStatusChanged.
    expect(types.filter((x) => x === 'demand.NeedPublished')).toHaveLength(2);
    expect(types.filter((x) => x === 'demand.NeedStatusChanged')).toHaveLength(4);
  });

  it('serves facts to other services only', async () => {
    const cat = await seedCategory(t);
    const n = (await post(randomUUID(), needBody(cat, { quantity: 3 }))).json().data;
    const url = `/internal/v1/needs/${n.id}`;
    expect((await app().inject({ url })).statusCode).toBe(403);
    const res = await app().inject({ url, headers: { 'x-internal-token': TEST_INTERNAL_TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      id: n.id,
      status: 'OPEN',
      requesterId: n.requesterId,
      mode: 'BUY',
      quantity: 3,
      acceptedQuantity: 0,
      maxOffers: 50,
      offerCount: 0,
      budget: { max: { amount: 8_000_000, currency: 'BDT' } },
    });
    expect(
      (
        await app().inject({
          url: `/internal/v1/needs/${randomUUID()}`,
          headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
        })
      ).statusCode,
    ).toBe(404);
  });
});
