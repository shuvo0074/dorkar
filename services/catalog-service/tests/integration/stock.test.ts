import { randomUUID } from 'node:crypto';
import { ModerationEvents, TransactionEvents, type TransactionState } from '@dorkar/contracts';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { SEED_CATEGORIES } from '../../migrations/0002_seed_categories';
import { buildCatalogService } from '../../src/app';
import type { VerificationGateway } from '../../src/application/ports';

let t: TestService<Awaited<ReturnType<typeof buildCatalogService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;
const PHONES = SEED_CATEGORIES.find((c) => c.slug === 'mobile-phones')!.id;

const verification: VerificationGateway = {
  evaluate: async () => ({ satisfied: true, missing: [] }),
};

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'catalog_stock',
    migrations,
    build: (env, logger, verifier) => buildCatalogService(env, logger, { verifier, verification }),
  });
});
afterAll(() => t.close());

const publish = async (seller: string, over: Record<string, unknown> = {}) => {
  const created = await app().inject({
    method: 'POST',
    url: '/api/v1/listings',
    headers: await t.auth.as(seller),
    payload: {
      categoryId: PHONES,
      kind: 'PRODUCT',
      condition: 'USED',
      title: 'Samsung Galaxy S23 256GB',
      description: 'Lightly used, with box and charger.',
      price: { amount: 6_500_000, currency: 'BDT' },
      attributes: { brand: 'Samsung', model: 'Galaxy S23', storageGb: 256 },
      district: 'dhaka',
      deliveryModes: ['BUYER_PICKUP'],
      ...over,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().data.id as string;
  const res = await act(seller, id, 'publish');
  expect(res.statusCode, res.body).toBe(200);
  return id;
};

const act = async (seller: string, id: string, action: string) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/listings/${id}/${action}`,
    headers: await t.auth.as(seller),
  });

const created = (
  listingId: string,
  sellerId: string,
  quantity: number,
  over: Partial<{ mode: 'BUY' | 'RENT'; sourceType: 'LISTING' | 'OFFER' | 'BOOKING' }> = {},
) =>
  envelope(TransactionEvents.TransactionCreated, {
    transactionId: randomUUID(),
    sourceType: over.sourceType ?? 'LISTING',
    sourceId: listingId,
    needId: null,
    listingId,
    buyerId: randomUUID(),
    sellerId,
    amount: { amount: 6_500_000 * quantity, currency: 'BDT' },
    quantity,
    mode: over.mode ?? 'BUY',
  });

const moved = (
  c: ReturnType<typeof created>,
  to: TransactionState,
  from: TransactionState = 'CONFIRMED',
) =>
  envelope(TransactionEvents.TransactionStateChanged, {
    transactionId: c.payload.transactionId,
    needId: null,
    sourceType: c.payload.sourceType,
    sourceId: c.payload.sourceId,
    buyerId: c.payload.buyerId,
    sellerId: c.payload.sellerId,
    from,
    to,
    actorId: null,
    mode: c.payload.mode,
  });

const listing = async (id: string) =>
  db()
    .selectFrom('listings')
    .select(['status', 'quantity_available', 'stock_sold_out', 'hidden_from'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

const reservation = async (transactionId: string) =>
  db()
    .selectFrom('stock_reservations')
    .select(['listing_id', 'requested_quantity', 'quantity', 'status'])
    .where('transaction_id', '=', transactionId)
    .executeTakeFirst();

const eventsOf = async (id: string) =>
  (
    await db()
      .selectFrom('outbox')
      .select(['type', 'payload'])
      .where('aggregate_id', '=', id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute()
  ).map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> }));

describe('stock reservations', () => {
  it('reserves stock and announces the new quantity', async () => {
    const seller = randomUUID();
    const id = await publish(seller, { quantityAvailable: 5 });
    const tx = created(id, seller, 2);
    expect(await t.svc.runtime.deliver(tx)).toBe(true);

    expect(await listing(id)).toMatchObject({ status: 'PUBLISHED', quantity_available: 3 });
    expect(await reservation(tx.payload.transactionId)).toEqual({
      listing_id: id,
      requested_quantity: 2,
      quantity: 2,
      status: 'ACTIVE',
    });
    const updated = (await eventsOf(id)).filter((e) => e.type === 'catalog.ListingUpdated');
    expect(updated).toHaveLength(1);
    expect(updated[0]!.payload).toMatchObject({ listingId: id, quantityAvailable: 3 });
  });

  it('does not double-count a redelivered event', async () => {
    const seller = randomUUID();
    const id = await publish(seller, { quantityAvailable: 5 });
    const tx = created(id, seller, 2);
    expect(await t.svc.runtime.deliver(tx)).toBe(true);
    expect(await t.svc.runtime.deliver(tx)).toBe(false);
    // Even a re-published copy with a new envelope id is absorbed by the reservation key.
    const copy = envelope(TransactionEvents.TransactionCreated, tx.payload);
    expect(await t.svc.runtime.deliver(copy)).toBe(true);
    expect((await listing(id)).quantity_available).toBe(3);

    const release = moved(tx, 'CANCELLED');
    await t.svc.runtime.deliver(release);
    await t.svc.runtime.deliver(release);
    await t.svc.runtime.deliver(
      envelope(TransactionEvents.TransactionStateChanged, release.payload),
    );
    expect((await listing(id)).quantity_available).toBe(5);
  });

  it('sells out at zero, then a release makes it available again', async () => {
    const seller = randomUUID();
    const id = await publish(seller, { quantityAvailable: 2 });
    const tx = created(id, seller, 3);
    await t.svc.runtime.deliver(tx);

    expect(await listing(id)).toMatchObject({
      status: 'SOLD_OUT',
      quantity_available: 0,
      stock_sold_out: true,
    });
    expect(await reservation(tx.payload.transactionId)).toMatchObject({
      requested_quantity: 3,
      quantity: 2,
    });
    expect((await app().inject({ url: `/api/v1/listings/${id}` })).statusCode).toBe(404);
    let ev = await eventsOf(id);
    expect(ev.at(-1)).toMatchObject({
      type: 'catalog.ListingUnavailable',
      payload: { listingId: id, sellerId: seller, reason: 'SOLD_OUT' },
    });
    const hist = await db()
      .selectFrom('listing_status_history')
      .select(['from_status', 'to_status', 'actor_type'])
      .where('listing_id', '=', id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    expect(hist.at(-1)).toEqual({
      from_status: 'PUBLISHED',
      to_status: 'SOLD_OUT',
      actor_type: 'SYSTEM',
    });

    await t.svc.runtime.deliver(moved(tx, 'EXPIRED', 'CREATED'));
    expect(await listing(id)).toMatchObject({
      status: 'PUBLISHED',
      quantity_available: 2,
      stock_sold_out: false,
    });
    expect((await reservation(tx.payload.transactionId))!.status).toBe('RELEASED');
    ev = await eventsOf(id);
    expect(ev.at(-1)).toMatchObject({
      type: 'catalog.ListingPublished',
      payload: { listingId: id, quantityAvailable: 2 },
    });
    expect((await app().inject({ url: `/api/v1/listings/${id}` })).statusCode).toBe(200);
  });

  it('consumes on completion: stock stays taken, later refunds do nothing', async () => {
    const seller = randomUUID();
    const id = await publish(seller, { quantityAvailable: 1 });
    const tx = created(id, seller, 1);
    await t.svc.runtime.deliver(tx);
    await t.svc.runtime.deliver(moved(tx, 'COMPLETED', 'DELIVERED'));
    expect((await reservation(tx.payload.transactionId))!.status).toBe('CONSUMED');
    await t.svc.runtime.deliver(moved(tx, 'REFUNDED', 'COMPLETED'));
    expect((await reservation(tx.payload.transactionId))!.status).toBe('CONSUMED');
    expect(await listing(id)).toMatchObject({ status: 'SOLD_OUT', quantity_available: 0 });
  });

  it('a refund releases an active reservation; other transitions do not', async () => {
    const seller = randomUUID();
    const id = await publish(seller, { quantityAvailable: 3 });
    const tx = created(id, seller, 1);
    await t.svc.runtime.deliver(tx);
    for (const to of ['CONFIRMED', 'DELIVERED', 'DISPUTED'] as const) {
      await t.svc.runtime.deliver(moved(tx, to));
    }
    expect((await listing(id)).quantity_available).toBe(2);
    await t.svc.runtime.deliver(moved(tx, 'REFUNDED', 'DISPUTED'));
    expect((await listing(id)).quantity_available).toBe(3);
  });

  it('ignores rentals, services, non-BUY modes, deals without a listing and foreign sellers', async () => {
    const seller = randomUUID();
    const rental = await publish(seller, { kind: 'RENTAL', quantityAvailable: 1 });
    const product = await publish(seller, { quantityAvailable: 1 });

    await t.svc.runtime.deliver(
      created(rental, seller, 1, { mode: 'RENT', sourceType: 'BOOKING' }),
    );
    await t.svc.runtime.deliver(created(rental, seller, 1)); // BUY against a rental listing
    await t.svc.runtime.deliver(created(product, seller, 1, { mode: 'RENT' }));
    await t.svc.runtime.deliver(created(product, randomUUID(), 1)); // not this seller's listing
    const noListing = envelope(TransactionEvents.TransactionCreated, {
      ...created(product, seller, 1).payload,
      listingId: null,
    });
    await t.svc.runtime.deliver(noListing);
    // Producers from before the field existed omit it.
    const legacy = { ...created(product, seller, 1).payload, listingId: undefined };
    await t.svc.runtime.deliver(envelope(TransactionEvents.TransactionCreated, legacy));
    await t.svc.runtime.deliver(created(randomUUID(), seller, 1)); // unknown listing

    expect(await listing(rental)).toMatchObject({ status: 'PUBLISHED', quantity_available: 1 });
    expect(await listing(product)).toMatchObject({ status: 'PUBLISHED', quantity_available: 1 });
    const n = await db()
      .selectFrom('stock_reservations')
      .select('transaction_id')
      .where('listing_id', 'in', [rental, product])
      .execute();
    expect(n).toHaveLength(0);
  });

  it('two deals racing for the last unit: one reserves it, the other reserves 0', async () => {
    const seller = randomUUID();
    const id = await publish(seller, { quantityAvailable: 1 });
    const a = created(id, seller, 1);
    const b = created(id, seller, 1);
    await Promise.all([t.svc.runtime.deliver(a), t.svc.runtime.deliver(b)]);

    const ra = (await reservation(a.payload.transactionId))!;
    const rb = (await reservation(b.payload.transactionId))!;
    expect([ra.quantity, rb.quantity].sort()).toEqual([0, 1]);
    const short = ra.quantity === 0 ? ra : rb;
    expect(short).toMatchObject({ requested_quantity: 1, quantity: 0, status: 'ACTIVE' });
    expect(await listing(id)).toMatchObject({ status: 'SOLD_OUT', quantity_available: 0 });
    const soldOut = (await eventsOf(id)).filter((e) => e.type === 'catalog.ListingUnavailable');
    expect(soldOut).toHaveLength(1);

    // Releasing the empty reservation gives nothing back; releasing the real one does.
    const shortTx = short === ra ? a : b;
    const winnerTx = short === ra ? b : a;
    await t.svc.runtime.deliver(moved(shortTx, 'CANCELLED'));
    expect(await listing(id)).toMatchObject({ status: 'SOLD_OUT', quantity_available: 0 });
    expect((await reservation(shortTx.payload.transactionId))!.status).toBe('RELEASED');
    await t.svc.runtime.deliver(moved(winnerTx, 'CANCELLED'));
    expect(await listing(id)).toMatchObject({ status: 'PUBLISHED', quantity_available: 1 });
  });

  it('released stock leaves withdrawn, paused and owner-sold-out listings as they are', async () => {
    const seller = randomUUID();
    const cases: Array<[string, string]> = [
      ['withdraw', 'WITHDRAWN'],
      ['pause', 'PAUSED'],
      ['mark-sold-out', 'SOLD_OUT'],
    ];
    for (const [action, status] of cases) {
      const id = await publish(seller, { quantityAvailable: 2 });
      const tx = created(id, seller, 1);
      await t.svc.runtime.deliver(tx);
      const res = await act(seller, id, action);
      expect(res.statusCode, `${action}: ${res.body}`).toBe(200);
      const before = (await eventsOf(id)).length;
      await t.svc.runtime.deliver(moved(tx, 'CANCELLED'));
      expect(await listing(id)).toMatchObject({ status, quantity_available: 2 });
      expect(await eventsOf(id)).toHaveLength(before);
    }
  });

  it('a stock sell-out that was hidden stays hidden, and restores to the right state', async () => {
    const seller = randomUUID();
    const id = await publish(seller, { quantityAvailable: 1 });
    const tx = created(id, seller, 1);
    await t.svc.runtime.deliver(tx);
    const moderation = (action: 'HIDE' | 'RESTORE') =>
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'LISTING',
        targetId: id,
        action,
        reason: 'Review',
        moderatorId: randomUUID(),
      });
    await t.svc.runtime.deliver(moderation('HIDE'));
    expect(await listing(id)).toMatchObject({ status: 'HIDDEN', hidden_from: 'SOLD_OUT' });

    await t.svc.runtime.deliver(moved(tx, 'CANCELLED'));
    expect(await listing(id)).toMatchObject({
      status: 'HIDDEN',
      hidden_from: 'PUBLISHED',
      quantity_available: 1,
      stock_sold_out: false,
    });
    await t.svc.runtime.deliver(moderation('RESTORE'));
    expect(await listing(id)).toMatchObject({ status: 'PUBLISHED', quantity_available: 1 });

    // And the other way: the last unit goes while hidden; restore lands on SOLD_OUT.
    await t.svc.runtime.deliver(moderation('HIDE'));
    const tx2 = created(id, seller, 1);
    await t.svc.runtime.deliver(tx2);
    expect(await listing(id)).toMatchObject({
      status: 'HIDDEN',
      hidden_from: 'SOLD_OUT',
      quantity_available: 0,
      stock_sold_out: true,
    });
    await t.svc.runtime.deliver(moderation('RESTORE'));
    expect(await listing(id)).toMatchObject({ status: 'SOLD_OUT', stock_sold_out: true });
    await t.svc.runtime.deliver(moved(tx2, 'CANCELLED'));
    expect(await listing(id)).toMatchObject({ status: 'PUBLISHED', quantity_available: 1 });
  });
});
