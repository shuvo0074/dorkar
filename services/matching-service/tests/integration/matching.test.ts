import { randomUUID } from 'node:crypto';
import {
  CatalogEvents,
  DemandEvents,
  OfferEvents,
  ProfileEvents,
  ReputationEvents,
  VerificationEvents,
  type District,
} from '@dorkar/contracts';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildMatchingService } from '../../src/app';

let t: TestService<Awaited<ReturnType<typeof buildMatchingService>>>;
const app = () => t.svc.runtime.app;
const deliver = (e: Parameters<typeof t.svc.runtime.deliver>[0]) => t.svc.runtime.deliver(e);

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'matching',
    migrations,
    build: (env, logger, verifier) => buildMatchingService(env, logger, { verifier }),
  });
});
afterAll(() => t.close());

// ---------------------------------------------------------------- event builders

const bdt = (taka: number) => ({ amount: taka * 100, currency: 'BDT' as const });
const inAWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

async function category(parentId: string | null = null): Promise<string> {
  const categoryId = randomUUID();
  await deliver(
    envelope(CatalogEvents.CategoryUpserted, {
      categoryId,
      parentId,
      slug: `c-${categoryId.slice(0, 8)}`,
      nameEn: 'Phones',
      nameBn: 'ফোন',
      modes: ['BUY', 'SOURCE'],
      attributeSchema: { properties: {}, required: [] },
      active: true,
    }),
  );
  return categoryId;
}

async function capabilities(
  accountId: string,
  categoryIds: string[],
  o: Partial<{ districts: District[]; active: boolean; delivers: boolean }> = {},
) {
  await deliver(
    envelope(ProfileEvents.SellerCapabilitiesChanged, {
      accountId,
      roles: ['SELLER'],
      categoryIds,
      serviceDistricts: o.districts ?? ['dhaka'],
      deliveryModes: o.delivers ? ['SELLER_DELIVERY'] : ['BUYER_PICKUP'],
      active: o.active ?? true,
    }),
  );
}

const listingPayload = (
  sellerId: string,
  categoryId: string,
  o: { price?: number; district?: District } = {},
) => ({
  listingId: randomUUID(),
  sellerId,
  categoryId,
  kind: 'PRODUCT' as const,
  condition: 'NEW' as const,
  title: 'Walton Primo',
  price: bdt(o.price ?? 9000),
  priceUnit: 'TOTAL' as const,
  quantityAvailable: 3,
  district: o.district ?? ('dhaka' as const),
  attributes: { brand: 'Walton' },
  deliveryModes: ['BUYER_PICKUP' as const],
});

async function listing(
  sellerId: string,
  categoryId: string,
  o: { price?: number; district?: District } = {},
) {
  const p = listingPayload(sellerId, categoryId, o);
  await deliver(envelope(CatalogEvents.ListingPublished, p));
  return p.listingId;
}

const needPayload = (
  requesterId: string,
  categoryId: string,
  o: Partial<{ budgetMax: number; district: District; needId: string }> = {},
) => ({
  needId: o.needId ?? randomUUID(),
  requesterId,
  mode: 'BUY' as const,
  categoryId,
  title: 'Need a phone under 10k',
  quantity: 1,
  budgetMin: null,
  budgetMax: bdt(o.budgetMax ?? 10_000),
  conditions: ['NEW' as const],
  district: o.district ?? ('dhaka' as const),
  attributes: { brand: 'Walton' },
  requiredBy: null,
  expiresAt: inAWeek(),
  maxOffers: 10,
});

async function need(
  requesterId: string,
  categoryId: string,
  o: Parameters<typeof needPayload>[2] = {},
) {
  const p = needPayload(requesterId, categoryId, o);
  await deliver(envelope(DemandEvents.NeedPublished, p));
  return p.needId;
}

// ---------------------------------------------------------------- probes

const matchRows = (needId: string) =>
  t.svc.runtime.db
    .selectFrom('matches')
    .selectAll()
    .where('need_id', '=', needId)
    .orderBy('seller_id')
    .execute();

async function matchFound(needId: string) {
  const rows = await t.svc.runtime.db
    .selectFrom('outbox')
    .select(['payload', 'aggregate_id'])
    .where('type', '=', 'matching.MatchFound')
    .execute();
  return rows
    .map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload))
    .filter((p: { needId: string }) => p.needId === needId);
}

const getMatches = async (needId: string, as: string, qs = '') =>
  app().inject({ url: `/api/v1/needs/${needId}/matches${qs}`, headers: await t.auth.as(as) });

const getFeed = async (as: string, qs = '') =>
  app().inject({ url: `/api/v1/me/matched-needs${qs}`, headers: await t.auth.as(as) });

const dismiss = async (matchId: string, as: string) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/me/matched-needs/${matchId}/dismiss`,
    headers: await t.auth.as(as),
  });

// ---------------------------------------------------------------- tests

describe('matching a new need', () => {
  it('matches capable sellers and listings, excludes the requester, emits MatchFound', async () => {
    const cat = await category();
    const buyer = randomUUID();
    const capSeller = randomUUID();
    const shop = randomUUID();
    const farAway = randomUUID();
    await capabilities(capSeller, [cat]);
    const shopListing = await listing(shop, cat);
    await listing(buyer, cat); // the requester's own listing
    await capabilities(farAway, [cat], { districts: ['sylhet'] }); // out of reach

    const needId = await need(buyer, cat);

    const rows = await matchRows(needId);
    expect(rows.map((r) => r.seller_id).sort()).toEqual([capSeller, shop].sort());
    const byS = new Map(rows.map((r) => [r.seller_id, r]));
    expect(byS.get(shop)).toMatchObject({
      candidate_type: 'LISTING',
      listing_id: shopListing,
      status: 'NEW',
      scorer: 'rules@v1',
    });
    // 30 category + 25 district + 20 budget + 10 condition + 10 attributes
    expect(Number(byS.get(shop)!.score)).toBe(95);
    expect(byS.get(capSeller)).toMatchObject({ candidate_type: 'SELLER', listing_id: null });
    expect(Number(byS.get(capSeller)!.score)).toBe(55);

    const events = await matchFound(needId);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.sellerId === shop)).toMatchObject({
      needId,
      requesterId: buyer,
      listingId: shopListing,
      score: 95,
    });

    const res = await getMatches(needId, buyer);
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      score: number;
      reasons: Record<string, number>;
      sellerId: string;
    }[];
    expect(data.map((d) => d.sellerId)).toEqual([shop, capSeller]);
    for (const d of data) {
      const sum = Object.values(d.reasons).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(d.score, 6);
    }
    expect(data[0]!.reasons).toMatchObject({ category: 30, location: 25, budget: 20 });
  });

  it('keeps one match per seller: their best candidate', async () => {
    const cat = await category();
    const seller = randomUUID();
    await capabilities(seller, [cat]);
    const cheap = await listing(seller, cat, { price: 9000 });
    await listing(seller, cat, { price: 11_500 }); // over budget → fewer points
    const needId = await need(randomUUID(), cat);
    const rows = await matchRows(needId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ candidate_type: 'LISTING', listing_id: cheap });
    expect(await matchFound(needId)).toHaveLength(1);
  });

  it('matches related categories (parent/child) with fewer points and applies the minimum score', async () => {
    const parent = await category();
    const child = await category(parent);
    const parentSeller = randomUUID();
    const weak = randomUUID();
    await capabilities(parentSeller, [parent]);
    // related (18) + delivers from another division (8) = 26 < 40
    await capabilities(weak, [parent], { districts: ['sylhet'], delivers: true });
    const needId = await need(randomUUID(), child);
    const rows = await matchRows(needId);
    expect(rows.map((r) => r.seller_id)).toEqual([parentSeller]);
    expect(rows[0]!.reasons).toMatchObject({ category: 18, location: 25 });
  });

  it('uses reputation and verification signals', async () => {
    const cat = await category();
    const seller = randomUUID();
    await capabilities(seller, [cat]);
    await deliver(
      envelope(ReputationEvents.ReputationUpdated, {
        accountId: seller,
        ratingAverage: 5,
        ratingCount: 4,
        completedCount: 4,
        cancelledCount: 0,
        disputedCount: 0,
      }),
    );
    await deliver(
      envelope(VerificationEvents.VerificationStatusChanged, {
        accountId: seller,
        kind: 'NID',
        status: 'VERIFIED',
      }),
    );
    const needId = await need(randomUUID(), cat);
    const [row] = await matchRows(needId);
    expect(row!.reasons).toMatchObject({ reputation: 8.2, verification: 5 });
    expect(Number(row!.score)).toBe(68.2);
  });
});

describe('reverse matching', () => {
  it('matches a newly published listing against open needs', async () => {
    const cat = await category();
    const buyer = randomUUID();
    const needId = await need(buyer, cat);
    expect(await matchRows(needId)).toHaveLength(0);

    const shop = randomUUID();
    const l = await listing(shop, cat);
    const rows = await matchRows(needId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seller_id: shop, listing_id: l, candidate_type: 'LISTING' });
    expect(await matchFound(needId)).toHaveLength(1);

    // The requester listing in their own need's category is never matched to it.
    await listing(buyer, cat);
    expect(await matchRows(needId)).toHaveLength(1);
  });

  it('matches a seller who just became active; a later, better listing replaces the capability', async () => {
    const cat = await category();
    const needId = await need(randomUUID(), cat);
    const seller = randomUUID();
    await capabilities(seller, [cat], { active: false });
    expect(await matchRows(needId)).toHaveLength(0);

    await capabilities(seller, [cat]);
    let rows = await matchRows(needId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ candidate_type: 'SELLER', listing_id: null });

    const l = await listing(seller, cat);
    rows = await matchRows(needId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ candidate_type: 'LISTING', listing_id: l });
    expect(await matchFound(needId)).toHaveLength(1); // the seller was announced once
  });

  it('matches a need and a seller/listing that arrive at the same moment on different streams', async () => {
    for (let round = 0; round < 5; round++) {
      const cat = await category();
      const seller = randomUUID();
      const n = needPayload(randomUUID(), cat);
      const l = listingPayload(seller, cat);
      await Promise.all([
        deliver(envelope(DemandEvents.NeedPublished, n)),
        deliver(
          envelope(ProfileEvents.SellerCapabilitiesChanged, {
            accountId: seller,
            roles: ['SELLER'],
            categoryIds: [cat],
            serviceDistricts: ['dhaka'],
            deliveryModes: ['BUYER_PICKUP'],
            active: true,
          }),
        ),
        deliver(envelope(CatalogEvents.ListingPublished, l)),
      ]);
      const rows = await matchRows(n.needId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ seller_id: seller, listing_id: l.listingId });
    }
  });

  it('ignores listings that became unavailable', async () => {
    const cat = await category();
    const shop = randomUUID();
    const p = listingPayload(shop, cat);
    await deliver(envelope(CatalogEvents.ListingPublished, p));
    await deliver(
      envelope(CatalogEvents.ListingUnavailable, {
        listingId: p.listingId,
        sellerId: shop,
        reason: 'SOLD_OUT',
      }),
    );
    expect(await matchRows(await need(randomUUID(), cat))).toHaveLength(0);
  });

  it('skips needs in other divisions for sellers that do not deliver', async () => {
    const cat = await category();
    const needId = await need(randomUUID(), cat, { district: 'sylhet' });
    await listing(randomUUID(), cat, { district: 'dhaka' });
    expect(await matchRows(needId)).toHaveLength(0);
  });
});

describe('re-scoring and lifecycle', () => {
  it('NeedUpdated re-scores without duplicating matches or events; redelivery is a no-op', async () => {
    const cat = await category();
    const buyer = randomUUID();
    const shop = randomUUID();
    await listing(shop, cat, { price: 10_500 });
    const p = needPayload(buyer, cat, { budgetMax: 10_000 });
    await deliver(envelope(DemandEvents.NeedPublished, p));
    expect(Number((await matchRows(p.needId))[0]!.score)).toBe(85); // within 10% over: budget 10

    const update = envelope(DemandEvents.NeedUpdated, { ...p, budgetMax: bdt(11_000) });
    expect(await deliver(update)).toBe(true);
    expect(await deliver(update)).toBe(false);
    const rows = await matchRows(p.needId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.score)).toBe(95);
    expect(await matchFound(p.needId)).toHaveLength(1);

    // Re-publishing (e.g. after a pause) does not announce again either.
    await deliver(envelope(DemandEvents.NeedPublished, { ...p, budgetMax: bdt(11_000) }));
    expect(await matchFound(p.needId)).toHaveLength(1);
  });

  it('retires matches that stop qualifying on update', async () => {
    const cat = await category();
    const other = await category();
    const shop = randomUUID();
    await listing(shop, cat);
    const p = needPayload(randomUUID(), cat);
    await deliver(envelope(DemandEvents.NeedPublished, p));
    await deliver(envelope(DemandEvents.NeedUpdated, { ...p, categoryId: other }));
    expect((await matchRows(p.needId))[0]!.status).toBe('CLOSED');
  });

  it('closes matches when the need leaves OPEN and reopens them when it returns', async () => {
    const cat = await category();
    const buyer = randomUUID();
    const seller = randomUUID();
    await capabilities(seller, [cat]);
    const p = needPayload(buyer, cat);
    await deliver(envelope(DemandEvents.NeedPublished, p));
    expect((await getFeed(seller)).json().data).toHaveLength(1);

    await deliver(
      envelope(DemandEvents.NeedStatusChanged, {
        needId: p.needId,
        requesterId: buyer,
        from: 'OPEN',
        to: 'PAUSED',
        reason: 'owner',
      }),
    );
    expect((await matchRows(p.needId))[0]!.status).toBe('CLOSED');
    expect((await getFeed(seller)).json().data).toHaveLength(0);

    await deliver(envelope(DemandEvents.NeedPublished, p));
    expect((await matchRows(p.needId))[0]!.status).toBe('NEW');
    expect(await matchFound(p.needId)).toHaveLength(1);
  });

  it('marks the seller’s match RESPONDED when they submit an offer', async () => {
    const cat = await category();
    const buyer = randomUUID();
    const seller = randomUUID();
    await capabilities(seller, [cat]);
    const needId = await need(buyer, cat);
    await deliver(
      envelope(OfferEvents.OfferSubmitted, {
        offerId: randomUUID(),
        needId,
        buyerId: buyer,
        sellerId: seller,
        price: bdt(9000),
        quantity: 1,
      }),
    );
    expect((await matchRows(needId))[0]!.status).toBe('RESPONDED');
    const feed = (await getFeed(seller)).json().data;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ status: 'RESPONDED', need: { id: needId } });
  });
});

describe('access', () => {
  it('shows a need’s matches only to its requester', async () => {
    const cat = await category();
    const buyer = randomUUID();
    const seller = randomUUID();
    await capabilities(seller, [cat]);
    const needId = await need(buyer, cat);
    expect((await getMatches(needId, buyer)).statusCode).toBe(200);
    expect((await getMatches(needId, seller)).statusCode).toBe(404);
    expect((await getMatches(randomUUID(), buyer)).statusCode).toBe(404);
    expect((await app().inject({ url: `/api/v1/needs/${needId}/matches` })).statusCode).toBe(401);
    expect((await getMatches('not-a-uuid', buyer)).statusCode).toBe(400);
  });

  it('serves the seller feed with need facts, never other sellers’ matches', async () => {
    const cat = await category();
    const seller = randomUUID();
    await capabilities(seller, [cat]);
    const needId = await need(randomUUID(), cat, { budgetMax: 12_000, district: 'gazipur' });
    const res = await getFeed(seller);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      expect.objectContaining({
        status: 'NEW',
        score: 42, // 30 category + 12 same division
        listingId: null,
        need: expect.objectContaining({
          id: needId,
          title: 'Need a phone under 10k',
          mode: 'BUY',
          district: 'gazipur',
          budget: { min: null, max: bdt(12_000) },
        }),
      }),
    ]);
    expect(res.json().data[0].need).not.toHaveProperty('requesterId');
    expect((await getFeed(randomUUID())).json().data).toEqual([]);
  });

  it('lets only the matched seller dismiss; idempotent; responded matches cannot be dismissed', async () => {
    const cat = await category();
    const buyer = randomUUID();
    const seller = randomUUID();
    await capabilities(seller, [cat]);
    const needId = await need(buyer, cat);
    const [m] = await matchRows(needId);

    expect((await dismiss(m!.id, buyer)).statusCode).toBe(404);
    expect((await dismiss(randomUUID(), seller)).statusCode).toBe(404);
    expect((await dismiss(m!.id, seller)).statusCode).toBe(204);
    expect((await dismiss(m!.id, seller)).statusCode).toBe(204);
    expect((await matchRows(needId))[0]!.status).toBe('DISMISSED');
    expect((await getFeed(seller)).json().data).toHaveLength(0);

    // A dismissed match stays dismissed when the need is re-scored.
    await deliver(envelope(DemandEvents.NeedUpdated, needPayload(buyer, cat, { needId })));
    expect((await matchRows(needId))[0]!.status).toBe('DISMISSED');

    const needId2 = await need(buyer, cat);
    const [m2] = await matchRows(needId2);
    await deliver(
      envelope(OfferEvents.OfferSubmitted, {
        offerId: randomUUID(),
        needId: needId2,
        buyerId: buyer,
        sellerId: seller,
        price: bdt(9000),
        quantity: 1,
      }),
    );
    const res = await dismiss(m2!.id, seller);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('pagination', () => {
  it('pages a need’s matches by score then id', async () => {
    const cat = await category();
    const buyer = randomUUID();
    const sellers = [randomUUID(), randomUUID(), randomUUID()];
    await capabilities(sellers[0]!, [cat]); // 55
    await capabilities(sellers[1]!, [cat], { districts: ['gazipur'] }); // 42
    await listing(sellers[2]!, cat); // 95
    const needId = await need(buyer, cat);

    const p1 = (await getMatches(needId, buyer, '?limit=2')).json();
    expect(p1.data.map((d: { score: number }) => d.score)).toEqual([95, 55]);
    expect(p1.page.nextCursor).toEqual(expect.any(String));
    const p2 = (await getMatches(needId, buyer, `?limit=2&cursor=${p1.page.nextCursor}`)).json();
    expect(p2.data.map((d: { score: number }) => d.score)).toEqual([42]);
    expect(p2.page.nextCursor).toBeNull();

    expect((await getMatches(needId, buyer, '?cursor=garbage')).statusCode).toBe(400);
  });

  it('pages the seller feed newest first without gaps or repeats', async () => {
    const cat = await category();
    const seller = randomUUID();
    await capabilities(seller, [cat]);
    const needs: string[] = [];
    for (let i = 0; i < 5; i++) needs.push(await need(randomUUID(), cat));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const body = (await getFeed(seller, qs)).json();
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((d: { need: { id: string } }) => d.need.id));
      cursor = body.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([...needs].reverse());
    // A score-ordered cursor is not valid for the date-ordered feed.
    const scoreCursor = Buffer.from(JSON.stringify([55, randomUUID()])).toString('base64url');
    expect((await getFeed(seller, `?cursor=${scoreCursor}`)).statusCode).toBe(400);
  });
});
