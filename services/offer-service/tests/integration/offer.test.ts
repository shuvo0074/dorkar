import { randomUUID } from 'node:crypto';
import {
  CatalogEvents,
  DemandEvents,
  ModerationEvents,
  OfferEvents,
  TransactionEvents,
  type NeedMode,
} from '@dorkar/contracts';
import { createInternalClient, createLogger, Errors } from '@dorkar/kernel';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildOfferService } from '../../src/app';
import type { ProfileDirectory, VerificationGateway } from '../../src/application/ports';
import {
  httpProfileDirectory,
  httpVerificationGateway,
} from '../../src/infrastructure/http-gateways';
import { pgOfferStore } from '../../src/infrastructure/pg-offer-store';

let t: TestService<Awaited<ReturnType<typeof buildOfferService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

let verificationMode: 'ok' | 'deny' | 'down' = 'ok';
let profilesUp = true;
const verification: VerificationGateway = {
  async evaluate() {
    if (verificationMode === 'down') throw Errors.unavailable('Verification is down.');
    return verificationMode === 'ok'
      ? { satisfied: true, missing: [] }
      : { satisfied: false, missing: ['NID'] };
  },
};
const profiles: ProfileDirectory = {
  async displayNames(ids) {
    return new Map(profilesUp ? ids.map((id) => [id, `Seller ${id.slice(0, 4)}`]) : []);
  },
};

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'offer',
    migrations,
    env: { OFFER_MAX_ROUNDS: '5' },
    build: (env, logger, verifier) =>
      buildOfferService(env, logger, { verifier, verification, profiles }),
  });
});
afterAll(() => t.close());
beforeEach(() => {
  verificationMode = 'ok';
  profilesUp = true;
});

// ---------------------------------------------------------------- helpers

const inFuture = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

async function publishNeed(
  over: Partial<{
    requesterId: string;
    quantity: number;
    maxOffers: number;
    mode: NeedMode;
    expiresAt: string;
  }> = {},
) {
  const needId = randomUUID();
  const requesterId: string = over.requesterId ?? randomUUID();
  await t.svc.runtime.deliver(
    envelope(DemandEvents.NeedPublished, {
      needId,
      requesterId,
      mode: over.mode ?? 'BUY',
      categoryId: randomUUID(),
      title: 'Used iPhone 13',
      quantity: over.quantity ?? 1,
      budgetMin: null,
      budgetMax: { amount: 6_000_000, currency: 'BDT' },
      conditions: ['USED'],
      district: 'dhaka',
      attributes: {},
      requiredBy: null,
      expiresAt: over.expiresAt ?? inFuture(10),
      maxOffers: over.maxOffers ?? 10,
    }),
  );
  return { needId, buyerId: requesterId };
}

const offerBody = (over: Record<string, unknown> = {}) => ({
  price: { amount: 5_500_000, currency: 'BDT' },
  quantity: 1,
  condition: 'USED',
  deliveryTerms: { method: 'SELLER_DELIVERY', feeAmount: 10_000, etaDays: 2 },
  modeTerms: { warrantyMonths: 3 },
  description: 'Battery 89%, original box',
  ...over,
});

async function headers(id: string, key: string | null = randomUUID(), roles?: string[]) {
  return {
    ...(await t.auth.as(id, roles as never)),
    ...(key ? { 'idempotency-key': key } : {}),
  };
}

async function submit(
  needId: string,
  sellerId: string = randomUUID(),
  body: Record<string, unknown> = offerBody(),
) {
  const res = await app().inject({
    method: 'POST',
    url: `/api/v1/needs/${needId}/offers`,
    headers: await headers(sellerId),
    payload: body,
  });
  return { res, sellerId, offer: res.json().data };
}

const act = async (
  offerId: string,
  action: 'accept' | 'reject' | 'withdraw' | 'counter',
  actorId: string,
  payload?: Record<string, unknown>,
  key: string | null = randomUUID(),
) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/offers/${offerId}/${action}`,
    headers: await headers(actorId, key),
    ...(payload ? { payload } : {}),
  });

const counterBody = (amount: number, message?: string) => ({
  price: { amount, currency: 'BDT' },
  quantity: 1,
  ...(message ? { message } : {}),
});

async function events(type: string, filter: (p: Record<string, unknown>) => boolean) {
  const rows = await db()
    .selectFrom('outbox')
    .select(['type', 'payload'])
    .where('type', '=', type)
    .orderBy('occurred_at')
    .execute();
  return rows.map((r) => r.payload as Record<string, unknown>).filter((p) => filter(p));
}
const forOffer = (id: string) => (p: Record<string, unknown>) => p['offerId'] === id;
const forNeed = (id: string) => (p: Record<string, unknown>) => p['needId'] === id;

const needRow = (needId: string) =>
  db()
    .selectFrom('need_projection')
    .selectAll()
    .where('need_id', '=', needId)
    .executeTakeFirstOrThrow();

const getOffer = async (id: string, actorId: string) =>
  app().inject({ url: `/api/v1/offers/${id}`, headers: await t.auth.as(actorId) });

// ---------------------------------------------------------------- submit

describe('submit', () => {
  it('creates round 1, awaits the buyer, and publishes a valid OfferSubmitted', async () => {
    const { needId, buyerId } = await publishNeed();
    const { res, sellerId, offer } = await submit(needId);
    expect(res.statusCode).toBe(201);
    expect(offer).toMatchObject({
      needId,
      buyerId,
      sellerId,
      status: 'SUBMITTED',
      awaiting: 'BUYER',
      currentRound: 1,
      price: { amount: 5_500_000, currency: 'BDT' },
      modeTerms: { warrantyMonths: 3 },
      actions: ['WITHDRAW'],
      hidden: false,
    });
    expect(offer.rounds).toHaveLength(1);
    expect(offer.rounds[0]).toMatchObject({ round: 1, proposedBy: 'SELLER' });
    // Never beyond the default TTL (72h).
    expect(new Date(offer.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 72 * 3_600_000);

    const [submitted] = await events('offer.OfferSubmitted', forOffer(offer.id));
    expect(OfferEvents.OfferSubmitted.schema.parse(submitted)).toEqual({
      offerId: offer.id,
      needId,
      buyerId,
      sellerId,
      price: { amount: 5_500_000, currency: 'BDT' },
      quantity: 1,
    });

    const asBuyer = await getOffer(offer.id, buyerId);
    expect(asBuyer.json().data.actions).toEqual(['ACCEPT', 'COUNTER', 'REJECT']);
  });

  it('requires an Idempotency-Key and the offer:create permission', async () => {
    const { needId } = await publishNeed();
    const noKey = await app().inject({
      method: 'POST',
      url: `/api/v1/needs/${needId}/offers`,
      headers: await headers(randomUUID(), null),
      payload: offerBody(),
    });
    expect(noKey.statusCode).toBe(400);
    const support = await app().inject({
      method: 'POST',
      url: `/api/v1/needs/${needId}/offers`,
      headers: await headers(randomUUID(), randomUUID(), ['SUPPORT']),
      payload: offerBody(),
    });
    expect(support.statusCode).toBe(403);
  });

  it('refuses a need that is not open, expired, unknown or your own', async () => {
    const paused = await publishNeed();
    await t.svc.runtime.deliver(
      envelope(DemandEvents.NeedStatusChanged, {
        needId: paused.needId,
        requesterId: paused.buyerId,
        from: 'OPEN',
        to: 'PAUSED',
        reason: 'owner',
      }),
    );
    expect((await submit(paused.needId)).res.json().error.details.rule).toBe('NEED_NOT_OPEN');

    const expired = await publishNeed({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await submit(expired.needId)).res.json().error.details.rule).toBe('NEED_EXPIRED');

    expect((await submit(randomUUID())).res.statusCode).toBe(404);

    const own = await publishNeed();
    const r = (await submit(own.needId, own.buyerId)).res;
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details.rule).toBe('OWN_NEED');
  });

  it('allows one live offer per seller, and a new one after withdrawing', async () => {
    const { needId } = await publishNeed();
    const first = await submit(needId);
    const dup = await submit(needId, first.sellerId);
    expect(dup.res.statusCode).toBe(409);
    expect(dup.res.json().error.details.rule).toBe('DUPLICATE_OFFER');

    expect((await act(first.offer.id, 'withdraw', first.sellerId)).statusCode).toBe(200);
    expect((await submit(needId, first.sellerId)).res.statusCode).toBe(201);
  });

  it('enforces max offers per need and remaining quantity', async () => {
    const { needId } = await publishNeed({ maxOffers: 1, quantity: 2 });
    const tooMany = await submit(needId, randomUUID(), offerBody({ quantity: 3 }));
    expect(tooMany.res.json().error.details.rule).toBe('QUANTITY_EXCEEDS_NEED');
    expect((await submit(needId)).res.statusCode).toBe(201);
    const limited = await submit(needId);
    expect(limited.res.statusCode).toBe(422);
    expect(limited.res.json().error.details.rule).toBe('OFFER_LIMIT');
  });

  it('only attaches the seller’s own available listing', async () => {
    const { needId } = await publishNeed();
    const sellerId = randomUUID();
    const listingId = randomUUID();
    const facts = {
      listingId,
      sellerId,
      categoryId: randomUUID(),
      kind: 'PRODUCT' as const,
      condition: 'USED' as const,
      title: 'iPhone 13',
      price: { amount: 5_500_000, currency: 'BDT' as const },
      priceUnit: 'TOTAL' as const,
      quantityAvailable: 1,
      district: 'dhaka' as const,
      attributes: {},
      deliveryModes: ['SELLER_DELIVERY' as const],
    };
    await t.svc.runtime.deliver(envelope(CatalogEvents.ListingPublished, facts));

    const foreign = await submit(needId, randomUUID(), offerBody({ listingId }));
    expect(foreign.res.json().error.details.rule).toBe('LISTING_NOT_OWNED');

    await t.svc.runtime.deliver(
      envelope(CatalogEvents.ListingUnavailable, { listingId, sellerId, reason: 'PAUSED' }),
    );
    const paused = await submit(needId, sellerId, offerBody({ listingId }));
    expect(paused.res.json().error.details.rule).toBe('LISTING_UNAVAILABLE');

    await t.svc.runtime.deliver(envelope(CatalogEvents.ListingUpdated, facts));
    const ok = await submit(needId, sellerId, offerBody({ listingId }));
    expect(ok.res.statusCode).toBe(201);
    expect(ok.offer.listingId).toBe(listingId);
  });

  it('validates text and mode terms against the need', async () => {
    const { needId } = await publishNeed({ mode: 'RENT' });
    const phone = await submit(
      needId,
      randomUUID(),
      offerBody({ description: 'call 017-1234-5678', modeTerms: undefined }),
    );
    expect(phone.res.statusCode).toBe(422);
    expect(phone.res.json().error.details).toMatchObject({
      rule: 'NO_CONTACT_INFO',
      field: 'description',
    });

    const wrongShape = await submit(needId); // BUY terms on a RENT need
    expect(wrongShape.res.statusCode).toBe(400);
    expect(wrongShape.res.json().error.details).toMatchObject({ field: 'modeTerms', mode: 'RENT' });

    const rent = await submit(
      needId,
      randomUUID(),
      offerBody({
        modeTerms: { startAt: inFuture(1), endAt: inFuture(3), depositAmount: 100_000 },
      }),
    );
    expect(rent.res.statusCode).toBe(201);

    const unknownField = await submit(needId, randomUUID(), offerBody({ sneaky: true }));
    expect(unknownField.res.statusCode).toBe(400);
  });

  it('fails closed on verification: unsatisfied → 403, unavailable → 503', async () => {
    const { needId } = await publishNeed();
    verificationMode = 'deny';
    const denied = await submit(needId);
    expect(denied.res.statusCode).toBe(403);
    expect(denied.res.json().error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      details: { missing: ['NID'] },
    });
    verificationMode = 'down';
    expect((await submit(needId)).res.statusCode).toBe(503);
    const count = await db()
      .selectFrom('offers')
      .select('id')
      .where('need_id', '=', needId)
      .execute();
    expect(count).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- negotiation

describe('negotiation', () => {
  it('alternates turns, keeps immutable rounds, caps rounds, and accepts the final terms', async () => {
    const { needId, buyerId } = await publishNeed();
    const { offer, sellerId } = await submit(needId);

    // Seller cannot counter their own proposal.
    const outOfTurn = await act(offer.id, 'counter', sellerId, counterBody(5_400_000));
    expect(outOfTurn.statusCode).toBe(409);
    expect(outOfTurn.json().error.details.reason).toBe('NOT_YOUR_TURN');

    const r2 = await act(offer.id, 'counter', buyerId, counterBody(5_000_000, 'Can you do 50k?'));
    expect(r2.statusCode).toBe(200);
    expect(r2.json().data).toMatchObject({
      status: 'COUNTERED_BY_BUYER',
      awaiting: 'SELLER',
      currentRound: 2,
      price: { amount: 5_000_000 },
      actions: ['REJECT'],
    });
    expect((await getOffer(offer.id, sellerId)).json().data.actions).toEqual([
      'ACCEPT',
      'COUNTER',
      'WITHDRAW',
    ]);
    // Buyer cannot accept their own counter.
    expect((await act(offer.id, 'accept', buyerId)).statusCode).toBe(409);

    const r3 = await act(offer.id, 'counter', sellerId, {
      ...counterBody(5_300_000),
      deliveryTerms: { method: 'BUYER_PICKUP' },
    });
    expect(r3.json().data).toMatchObject({ status: 'COUNTERED_BY_SELLER', awaiting: 'BUYER' });
    expect((await act(offer.id, 'counter', buyerId, counterBody(5_100_000))).statusCode).toBe(200);
    const r5 = await act(offer.id, 'counter', sellerId, {
      ...counterBody(5_200_000),
      modeTerms: { warrantyMonths: 1 },
    });
    expect(r5.json().data.currentRound).toBe(5);
    expect(r5.json().data.rounds.map((r: { proposedBy: string }) => r.proposedBy)).toEqual([
      'SELLER',
      'BUYER',
      'SELLER',
      'BUYER',
      'SELLER',
    ]);
    expect(r5.json().data.rounds[1].message).toBe('Can you do 50k?');

    const capped = await act(offer.id, 'counter', buyerId, counterBody(5_150_000));
    expect(capped.statusCode).toBe(422);
    expect(capped.json().error.details.rule).toBe('MAX_ROUNDS');
    expect((await getOffer(offer.id, buyerId)).json().data.actions).toEqual(['ACCEPT', 'REJECT']);

    const accepted = await act(offer.id, 'accept', buyerId);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data).toMatchObject({ status: 'ACCEPTED', awaiting: null, actions: [] });

    expect(await events('offer.OfferCountered', forOffer(offer.id))).toHaveLength(4);
    const [acc] = await events('offer.OfferAccepted', forOffer(offer.id));
    expect(OfferEvents.OfferAccepted.schema.parse(acc)).toEqual({
      offerId: offer.id,
      needId,
      buyerId,
      sellerId,
      listingId: null,
      mode: 'BUY',
      price: { amount: 5_200_000, currency: 'BDT' },
      quantity: 1,
      terms: {
        delivery: { method: 'BUYER_PICKUP' },
        mode: { warrantyMonths: 1 },
        condition: 'USED',
        availabilityFrom: null,
      },
    });
    const audit = await db()
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', offer.id)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['offer.submit', 'offer.counter', 'offer.accept']),
    );
  });

  it('lets the seller accept a buyer counter (the awaited party accepts)', async () => {
    const { needId, buyerId } = await publishNeed();
    const { offer, sellerId } = await submit(needId);
    await act(offer.id, 'counter', buyerId, counterBody(5_000_000));
    const res = await act(offer.id, 'accept', sellerId);
    expect(res.statusCode).toBe(200);
    const [acc] = await events('offer.OfferAccepted', forOffer(offer.id));
    expect(acc).toMatchObject({ price: { amount: 5_000_000 } });
  });

  it('lets the buyer reject and the seller withdraw, each only their own move', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 2 });
    const a = await submit(needId);
    const b = await submit(needId);
    expect((await act(a.offer.id, 'reject', a.sellerId)).statusCode).toBe(403);
    expect((await act(b.offer.id, 'withdraw', buyerId)).statusCode).toBe(403);

    const rejected = await act(a.offer.id, 'reject', buyerId);
    expect(rejected.json().data).toMatchObject({ status: 'REJECTED', actions: [] });
    const withdrawn = await act(b.offer.id, 'withdraw', b.sellerId);
    expect(withdrawn.json().data.status).toBe('WITHDRAWN');
    expect((await act(a.offer.id, 'reject', buyerId)).statusCode).toBe(409);

    const [changed] = await events('offer.OfferStatusChanged', forOffer(a.offer.id));
    expect(changed).toMatchObject({
      from: 'SUBMITTED',
      to: 'REJECTED',
      reason: 'REJECTED_BY_BUYER',
    });
  });

  it('hides everything from non-parties (404, no leaks)', async () => {
    const { needId } = await publishNeed();
    const { offer } = await submit(needId);
    const stranger = randomUUID();
    expect((await getOffer(offer.id, stranger)).statusCode).toBe(404);
    expect((await act(offer.id, 'accept', stranger)).statusCode).toBe(404);
    expect((await act(offer.id, 'counter', stranger, counterBody(1))).statusCode).toBe(404);
    expect((await act(offer.id, 'withdraw', stranger)).statusCode).toBe(404);
    const list = await app().inject({
      url: `/api/v1/needs/${needId}/offers`,
      headers: await t.auth.as(stranger),
    });
    expect(list.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- acceptance

describe('exclusive acceptance', () => {
  it('two simultaneous accepts on a quantity-1 need: exactly one wins', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 1 });
    const a = await submit(needId);
    const b = await submit(needId);

    const [ra, rb] = await Promise.all([
      act(a.offer.id, 'accept', buyerId),
      act(b.offer.id, 'accept', buyerId),
    ]);
    const codes = [ra.statusCode, rb.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    const loser = ra.statusCode === 409 ? ra : rb;
    expect(loser.json().error.code).toBe('NEED_QUANTITY_EXHAUSTED');
    expect(loser.json().error.details.rule).toBe('NEED_QUANTITY_EXHAUSTED');

    expect(await events('offer.OfferAccepted', forNeed(needId))).toHaveLength(1);
    expect((await needRow(needId)).accepted_quantity).toBe(1);
  });

  it('replays the same response for the same Idempotency-Key without a second event', async () => {
    const { needId, buyerId } = await publishNeed();
    const { offer } = await submit(needId);
    const key = randomUUID();
    const first = await act(offer.id, 'accept', buyerId, undefined, key);
    const again = await act(offer.id, 'accept', buyerId, undefined, key);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe(first.body);
    expect(await events('offer.OfferAccepted', forOffer(offer.id))).toHaveLength(1);

    // A different key is a new request: the offer is already accepted.
    expect((await act(offer.id, 'accept', buyerId)).statusCode).toBe(409);
  });

  it('rejects reusing a key for a different request', async () => {
    const { needId, buyerId } = await publishNeed();
    const { offer } = await submit(needId);
    const key = randomUUID();
    expect((await act(offer.id, 'counter', buyerId, counterBody(1_000), key)).statusCode).toBe(200);
    const reused = await act(offer.id, 'counter', buyerId, counterBody(2_000), key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('expires the other live offers once the need is fully accepted', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 2 });
    const a = await submit(needId);
    const b = await submit(needId);
    const c = await submit(needId, randomUUID(), offerBody({ quantity: 2 }));
    expect((await act(c.offer.id, 'accept', buyerId)).statusCode).toBe(200);

    for (const o of [a, b]) {
      const view = await getOffer(o.offer.id, o.sellerId);
      expect(view.json().data).toMatchObject({ status: 'EXPIRED', actions: [] });
      const [changed] = await events('offer.OfferStatusChanged', forOffer(o.offer.id));
      expect(changed).toMatchObject({ to: 'EXPIRED', reason: 'NEED_FULFILLED' });
    }
  });

  it('keeps other offers live while quantity remains', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 2 });
    const a = await submit(needId);
    const b = await submit(needId);
    await act(a.offer.id, 'accept', buyerId);
    expect((await getOffer(b.offer.id, buyerId)).json().data.status).toBe('SUBMITTED');
    expect((await act(b.offer.id, 'accept', buyerId)).statusCode).toBe(200);
    expect((await needRow(needId)).accepted_quantity).toBe(2);
  });

  it('cancels the offer and restores capacity when its transaction is cancelled', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 1 });
    const a = await submit(needId);
    await act(a.offer.id, 'accept', buyerId);
    expect((await needRow(needId)).accepted_quantity).toBe(1);

    const cancelled = envelope(TransactionEvents.TransactionStateChanged, {
      transactionId: randomUUID(),
      needId,
      sourceType: 'OFFER',
      sourceId: a.offer.id,
      buyerId,
      sellerId: a.sellerId,
      from: 'CREATED',
      to: 'CANCELLED',
      actorId: buyerId,
    });
    expect(await t.svc.runtime.deliver(cancelled)).toBe(true);
    expect(await t.svc.runtime.deliver(cancelled)).toBe(false); // redelivery: no double release
    expect((await needRow(needId)).accepted_quantity).toBe(0);
    expect((await getOffer(a.offer.id, buyerId)).json().data.status).toBe('CANCELLED');
    const changes = await events('offer.OfferStatusChanged', forOffer(a.offer.id));
    expect(changes.at(-1)).toMatchObject({
      from: 'ACCEPTED',
      to: 'CANCELLED',
      reason: 'TRANSACTION_CANCELLED',
    });

    // Capacity is back: another seller's offer can now be accepted.
    const b = await submit(needId);
    expect(b.res.statusCode).toBe(201);
    expect((await act(b.offer.id, 'accept', buyerId)).statusCode).toBe(200);
  });

  it('ignores transaction events for listings or non-terminal states', async () => {
    const { needId, buyerId } = await publishNeed();
    const a = await submit(needId);
    await act(a.offer.id, 'accept', buyerId);
    for (const [sourceType, to] of [
      ['LISTING', 'CANCELLED'],
      ['OFFER', 'COMPLETED'],
    ] as const) {
      await t.svc.runtime.deliver(
        envelope(TransactionEvents.TransactionStateChanged, {
          transactionId: randomUUID(),
          needId,
          sourceType,
          sourceId: a.offer.id,
          buyerId,
          sellerId: a.sellerId,
          from: 'DELIVERED',
          to,
          actorId: null,
        }),
      );
    }
    expect((await getOffer(a.offer.id, buyerId)).json().data.status).toBe('ACCEPTED');
  });
});

// ---------------------------------------------------------------- need lifecycle, moderation, expiry

describe('lifecycle from other services', () => {
  it('expires live offers when the need closes, and is idempotent under redelivery', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 3 });
    const a = await submit(needId);
    const b = await submit(needId);
    await act(b.offer.id, 'accept', buyerId);

    const closed = envelope(DemandEvents.NeedStatusChanged, {
      needId,
      requesterId: buyerId,
      from: 'OPEN',
      to: 'CLOSED',
      reason: 'owner',
    });
    expect(await t.svc.runtime.deliver(closed)).toBe(true);
    expect(await t.svc.runtime.deliver(closed)).toBe(false);

    expect((await getOffer(a.offer.id, buyerId)).json().data.status).toBe('EXPIRED');
    expect((await getOffer(b.offer.id, buyerId)).json().data.status).toBe('ACCEPTED');
    const changes = await events('offer.OfferStatusChanged', forOffer(a.offer.id));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ to: 'EXPIRED', reason: 'NEED_CLOSED' });
  });

  it('hides moderated offers from lists and shows parties a placeholder', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 2 });
    const a = await submit(needId);
    await submit(needId);
    await t.svc.runtime.deliver(
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'OFFER',
        targetId: a.offer.id,
        action: 'HIDE',
        reason: 'spam',
        moderatorId: randomUUID(),
      }),
    );
    const list = await app().inject({
      url: `/api/v1/needs/${needId}/offers`,
      headers: await t.auth.as(buyerId),
    });
    expect(list.json().data.map((o: { id: string }) => o.id)).not.toContain(a.offer.id);
    const mine = await app().inject({
      url: '/api/v1/me/offers',
      headers: await t.auth.as(a.sellerId),
    });
    expect(mine.json().data).toHaveLength(0);

    const placeholder = (await getOffer(a.offer.id, buyerId)).json().data;
    expect(placeholder).toMatchObject({ hidden: true, description: null, actions: ['REJECT'] });
    expect((await act(a.offer.id, 'accept', buyerId)).statusCode).toBe(422);

    await t.svc.runtime.deliver(
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'OFFER',
        targetId: a.offer.id,
        action: 'RESTORE',
        reason: 'ok',
        moderatorId: randomUUID(),
      }),
    );
    expect((await getOffer(a.offer.id, buyerId)).json().data.description).toBe(
      'Battery 89%, original box',
    );
  });

  it('expiry job expires live offers past their deadline', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 2 });
    const a = await submit(needId);
    const b = await submit(needId);
    await db()
      .updateTable('offers')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', a.offer.id)
      .execute();
    // Past its deadline, the offer is no longer actionable even before the sweep.
    expect((await getOffer(a.offer.id, buyerId)).json().data.actions).toEqual([]);
    expect((await act(a.offer.id, 'accept', buyerId)).json().error.details.reason).toBe(
      'OFFER_EXPIRED',
    );

    const n = await db()
      .transaction()
      .execute((trx) => t.svc.offers.expireDue(pgOfferStore(trx)));
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await getOffer(a.offer.id, buyerId)).json().data.status).toBe('EXPIRED');
    expect((await getOffer(b.offer.id, buyerId)).json().data.status).toBe('SUBMITTED');
    const [changed] = await events('offer.OfferStatusChanged', forOffer(a.offer.id));
    expect(changed).toMatchObject({ to: 'EXPIRED', reason: 'OFFER_EXPIRED' });
  });
});

// ---------------------------------------------------------------- lists and admin

describe('lists', () => {
  it('compare view sorts by price, paginates by cursor, and includes seller names', async () => {
    const { needId, buyerId } = await publishNeed({ quantity: 1 });
    const prices = [5_300_000, 5_100_000, 5_200_000];
    const ids: string[] = [];
    for (const amount of prices) {
      const { offer } = await submit(
        needId,
        randomUUID(),
        offerBody({ price: { amount, currency: 'BDT' } }),
      );
      ids.push(offer.id);
    }
    const auth = await t.auth.as(buyerId);
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `sort=price_asc&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app().inject({
        url: `/api/v1/needs/${needId}/offers?${qs}`,
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      for (const o of body.data) {
        seen.push(o.price.amount);
        expect(o.sellerDisplayName).toMatch(/^Seller /);
        expect(o.actions).toEqual(['ACCEPT', 'COUNTER', 'REJECT']);
      }
      cursor = body.page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([5_100_000, 5_200_000, 5_300_000]);

    const newest = await app().inject({
      url: `/api/v1/needs/${needId}/offers?sort=newest&limit=2`,
      headers: auth,
    });
    expect(newest.json().data.map((o: { id: string }) => o.id)).toEqual([ids[2], ids[1]]);
    const page2 = await app().inject({
      url: `/api/v1/needs/${needId}/offers?sort=newest&limit=2&cursor=${newest.json().page.nextCursor}`,
      headers: auth,
    });
    expect(page2.json().data.map((o: { id: string }) => o.id)).toEqual([ids[0]]);
    expect(page2.json().page.nextCursor).toBeNull();
  });

  it('fails open when profile names are unavailable', async () => {
    const { needId, buyerId } = await publishNeed();
    await submit(needId);
    profilesUp = false;
    const res = await app().inject({
      url: `/api/v1/needs/${needId}/offers`,
      headers: await t.auth.as(buyerId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].sellerDisplayName).toBeNull();
  });

  it('lists my offers as a seller, filtered by status', async () => {
    const sellerId = randomUUID();
    const n1 = await publishNeed();
    const n2 = await publishNeed();
    const a = await submit(n1.needId, sellerId);
    await submit(n2.needId, sellerId);
    await act(a.offer.id, 'reject', n1.buyerId);
    const auth = await t.auth.as(sellerId);
    const all = await app().inject({ url: '/api/v1/me/offers', headers: auth });
    expect(all.json().data).toHaveLength(2);
    const live = await app().inject({ url: '/api/v1/me/offers?status=SUBMITTED', headers: auth });
    expect(live.json().data).toHaveLength(1);
    expect(live.json().data[0].actions).toEqual(['WITHDRAW']);
  });

  it('serves support staff the full record with history; members are refused', async () => {
    const { needId, buyerId } = await publishNeed();
    const { offer } = await submit(needId);
    await act(offer.id, 'reject', buyerId);
    const url = `/api/v1/admin/offers/${offer.id}`;
    expect((await app().inject({ url, headers: await t.auth.as(buyerId) })).statusCode).toBe(403);
    const res = await app().inject({ url, headers: await t.auth.as(randomUUID(), ['SUPPORT']) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.history.map((h: { to: string }) => h.to)).toEqual([
      'SUBMITTED',
      'REJECTED',
    ]);
    expect(res.json().data.rounds).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- outbound adapters

describe('internal clients', () => {
  const unreachable = createInternalClient({
    baseUrl: 'http://127.0.0.1:9',
    token: 'x'.repeat(32),
    timeoutMs: 300,
  });
  const ctx = { requestId: 'r', correlationId: 'c', ipHash: null, userAgent: null, actor: null };

  it('verification gateway fails closed with 503', async () => {
    const gw = httpVerificationGateway(unreachable);
    await expect(
      gw.evaluate(
        {
          accountId: randomUUID(),
          action: 'OFFER_SUBMIT',
          categoryId: randomUUID(),
          mode: 'BUY',
          amount: 1,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
  });

  it('profile directory fails open with no names', async () => {
    const dir = httpProfileDirectory(
      unreachable,
      createLogger({ service: 't', version: 't', env: 'test', level: 'silent' }),
    );
    expect((await dir.displayNames([randomUUID()], ctx)).size).toBe(0);
  });
});
