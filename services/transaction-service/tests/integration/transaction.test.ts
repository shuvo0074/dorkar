import { randomUUID } from 'node:crypto';
import {
  BiddingEvents,
  CatalogEvents,
  DisputeEvents,
  LendingEvents,
  OfferEvents,
  RentalEvents,
  TransactionEvents,
  type Role,
} from '@dorkar/contracts';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildTransactionService } from '../../src/app';

let t: TestService<Awaited<ReturnType<typeof buildTransactionService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'txn',
    migrations,
    build: (env, logger, verifier) => buildTransactionService(env, logger, { verifier }),
  });
});
afterAll(() => t.close());

// ---------------------------------------------------------------- helpers

const as = (id: string, roles: Role[] = ['MEMBER']) => t.auth.as(id, roles);

async function post(
  url: string,
  actorId: string,
  payload?: unknown,
  opts: { key?: string | null; roles?: Role[] } = {},
) {
  const headers: Record<string, string> = await as(actorId, opts.roles);
  if (opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
  return app().inject({
    method: 'POST',
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

const cmd = (id: string, command: string, actorId: string, payload?: unknown, key?: string) =>
  post(`/api/v1/transactions/${id}/${command}`, actorId, payload, key ? { key } : {});

const get = async (id: string, actorId: string, roles?: Role[]) =>
  app().inject({ url: `/api/v1/transactions/${id}`, headers: await as(actorId, roles) });

const accepted = (over: Partial<Record<string, unknown>> = {}) => ({
  offerId: randomUUID(),
  needId: randomUUID(),
  buyerId: randomUUID(),
  sellerId: randomUUID(),
  listingId: null,
  mode: 'BUY' as const,
  price: { amount: 1_250_000, currency: 'BDT' as const },
  quantity: 2,
  terms: { delivery: 'BUYER_PICKUP', warrantyMonths: 6 },
  ...over,
});

async function txIdForOffer(offerId: string) {
  const rows = await db()
    .selectFrom('transactions')
    .select('id')
    .where('source_type', '=', 'OFFER')
    .where('source_id', '=', offerId)
    .execute();
  return rows;
}

/** A fresh offer-based transaction in CREATED. */
async function created() {
  const p = accepted();
  await t.svc.runtime.deliver(envelope(OfferEvents.OfferAccepted, p));
  const [row] = await txIdForOffer(p.offerId);
  return { id: row!.id, buyer: p.buyerId, seller: p.sellerId, offerId: p.offerId };
}

async function confirmed() {
  const tx = await created();
  expect((await cmd(tx.id, 'confirm', tx.buyer)).statusCode).toBe(200);
  expect((await cmd(tx.id, 'confirm', tx.seller)).statusCode).toBe(200);
  return tx;
}

async function pending() {
  const tx = await confirmed();
  expect(
    (await cmd(tx.id, 'arrange-delivery', tx.seller, { method: 'SELLER_DELIVERY' })).statusCode,
  ).toBe(200);
  return tx;
}

async function delivered() {
  const tx = await pending();
  expect((await cmd(tx.id, 'mark-delivered', tx.seller)).statusCode).toBe(200);
  return tx;
}

async function disputed() {
  const tx = await delivered();
  expect(
    (await cmd(tx.id, 'dispute', tx.buyer, { reason: 'Item does not match the photos' }))
      .statusCode,
  ).toBe(200);
  return tx;
}

const outbox = async (txId: string) =>
  db()
    .selectFrom('outbox')
    .select(['type', 'payload'])
    .where('aggregate_id', '=', txId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();

/** Every TransactionStateChanged for a transaction, validated against the contract. */
const stateChanges = async (txId: string) =>
  (await outbox(txId))
    .filter((e) => e.type === 'transaction.TransactionStateChanged')
    .map((e) => TransactionEvents.TransactionStateChanged.schema.parse(e.payload));

const transitionCount = async (txId: string) =>
  (
    await db()
      .selectFrom('transaction_transitions')
      .select(db().fn.countAll<string>().as('n'))
      .where('transaction_id', '=', txId)
      .executeTakeFirstOrThrow()
  ).n;

const backdate = (
  txId: string,
  column: 'created_at' | 'delivered_at' | 'returned_at',
  interval: string,
) =>
  db()
    .updateTable('transactions')
    .set({ [column]: sql<Date>`${sql.ref(column)} - ${interval}::interval` })
    .where('id', '=', txId)
    .execute();

const runJob = (job: 'expireUnconfirmed' | 'autoComplete') =>
  db()
    .transaction()
    .execute((trx) => t.svc.jobs[job](trx));

// ---------------------------------------------------------------- creation from offers

describe('creation from OfferAccepted', () => {
  it('creates one CREATED transaction with a pending cash payment and TransactionCreated', async () => {
    const p = accepted();
    const e = envelope(OfferEvents.OfferAccepted, p);
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false); // same envelope: inbox

    const rows = await txIdForOffer(p.offerId);
    expect(rows).toHaveLength(1);
    const res = await get(rows[0]!.id, p.buyerId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      sourceType: 'OFFER',
      sourceId: p.offerId,
      needId: p.needId,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      mode: 'BUY',
      amount: { amount: 1_250_000, currency: 'BDT' },
      quantity: 2,
      terms: p.terms,
      state: 'CREATED',
      viewerRole: 'BUYER',
      actions: ['confirm', 'cancel'],
      payment: { provider: 'CASH', status: 'PENDING', amount: { amount: 1_250_000 } },
      delivery: null,
      transitions: [],
    });

    const events = await outbox(rows[0]!.id);
    expect(events.map((x) => x.type)).toEqual(['transaction.TransactionCreated']);
    expect(TransactionEvents.TransactionCreated.schema.parse(events[0]!.payload)).toMatchObject({
      transactionId: rows[0]!.id,
      sourceType: 'OFFER',
      sourceId: p.offerId,
      listingId: null,
      amount: { amount: 1_250_000, currency: 'BDT' },
    });
  });

  it('carries the listing of the accepted offer on TransactionCreated', async () => {
    const listingId = randomUUID();
    const p = accepted({ listingId });
    await t.svc.runtime.deliver(envelope(OfferEvents.OfferAccepted, p));
    const [row] = await txIdForOffer(p.offerId);
    const [created] = await outbox(row!.id);
    expect(TransactionEvents.TransactionCreated.schema.parse(created!.payload).listingId).toBe(
      listingId,
    );
  });

  it('creates exactly one transaction when the same offer arrives twice concurrently', async () => {
    const p = accepted();
    const [a, b] = await Promise.all([
      t.svc.runtime.deliver(envelope(OfferEvents.OfferAccepted, p)),
      t.svc.runtime.deliver(envelope(OfferEvents.OfferAccepted, p)),
    ]);
    expect([a, b]).toEqual([true, true]); // two distinct envelopes, both handled
    const rows = await txIdForOffer(p.offerId);
    expect(rows).toHaveLength(1);
    const payments = await db()
      .selectFrom('payments')
      .select('id')
      .where('transaction_id', '=', rows[0]!.id)
      .execute();
    expect(payments).toHaveLength(1);
    expect((await outbox(rows[0]!.id)).map((x) => x.type)).toEqual([
      'transaction.TransactionCreated',
    ]);
  });
});

// ---------------------------------------------------------------- happy path

describe('happy path', () => {
  it('confirm ×2 → arrange → delivered → receipt → COMPLETED with payment PAID', async () => {
    const tx = await created();

    const first = await cmd(tx.id, 'confirm', tx.buyer);
    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ state: 'CREATED', actions: ['cancel'] });
    expect(first.json().data.buyerConfirmedAt).toEqual(expect.any(String));

    const second = await cmd(tx.id, 'confirm', tx.seller);
    expect(second.json().data).toMatchObject({
      state: 'CONFIRMED',
      viewerRole: 'SELLER',
      actions: ['cancel', 'arrange-delivery'],
    });

    const arranged = await cmd(tx.id, 'arrange-delivery', tx.buyer, {
      method: 'BUYER_PICKUP',
      scheduledFor: '2026-12-01T10:00:00.000Z',
      notes: 'Gate 2 of the market, after Asr',
    });
    expect(arranged.statusCode).toBe(200);
    expect(arranged.json().data).toMatchObject({
      state: 'DELIVERY_PENDING',
      delivery: {
        method: 'BUYER_PICKUP',
        status: 'ARRANGED',
        provider: 'SELF_ARRANGED',
        scheduledFor: '2026-12-01T10:00:00.000Z',
        notes: 'Gate 2 of the market, after Asr',
      },
    });

    const handed = await cmd(tx.id, 'mark-delivered', tx.seller);
    expect(handed.json().data).toMatchObject({
      state: 'DELIVERED',
      delivery: { status: 'DELIVERED' },
    });

    const done = await cmd(tx.id, 'confirm-receipt', tx.buyer);
    expect(done.statusCode).toBe(200);
    const d = done.json().data;
    expect(d).toMatchObject({ state: 'COMPLETED', actions: [], payment: { status: 'PAID' } });
    expect(d.completedAt).toEqual(expect.any(String));
    expect(
      d.transitions.map((x: { command: string; to: string }) => `${x.command}:${x.to}`),
    ).toEqual([
      'confirm:CREATED',
      'confirm:CONFIRMED',
      'arrange-delivery:DELIVERY_PENDING',
      'mark-delivered:DELIVERED',
      'confirm-receipt:COMPLETED',
    ]);

    const events = await outbox(tx.id);
    const changes = events
      .filter((e) => e.type === 'transaction.TransactionStateChanged')
      .map((e) => TransactionEvents.TransactionStateChanged.schema.parse(e.payload));
    expect(changes.map((c) => `${c.from}>${c.to}`)).toEqual([
      'CREATED>CONFIRMED',
      'CONFIRMED>DELIVERY_PENDING',
      'DELIVERY_PENDING>DELIVERED',
      'DELIVERED>COMPLETED',
    ]);
    expect(changes[0]).toMatchObject({
      transactionId: tx.id,
      sourceType: 'OFFER',
      sourceId: tx.offerId,
      buyerId: tx.buyer,
      sellerId: tx.seller,
      actorId: tx.seller,
      mode: 'BUY',
    });
    expect(changes.every((c) => c.mode === 'BUY' && c.reason === undefined)).toBe(true);

    const audits = await db()
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', tx.id)
      .execute();
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['transaction.created', 'transaction.confirm-receipt']),
    );
  });
});

// ---------------------------------------------------------------- authorization

describe('authorization', () => {
  it('hides transactions from non-parties (404) but shows them to support', async () => {
    const tx = await pending();
    const stranger = randomUUID();
    expect((await get(tx.id, stranger)).statusCode).toBe(404);
    expect((await cmd(tx.id, 'cancel', stranger, { reason: 'not mine' })).statusCode).toBe(404);
    expect((await get(randomUUID(), tx.buyer)).statusCode).toBe(404);

    const support = await get(tx.id, randomUUID(), ['SUPPORT']);
    expect(support.statusCode).toBe(200);
    expect(support.json().data).toMatchObject({ viewerRole: null, actions: [] });
  });

  it('keeps delivery notes private to the parties', async () => {
    const tx = await confirmed();
    await cmd(tx.id, 'arrange-delivery', tx.seller, { method: 'SELLER_DELIVERY', notes: 'Road 7' });
    expect((await get(tx.id, tx.buyer)).json().data.delivery.notes).toBe('Road 7');
    expect((await get(tx.id, randomUUID(), ['SUPPORT'])).json().data.delivery.notes).toBeNull();
  });

  it('refuses the wrong party (403) and the wrong state (409)', async () => {
    const tx = await pending();
    const r1 = await cmd(tx.id, 'mark-delivered', tx.buyer);
    expect(r1.statusCode).toBe(403);
    const r2 = await cmd(tx.id, 'confirm-receipt', tx.seller);
    expect(r2.statusCode).toBe(403);
    const r3 = await cmd(tx.id, 'confirm', tx.buyer);
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error.code).toBe('INVALID_STATE_TRANSITION');
    const r4 = await cmd(tx.id, 'confirm-receipt', tx.buyer);
    expect(r4.statusCode).toBe(409);
    expect(await transitionCount(tx.id)).toBe('3');
  });

  it('refuses a second confirmation by the same party', async () => {
    const tx = await created();
    await cmd(tx.id, 'confirm', tx.buyer);
    const again = await cmd(tx.id, 'confirm', tx.buyer);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.rule).toBe('ALREADY_CONFIRMED');
  });

  it('requires authentication', async () => {
    expect((await app().inject({ url: `/api/v1/transactions/${randomUUID()}` })).statusCode).toBe(
      401,
    );
  });
});

// ---------------------------------------------------------------- validation

describe('validation', () => {
  it('rejects unknown fields, missing reasons and contact info in delivery notes', async () => {
    const tx = await confirmed();
    expect((await cmd(tx.id, 'cancel', tx.buyer, {})).statusCode).toBe(400);
    expect((await cmd(tx.id, 'cancel', tx.buyer, { reason: 'ok then', extra: 1 })).statusCode).toBe(
      400,
    );
    expect((await cmd(tx.id, 'confirm', tx.buyer, { force: true })).statusCode).toBe(400);
    expect((await cmd(tx.id, 'arrange-delivery', tx.buyer, { method: 'DRONE' })).statusCode).toBe(
      400,
    );
    const phone = await cmd(tx.id, 'arrange-delivery', tx.buyer, {
      method: 'BUYER_PICKUP',
      notes: 'call me 01712345678',
    });
    expect(phone.statusCode).toBe(422);
    expect(phone.json().error.details.rule).toBe('NO_CONTACT_INFO');
  });
});

// ---------------------------------------------------------------- idempotency & concurrency

describe('idempotency', () => {
  it('requires an Idempotency-Key on commands', async () => {
    const tx = await created();
    const r = await post(`/api/v1/transactions/${tx.id}/confirm`, tx.buyer, undefined, {
      key: null,
    });
    expect(r.statusCode).toBe(400);
  });

  it('replays the same response for a retry without a second transition', async () => {
    const tx = await confirmed();
    const key = randomUUID();
    const body = { method: 'BUYER_PICKUP', notes: 'Shop 12' };
    const a = await cmd(tx.id, 'arrange-delivery', tx.buyer, body, key);
    const b = await cmd(tx.id, 'arrange-delivery', tx.buyer, body, key);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(await transitionCount(tx.id)).toBe('3');

    const reused = await cmd(tx.id, 'arrange-delivery', tx.buyer, { method: 'ON_SITE' }, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays a rejected command as the same error', async () => {
    const tx = await created();
    const key = randomUUID();
    const a = await cmd(tx.id, 'mark-delivered', tx.seller, undefined, key);
    const b = await cmd(tx.id, 'mark-delivered', tx.seller, undefined, key);
    expect(a.statusCode).toBe(409);
    expect(b.statusCode).toBe(409);
    expect(b.json().error.code).toBe(a.json().error.code);
  });
});

describe('concurrent conflicting commands', () => {
  /** Holds the row lock so both requests read the same version, then lets them race. */
  async function race(id: string, calls: Array<() => Promise<{ statusCode: number }>>) {
    let results: Promise<Array<{ statusCode: number }>> = Promise.resolve([]);
    await db()
      .transaction()
      .execute(async (trx) => {
        await trx
          .selectFrom('transactions')
          .select('id')
          .where('id', '=', id)
          .forUpdate()
          .execute();
        results = Promise.all(calls.map((c) => c()));
        await new Promise((r) => setTimeout(r, 400));
      });
    return (await results).map((r) => r.statusCode).sort();
  }

  it('cancel vs confirm: exactly one wins', async () => {
    const tx = await created();
    const codes = await race(tx.id, [
      () => cmd(tx.id, 'confirm', tx.buyer),
      () => cmd(tx.id, 'cancel', tx.seller, { reason: 'Sold elsewhere' }),
    ]);
    expect(codes).toEqual([200, 409]);
    expect(await transitionCount(tx.id)).toBe('1');
    const v = await db()
      .selectFrom('transactions')
      .select('version')
      .where('id', '=', tx.id)
      .executeTakeFirstOrThrow();
    expect(v.version).toBe(1);
  });

  it('cancel vs arrange-delivery: exactly one wins', async () => {
    const tx = await confirmed();
    const codes = await race(tx.id, [
      () => cmd(tx.id, 'arrange-delivery', tx.seller, { method: 'SELLER_DELIVERY' }),
      () => cmd(tx.id, 'cancel', tx.buyer, { reason: 'Found it cheaper' }),
    ]);
    expect(codes).toEqual([200, 409]);
    expect(await transitionCount(tx.id)).toBe('3');
  });
});

// ---------------------------------------------------------------- cancel & dispute

describe('cancellation', () => {
  it('either party cancels before delivery is arranged; never after', async () => {
    const a = await created();
    const r = await cmd(a.id, 'cancel', a.buyer, { reason: 'Changed my mind' });
    expect(r.json().data).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Changed my mind',
      payment: { status: 'PENDING', note: expect.stringMatching(/not refunded/) },
    });

    const b = await confirmed();
    expect(
      (await cmd(b.id, 'cancel', b.seller, { reason: 'Out of stock' })).json().data.state,
    ).toBe('CANCELLED');
    const last = (await outbox(b.id)).at(-1)!;
    expect(TransactionEvents.TransactionStateChanged.schema.parse(last.payload)).toMatchObject({
      from: 'CONFIRMED',
      to: 'CANCELLED',
      actorId: b.seller,
      mode: 'BUY',
      reason: 'Out of stock',
    });

    const c = await pending();
    expect((await cmd(c.id, 'cancel', c.buyer, { reason: 'Too slow' })).statusCode).toBe(409);
  });
});

describe('disputes', () => {
  it('takes a category, rejects unknown ones and contact info in the reason', async () => {
    const a = await delivered();
    expect(
      (await cmd(a.id, 'dispute', a.buyer, { reason: 'Broken screen', category: 'BROKEN' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await cmd(a.id, 'dispute', a.buyer, { reason: 'Broken screen', extra: true })).statusCode,
    ).toBe(400);
    const phone = await cmd(a.id, 'dispute', a.buyer, { reason: 'call me on 01712345678' });
    expect(phone.statusCode).toBe(422);
    expect(phone.json().error.details.rule).toBe('NO_CONTACT_INFO');
    const c = await confirmed();
    const cancel = await cmd(c.id, 'cancel', c.buyer, { reason: 'mail me at someone@example.com' });
    expect(cancel.statusCode).toBe(422);
    expect(cancel.json().error.details.rule).toBe('NO_CONTACT_INFO');

    const ok = await cmd(a.id, 'dispute', a.buyer, {
      reason: 'Screen is cracked',
      category: 'NOT_AS_DESCRIBED',
    });
    expect(ok.json().data).toMatchObject({
      state: 'DISPUTED',
      disputeReason: 'Screen is cracked',
      disputeCategory: 'NOT_AS_DESCRIBED',
      preDisputeState: 'DELIVERED',
    });
    expect((await stateChanges(a.id)).at(-1)).toMatchObject({
      to: 'DISPUTED',
      actorId: a.buyer,
      reason: 'Screen is cracked',
      disputeReason: 'NOT_AS_DESCRIBED',
    });
  });

  it('opens a dispute while delivery is pending or within the window after delivery', async () => {
    const a = await pending();
    expect(
      (await cmd(a.id, 'dispute', a.seller, { reason: 'Buyer not reachable' })).json().data,
    ).toMatchObject({
      state: 'DISPUTED',
      disputeReason: 'Buyer not reachable',
      disputeCategory: 'OTHER',
      preDisputeState: 'DELIVERY_PENDING',
    });
    expect((await stateChanges(a.id)).at(-1)).toMatchObject({
      from: 'DELIVERY_PENDING',
      to: 'DISPUTED',
      actorId: a.seller,
      mode: 'BUY',
      reason: 'Buyer not reachable',
      disputeReason: 'OTHER',
    });

    const b = await delivered();
    await backdate(b.id, 'delivered_at', '4 days');
    const late = await cmd(b.id, 'dispute', b.buyer, { reason: 'Stopped working' });
    expect(late.statusCode).toBe(422);
    expect(late.json().error.details.rule).toBe('DISPUTE_WINDOW_CLOSED');

    const c = await delivered();
    await backdate(c.id, 'delivered_at', '2 days');
    expect(
      (await cmd(c.id, 'dispute', c.buyer, { reason: 'Stopped working' })).json().data.state,
    ).toBe('DISPUTED');
  });
});

describe('dispute resolution via dispute.DisputeResolved', () => {
  const resolved = (
    tx: { id: string; buyer: string; seller: string },
    resolution: 'RELEASE' | 'CANCEL' | 'REFUND',
    over: Partial<Record<string, unknown>> = {},
  ) =>
    envelope(DisputeEvents.DisputeResolved, {
      disputeId: randomUUID(),
      transactionId: tx.id,
      buyerId: tx.buyer,
      sellerId: tx.seller,
      resolution,
      resolvedBy: randomUUID(),
      note: 'Photos match the item',
      ...over,
    });

  it('no longer exposes an admin resolve endpoint', async () => {
    const tx = await disputed();
    const r = await post(
      `/api/v1/admin/transactions/${tx.id}/resolve`,
      randomUUID(),
      { resolution: 'RELEASE', note: 'release it' },
      { roles: ['ADMIN'] },
    );
    expect(r.statusCode).toBe(404);
    // Admins see no actions: outcomes come from the dispute service.
    expect((await get(tx.id, randomUUID(), ['ADMIN'])).json().data.actions).toEqual([]);
  });

  it('RELEASE completes and marks cash paid, exactly once', async () => {
    const a = await disputed();
    const e = resolved(a, 'RELEASE');
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false); // inbox

    const d = (await get(a.id, a.buyer)).json().data;
    expect(d).toMatchObject({ state: 'COMPLETED', payment: { status: 'PAID' }, actions: [] });
    expect(d.completedAt).toEqual(expect.any(String));
    expect(d.transitions.at(-1)).toMatchObject({
      command: 'resolve-release',
      actorRole: 'ADMIN',
      actorId: e.payload.resolvedBy,
      reason: 'Photos match the item',
    });
    expect((await stateChanges(a.id)).at(-1)).toMatchObject({
      from: 'DISPUTED',
      to: 'COMPLETED',
      actorId: e.payload.resolvedBy,
      mode: 'BUY',
      reason: 'Photos match the item',
    });
    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'actor_type'])
      .where('target_id', '=', a.id)
      .where('action', '=', 'transaction.resolve-release')
      .executeTakeFirstOrThrow();
    expect(audit.actor_type).toBe('ADMIN');
  });

  it('CANCEL cancels with the note as the reason', async () => {
    const b = await disputed();
    await t.svc.runtime.deliver(resolved(b, 'CANCEL', { note: 'Seller misdescribed' }));
    expect((await get(b.id, b.buyer)).json().data).toMatchObject({
      state: 'CANCELLED',
      cancelReason: 'Seller misdescribed',
    });
  });

  it('ignores REFUND for cash payments, with an audit entry', async () => {
    const c = await disputed();
    const before = await transitionCount(c.id);
    expect(await t.svc.runtime.deliver(resolved(c, 'REFUND'))).toBe(true);
    expect((await get(c.id, c.buyer)).json().data.state).toBe('DISPUTED');
    expect(await transitionCount(c.id)).toBe(before);
    const audits = await db()
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', c.id)
      .execute();
    expect(audits.map((x) => x.action)).toContain('transaction.dispute-refund-ignored');
  });

  it('is a no-op unless the transaction is currently DISPUTED (and its parties match)', async () => {
    const p = await pending();
    const before = await transitionCount(p.id);
    expect(await t.svc.runtime.deliver(resolved(p, 'RELEASE'))).toBe(true);
    expect((await get(p.id, p.buyer)).json().data.state).toBe('DELIVERY_PENDING');
    expect(await transitionCount(p.id)).toBe(before);

    const unknown = { id: randomUUID(), buyer: randomUUID(), seller: randomUUID() };
    expect(await t.svc.runtime.deliver(resolved(unknown, 'CANCEL'))).toBe(true);

    const d = await disputed();
    await t.svc.runtime.deliver(resolved({ ...d, buyer: randomUUID() }, 'CANCEL'));
    expect((await get(d.id, d.buyer)).json().data.state).toBe('DISPUTED');
  });

  it('lists disputed transactions for staff only', async () => {
    const tx = await disputed();
    const url = '/api/v1/admin/transactions?state=DISPUTED&limit=100';
    expect((await app().inject({ url, headers: await as(randomUUID()) })).statusCode).toBe(403);
    const res = await app().inject({ url, headers: await as(randomUUID(), ['SUPPORT']) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((x: { id: string; state: string }) => x.id);
    expect(ids).toContain(tx.id);
    expect(res.json().data.every((x: { state: string }) => x.state === 'DISPUTED')).toBe(true);
  });
});

describe('dispute withdrawal via dispute.DisputeWithdrawn', () => {
  const withdrawn = (
    tx: { id: string; buyer: string; seller: string },
    previousState: string,
    withdrawnBy: string,
  ) =>
    envelope(DisputeEvents.DisputeWithdrawn, {
      disputeId: randomUUID(),
      transactionId: tx.id,
      buyerId: tx.buyer,
      sellerId: tx.seller,
      withdrawnBy,
      previousState: previousState as 'DELIVERED',
    });

  it('restores the pre-dispute state (DELIVERED, DELIVERY_PENDING)', async () => {
    const a = await disputed();
    expect((await get(a.id, a.buyer)).json().data.preDisputeState).toBe('DELIVERED');
    await t.svc.runtime.deliver(withdrawn(a, 'DELIVERED', a.buyer));
    const d = (await get(a.id, a.buyer)).json().data;
    expect(d).toMatchObject({ state: 'DELIVERED', actions: ['confirm-receipt', 'dispute'] });
    expect(d.transitions.at(-1)).toMatchObject({
      command: 'withdraw-dispute',
      from: 'DISPUTED',
      to: 'DELIVERED',
      actorRole: 'SYSTEM',
      actorId: a.buyer,
    });
    expect((await stateChanges(a.id)).at(-1)).toMatchObject({
      from: 'DISPUTED',
      to: 'DELIVERED',
      actorId: a.buyer,
      mode: 'BUY',
    });

    const b = await pending();
    await cmd(b.id, 'dispute', b.seller, { reason: 'Buyer not reachable', category: 'NO_SHOW' });
    await t.svc.runtime.deliver(withdrawn(b, 'DELIVERY_PENDING', b.seller));
    expect((await get(b.id, b.buyer)).json().data.state).toBe('DELIVERY_PENDING');
  });

  it('uses the stored state even when the event reports another one', async () => {
    const a = await disputed();
    await t.svc.runtime.deliver(withdrawn(a, 'CONFIRMED', a.buyer));
    expect((await get(a.id, a.buyer)).json().data.state).toBe('DELIVERED');
  });

  it('is a no-op when the transaction is not disputed', async () => {
    const a = await delivered();
    const before = await transitionCount(a.id);
    expect(await t.svc.runtime.deliver(withdrawn(a, 'DELIVERED', a.buyer))).toBe(true);
    expect(await transitionCount(a.id)).toBe(before);
  });
});

// ---------------------------------------------------------------- my list

describe('my transactions', () => {
  it('filters by role and state and pages with a cursor', async () => {
    const me = randomUUID();
    const seller = randomUUID();
    for (let i = 0; i < 3; i++)
      await t.svc.runtime.deliver(
        envelope(OfferEvents.OfferAccepted, accepted({ buyerId: me, sellerId: seller })),
      );
    await t.svc.runtime.deliver(
      envelope(OfferEvents.OfferAccepted, accepted({ buyerId: randomUUID(), sellerId: me })),
    );
    const headers = await as(me);
    const list = async (qs: string) =>
      (await app().inject({ url: `/api/v1/me/transactions?${qs}`, headers })).json();

    expect((await list('')).data).toHaveLength(4);
    expect((await list('role=buyer')).data).toHaveLength(3);
    expect((await list('role=seller')).data).toHaveLength(1);
    expect((await list('state=COMPLETED')).data).toHaveLength(0);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Array<{ id: string }>; page: { nextCursor: string | null } } = await list(
        `role=buyer&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...page.data.map((x) => x.id));
      cursor = page.page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(3);

    expect(
      (await app().inject({ url: '/api/v1/me/transactions?cursor=garbage', headers })).statusCode,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------- direct listing purchase

describe('direct listing purchase', () => {
  const publish = async (over: Partial<Record<string, unknown>> = {}) => {
    const l = {
      listingId: randomUUID(),
      sellerId: randomUUID(),
      categoryId: randomUUID(),
      kind: 'PRODUCT' as const,
      condition: 'NEW' as const,
      title: 'Rice cooker 1.8L',
      price: { amount: 350_000, currency: 'BDT' as const },
      priceUnit: 'PER_UNIT' as const,
      quantityAvailable: 3,
      district: 'dhaka' as const,
      attributes: {},
      deliveryModes: ['BUYER_PICKUP' as const],
      ...over,
    };
    await t.svc.runtime.deliver(envelope(CatalogEvents.ListingPublished, l));
    return l;
  };
  const buy = (buyer: string, body: unknown, key?: string) =>
    post('/api/v1/transactions', buyer, body, key ? { key } : {});

  it('creates a LISTING transaction priced per unit, idempotently', async () => {
    const l = await publish();
    const buyer = randomUUID();
    const key = randomUUID();
    const res = await buy(buyer, { listingId: l.listingId, quantity: 2 }, key);
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d).toMatchObject({
      sourceType: 'LISTING',
      sourceId: l.listingId,
      listingId: l.listingId,
      needId: null,
      buyerId: buyer,
      sellerId: l.sellerId,
      mode: 'BUY',
      amount: { amount: 700_000, currency: 'BDT' },
      quantity: 2,
      state: 'CREATED',
      terms: { title: 'Rice cooker 1.8L', unitPrice: { amount: 350_000 } },
      payment: { provider: 'CASH', status: 'PENDING' },
    });

    const again = await buy(buyer, { listingId: l.listingId, quantity: 2 }, key);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual(res.json());
    const rows = await db()
      .selectFrom('transactions')
      .select('id')
      .where('source_id', '=', l.listingId)
      .execute();
    expect(rows).toHaveLength(1);

    const created = (await outbox(d.id)).find((e) => e.type === 'transaction.TransactionCreated');
    expect(TransactionEvents.TransactionCreated.schema.parse(created!.payload)).toMatchObject({
      sourceType: 'LISTING',
      sourceId: l.listingId,
      mode: 'BUY',
    });

    // Remaining stock is 1: a second buyer can take it, a third cannot.
    expect(
      (await buy(randomUUID(), { listingId: l.listingId, quantity: 2 })).json().error.details.rule,
    ).toBe('INSUFFICIENT_QUANTITY');
    expect((await buy(randomUUID(), { listingId: l.listingId, quantity: 1 })).statusCode).toBe(201);
  });

  it('maps services to HIRE and rentals to RENT; TOTAL is a single lot', async () => {
    const svc = await publish({
      kind: 'SERVICE',
      condition: null,
      priceUnit: 'TOTAL',
      quantityAvailable: 1,
    });
    const r = await buy(randomUUID(), { listingId: svc.listingId, quantity: 1 });
    expect(r.json().data).toMatchObject({ mode: 'HIRE', amount: { amount: 350_000 } });

    const lot = await publish({ priceUnit: 'TOTAL', quantityAvailable: 5 });
    const two = await buy(randomUUID(), { listingId: lot.listingId, quantity: 2 });
    expect(two.statusCode).toBe(422);
    expect(two.json().error.details.rule).toBe('QUANTITY_NOT_ALLOWED');

    const rental = await publish({ kind: 'RENTAL', priceUnit: 'PER_DAY', quantityAvailable: 7 });
    expect(
      (await buy(randomUUID(), { listingId: rental.listingId, quantity: 3 })).json().data,
    ).toMatchObject({
      mode: 'RENT',
      amount: { amount: 1_050_000 },
    });
  });

  it('refuses own, unknown, unavailable and over-quantity purchases', async () => {
    const l = await publish();
    const own = await buy(l.sellerId, { listingId: l.listingId, quantity: 1 });
    expect(own.statusCode).toBe(422);
    expect(own.json().error.details.rule).toBe('OWN_LISTING');

    const tooMany = await buy(randomUUID(), { listingId: l.listingId, quantity: 4 });
    expect(tooMany.json().error.details.rule).toBe('INSUFFICIENT_QUANTITY');

    expect((await buy(randomUUID(), { listingId: randomUUID(), quantity: 1 })).statusCode).toBe(
      404,
    );
    expect((await buy(randomUUID(), { listingId: l.listingId, quantity: 0 })).statusCode).toBe(400);
    expect(
      (await buy(randomUUID(), { listingId: l.listingId, quantity: 1 }, undefined)).statusCode,
    ).toBe(201);
    expect(
      (
        await post(
          '/api/v1/transactions',
          randomUUID(),
          { listingId: l.listingId, quantity: 1 },
          { key: null },
        )
      ).statusCode,
    ).toBe(400);

    await t.svc.runtime.deliver(
      envelope(CatalogEvents.ListingUnavailable, {
        listingId: l.listingId,
        sellerId: l.sellerId,
        reason: 'PAUSED',
      }),
    );
    const paused = await buy(randomUUID(), { listingId: l.listingId, quantity: 1 });
    expect(paused.json().error.details.rule).toBe('LISTING_UNAVAILABLE');
    // An edit to a paused listing does not make it purchasable again; a re-publish does.
    await t.svc.runtime.deliver(
      envelope(CatalogEvents.ListingUpdated, { ...l, title: 'Rice cooker' }),
    );
    expect((await buy(randomUUID(), { listingId: l.listingId, quantity: 1 })).statusCode).toBe(422);
    await t.svc.runtime.deliver(envelope(CatalogEvents.ListingPublished, l));
    expect((await buy(randomUUID(), { listingId: l.listingId, quantity: 1 })).statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------- jobs

describe('jobs', () => {
  it('expires CREATED transactions past the confirmation TTL, and only those', async () => {
    const stale = await created();
    const fresh = await created();
    await backdate(stale.id, 'created_at', '49 hours');
    expect(await runJob('expireUnconfirmed')).toBeGreaterThanOrEqual(1);

    const s = (await get(stale.id, stale.buyer)).json().data;
    expect(s).toMatchObject({ state: 'EXPIRED', actions: [] });
    expect(s.transitions.at(-1)).toMatchObject({
      command: 'expire',
      actorRole: 'SYSTEM',
      actorId: null,
    });
    expect((await get(fresh.id, fresh.buyer)).json().data.state).toBe('CREATED');

    const last = (await outbox(stale.id)).at(-1)!;
    expect(TransactionEvents.TransactionStateChanged.schema.parse(last.payload)).toMatchObject({
      from: 'CREATED',
      to: 'EXPIRED',
      actorId: null,
    });
    // Confirming after the TTL is refused even before the job runs.
    const late = await created();
    await backdate(late.id, 'created_at', '49 hours');
    const r = await cmd(late.id, 'confirm', late.buyer);
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details.rule).toBe('CONFIRMATION_WINDOW_CLOSED');
  });

  it('auto-completes DELIVERED transactions past the window, not recent or disputed ones', async () => {
    const old = await delivered();
    const recent = await delivered();
    const contested = await disputed();
    await backdate(old.id, 'delivered_at', '4 days');
    await backdate(recent.id, 'delivered_at', '1 day');
    await backdate(contested.id, 'delivered_at', '4 days');

    await runJob('autoComplete');

    const o = (await get(old.id, old.buyer)).json().data;
    expect(o).toMatchObject({ state: 'COMPLETED', payment: { status: 'PAID' } });
    expect(o.transitions.at(-1)).toMatchObject({ command: 'auto-complete', actorRole: 'SYSTEM' });
    expect((await get(recent.id, recent.buyer)).json().data.state).toBe('DELIVERED');
    expect((await get(contested.id, contested.buyer)).json().data.state).toBe('DISPUTED');
  });
});

describe('history', () => {
  it('is append-only', async () => {
    const tx = await confirmed();
    await expect(
      db().deleteFrom('transaction_transitions').where('transaction_id', '=', tx.id).execute(),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------- Phase 2 sources (ADR-0008)

const awarded = (over: Partial<Record<string, unknown>> = {}) => ({
  auctionId: randomUUID(),
  winningBidId: randomUUID(),
  kind: 'FORWARD' as const,
  needId: null,
  listingId: randomUUID(),
  buyerId: randomUUID(),
  sellerId: randomUUID(),
  mode: 'BUY' as const,
  amount: { amount: 4_200_000, currency: 'BDT' as const },
  quantity: 1,
  terms: { delivery: 'BUYER_PICKUP' },
  ...over,
});

const booking = (over: Partial<Record<string, unknown>> = {}) => ({
  bookingId: randomUUID(),
  listingId: randomUUID(),
  ownerId: randomUUID(),
  renterId: randomUUID(),
  startAt: '2026-11-01T09:00:00.000Z',
  endAt: '2026-11-04T09:00:00.000Z',
  amount: { amount: 900_000, currency: 'BDT' as const },
  deposit: { amount: 500_000, currency: 'BDT' as const },
  terms: { pickup: 'Owner shop' },
  ...over,
});

const loan = (over: Partial<Record<string, unknown>> = {}) => ({
  loanId: randomUUID(),
  itemId: randomUUID(),
  lenderId: randomUUID(),
  borrowerId: randomUUID(),
  startAt: '2026-11-01T09:00:00.000Z',
  returnBy: '2026-11-08T09:00:00.000Z',
  deposit: null,
  terms: { care: 'Keep dry' },
  ...over,
});

const txFor = async (sourceType: string, sourceId: string) =>
  db()
    .selectFrom('transactions')
    .select('id')
    .where('source_type', '=', sourceType as 'OFFER')
    .where('source_id', '=', sourceId)
    .execute();

/** All outbox events of a transaction, each validated against its contract. */
const contractEvents = async (txId: string) =>
  (await outbox(txId)).map((e) => {
    if (e.type === 'transaction.TransactionCreated')
      return { type: e.type, p: TransactionEvents.TransactionCreated.schema.parse(e.payload) };
    if (e.type === 'transaction.TransactionStateChanged')
      return { type: e.type, p: TransactionEvents.TransactionStateChanged.schema.parse(e.payload) };
    throw new Error(`unexpected event ${e.type}`);
  });

async function rented(over: Partial<Record<string, unknown>> = {}) {
  const p = booking(over);
  await t.svc.runtime.deliver(envelope(RentalEvents.BookingConfirmed, p));
  const [row] = await txFor('BOOKING', p.bookingId);
  return { id: row!.id, buyer: p.renterId, seller: p.ownerId, p };
}

async function lent(over: Partial<Record<string, unknown>> = {}) {
  const p = loan(over);
  await t.svc.runtime.deliver(envelope(LendingEvents.LoanApproved, p));
  const [row] = await txFor('LOAN', p.loanId);
  return { id: row!.id, buyer: p.borrowerId, seller: p.lenderId, p };
}

type Party = { id: string; buyer: string; seller: string };

async function handedOver(make: () => Promise<Party> = rented) {
  const tx = await make();
  expect((await cmd(tx.id, 'hand-over', tx.seller)).statusCode).toBe(200);
  return tx;
}

async function returned(make: () => Promise<Party> = rented) {
  const tx = await handedOver(make);
  expect((await cmd(tx.id, 'confirm-return', tx.seller)).statusCode).toBe(200);
  return tx;
}

describe('creation from bidding.AuctionAwarded', () => {
  it('creates one CREATED AUCTION transaction needing both confirmations', async () => {
    const p = awarded();
    const e = envelope(BiddingEvents.AuctionAwarded, p);
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false);
    // A redelivery under a new envelope id still creates nothing (unique source).
    expect(await t.svc.runtime.deliver(envelope(BiddingEvents.AuctionAwarded, p))).toBe(true);
    const rows = await txFor('AUCTION', p.auctionId);
    expect(rows).toHaveLength(1);
    const id = rows[0]!.id;

    expect((await get(id, p.buyerId)).json().data).toMatchObject({
      sourceType: 'AUCTION',
      sourceId: p.auctionId,
      listingId: p.listingId,
      needId: null,
      buyerId: p.buyerId,
      sellerId: p.sellerId,
      mode: 'BUY',
      amount: { amount: 4_200_000 },
      quantity: 1,
      terms: { delivery: 'BUYER_PICKUP', auctionKind: 'FORWARD', winningBidId: p.winningBidId },
      state: 'CREATED',
      actions: ['confirm', 'cancel'],
      payment: { provider: 'CASH', status: 'PENDING' },
      deposit: null,
      transitions: [],
    });
    const events = await contractEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.p).toMatchObject({
      sourceType: 'AUCTION',
      sourceId: p.auctionId,
      listingId: p.listingId,
    });

    await cmd(id, 'confirm', p.buyerId);
    expect((await cmd(id, 'confirm', p.sellerId)).json().data.state).toBe('CONFIRMED');
  });

  it('takes need, mode and quantity from a reverse auction', async () => {
    const p = awarded({
      kind: 'REVERSE',
      needId: randomUUID(),
      listingId: null,
      mode: 'SOURCE',
      quantity: 40,
    });
    await t.svc.runtime.deliver(envelope(BiddingEvents.AuctionAwarded, p));
    const [row] = await txFor('AUCTION', p.auctionId);
    expect((await get(row!.id, p.sellerId)).json().data).toMatchObject({
      needId: p.needId,
      listingId: null,
      mode: 'SOURCE',
      quantity: 40,
    });
  });
});

describe('creation from rental.BookingConfirmed', () => {
  it('starts CONFIRMED with an auto-confirm history row, cash payment and a held deposit', async () => {
    const p = booking();
    await t.svc.runtime.deliver(envelope(RentalEvents.BookingConfirmed, p));
    await t.svc.runtime.deliver(envelope(RentalEvents.BookingConfirmed, p)); // redelivery
    const rows = await txFor('BOOKING', p.bookingId);
    expect(rows).toHaveLength(1);
    const id = rows[0]!.id;

    const d = (await get(id, p.ownerId)).json().data;
    expect(d).toMatchObject({
      sourceType: 'BOOKING',
      sourceId: p.bookingId,
      listingId: p.listingId,
      needId: null,
      buyerId: p.renterId,
      sellerId: p.ownerId,
      mode: 'RENT',
      amount: { amount: 900_000 },
      quantity: 1,
      terms: {
        startAt: p.startAt,
        endAt: p.endAt,
        deposit: { amount: 500_000, currency: 'BDT' },
        terms: { pickup: 'Owner shop' },
      },
      state: 'CONFIRMED',
      viewerRole: 'SELLER',
      actions: ['cancel', 'hand-over'],
      payment: { provider: 'CASH', status: 'PENDING', amount: { amount: 900_000 } },
      deposit: { amount: { amount: 500_000 }, status: 'HELD' },
    });
    expect(d.buyerConfirmedAt).toEqual(expect.any(String));
    expect(d.sellerConfirmedAt).toEqual(expect.any(String));
    expect(d.transitions).toEqual([
      expect.objectContaining({
        from: 'CREATED',
        to: 'CONFIRMED',
        command: 'auto-confirm',
        actorRole: 'SYSTEM',
        actorId: null,
      }),
    ]);

    const events = await contractEvents(id);
    expect(events.map((e) => e.type)).toEqual([
      'transaction.TransactionCreated',
      'transaction.TransactionStateChanged',
    ]);
    expect(events[0]!.p).toMatchObject({
      sourceType: 'BOOKING',
      listingId: p.listingId,
      mode: 'RENT',
    });
    expect(events[1]!.p).toMatchObject({
      from: 'CREATED',
      to: 'CONFIRMED',
      actorId: null,
      mode: 'RENT',
    });
    expect((await get(id, p.renterId)).json().data.actions).toEqual(['cancel']);
  });

  it('records no deposit when there is none', async () => {
    const tx = await rented({ deposit: null });
    expect((await get(tx.id, tx.buyer)).json().data.deposit).toBeNull();
  });
});

describe('creation from lending.LoanApproved', () => {
  it('starts CONFIRMED, free (no payment record), BORROW', async () => {
    const p = loan({ deposit: { amount: 200_000, currency: 'BDT' } });
    const e = envelope(LendingEvents.LoanApproved, p);
    await t.svc.runtime.deliver(e);
    await t.svc.runtime.deliver(envelope(LendingEvents.LoanApproved, p));
    const rows = await txFor('LOAN', p.loanId);
    expect(rows).toHaveLength(1);
    const id = rows[0]!.id;

    const d = (await get(id, p.borrowerId)).json().data;
    expect(d).toMatchObject({
      sourceType: 'LOAN',
      sourceId: p.loanId,
      listingId: null,
      buyerId: p.borrowerId,
      sellerId: p.lenderId,
      mode: 'BORROW',
      amount: { amount: 0 },
      quantity: 1,
      terms: {
        startAt: p.startAt,
        returnBy: p.returnBy,
        itemId: p.itemId,
        deposit: { amount: 200_000 },
      },
      state: 'CONFIRMED',
      payment: null,
      deposit: { amount: { amount: 200_000 }, status: 'HELD' },
    });
    expect(d.transitions.map((x: { command: string }) => x.command)).toEqual(['auto-confirm']);
    const events = await contractEvents(id);
    expect(events.map((x) => x.type)).toEqual([
      'transaction.TransactionCreated',
      'transaction.TransactionStateChanged',
    ]);
    expect(events[0]!.p).toMatchObject({ amount: { amount: 0 }, mode: 'BORROW', listingId: null });
  });

  it('ignores a deal whose lender is the borrower', async () => {
    const me = randomUUID();
    const p = loan({ lenderId: me, borrowerId: me });
    expect(await t.svc.runtime.deliver(envelope(LendingEvents.LoanApproved, p))).toBe(true);
    expect(await txFor('LOAN', p.loanId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- RENT / BORROW sub-flow

describe('hand-over and return', () => {
  it('rental: hand-over → report-return → confirm-return → complete, deposit returned', async () => {
    const tx = await rented();

    const h = await cmd(tx.id, 'hand-over', tx.seller);
    expect(h.statusCode).toBe(200);
    expect(h.json().data).toMatchObject({
      state: 'HANDED_OVER',
      actions: ['confirm-return', 'dispute'],
    });
    expect(h.json().data.handedOverAt).toEqual(expect.any(String));
    expect((await get(tx.id, tx.buyer)).json().data.actions).toEqual(['report-return', 'dispute']);

    const r = await cmd(tx.id, 'report-return', tx.buyer);
    expect(r.json().data).toMatchObject({ state: 'RETURN_REPORTED', actions: ['dispute'] });
    expect(r.json().data.returnReportedAt).toEqual(expect.any(String));

    const c = await cmd(tx.id, 'confirm-return', tx.seller);
    expect(c.json().data).toMatchObject({ state: 'RETURNED', actions: ['complete', 'dispute'] });
    expect(c.json().data.returnedAt).toEqual(expect.any(String));
    expect((await get(tx.id, tx.buyer)).json().data.actions).toEqual([]);

    const done = await cmd(tx.id, 'complete', tx.seller);
    expect(done.json().data).toMatchObject({
      state: 'COMPLETED',
      payment: { status: 'PAID' },
      deposit: { status: 'RETURNED' },
      actions: [],
    });

    const changes = await stateChanges(tx.id);
    expect(changes.map((x) => `${x.from}>${x.to}`)).toEqual([
      'CREATED>CONFIRMED',
      'CONFIRMED>HANDED_OVER',
      'HANDED_OVER>RETURN_REPORTED',
      'RETURN_REPORTED>RETURNED',
      'RETURNED>COMPLETED',
    ]);
    expect(changes.every((x) => x.mode === 'RENT')).toBe(true);
    expect(changes[1]!.actorId).toBe(tx.seller);
    expect(changes[2]!.actorId).toBe(tx.buyer);
  });

  it('loan: the lender confirms the return directly from HANDED_OVER', async () => {
    const tx = await handedOver(lent);
    const c = await cmd(tx.id, 'confirm-return', tx.seller);
    expect(c.json().data.state).toBe('RETURNED');
    expect((await cmd(tx.id, 'complete', tx.seller)).json().data).toMatchObject({
      state: 'COMPLETED',
      payment: null,
    });
    expect((await stateChanges(tx.id)).every((x) => x.mode === 'BORROW')).toBe(true);
  });

  it('only the right party runs each step', async () => {
    const tx = await rented();
    expect((await cmd(tx.id, 'hand-over', tx.buyer)).statusCode).toBe(403);
    expect((await cmd(tx.id, 'report-return', tx.buyer)).statusCode).toBe(409);
    await cmd(tx.id, 'hand-over', tx.seller);
    expect((await cmd(tx.id, 'report-return', tx.seller)).statusCode).toBe(403);
    expect((await cmd(tx.id, 'confirm-return', tx.buyer)).statusCode).toBe(403);
    expect((await cmd(tx.id, 'complete', tx.seller)).statusCode).toBe(409);
    expect((await cmd(tx.id, 'cancel', tx.buyer, { reason: 'Too late now' })).statusCode).toBe(409);
    expect((await cmd(tx.id, 'hand-over', randomUUID())).statusCode).toBe(404);
  });

  it('either party cancels a confirmed rental before hand-over; the deposit is returned', async () => {
    const tx = await rented();
    const r = await cmd(tx.id, 'cancel', tx.buyer, { reason: 'Plans changed' });
    expect(r.json().data).toMatchObject({ state: 'CANCELLED', deposit: { status: 'RETURNED' } });
  });

  it('requires an Idempotency-Key and replays retries', async () => {
    const tx = await rented();
    const noKey = await post(`/api/v1/transactions/${tx.id}/hand-over`, tx.seller, undefined, {
      key: null,
    });
    expect(noKey.statusCode).toBe(400);
    const key = randomUUID();
    const a = await cmd(tx.id, 'hand-over', tx.seller, undefined, key);
    const b = await cmd(tx.id, 'hand-over', tx.seller, undefined, key);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(await transitionCount(tx.id)).toBe('2');
  });
});

describe('mode guards', () => {
  it('no hand-over or return steps on a purchase', async () => {
    const tx = await confirmed();
    for (const c of ['hand-over', 'complete'] as const) {
      const r = await cmd(tx.id, c, tx.seller);
      expect(r.statusCode).toBe(422);
      expect(r.json().error.details.rule).toBe('NOT_FOR_MODE');
    }
    expect((await cmd(tx.id, 'report-return', tx.buyer)).json().error.details.rule).toBe(
      'NOT_FOR_MODE',
    );
    expect((await get(tx.id, tx.seller)).json().data.state).toBe('CONFIRMED');
  });

  it('no delivery steps on a rental', async () => {
    const tx = await rented();
    const a = await cmd(tx.id, 'arrange-delivery', tx.buyer, { method: 'BUYER_PICKUP' });
    expect(a.statusCode).toBe(422);
    expect(a.json().error.details.rule).toBe('NOT_FOR_MODE');
    await cmd(tx.id, 'hand-over', tx.seller);
    const m = await cmd(tx.id, 'mark-delivered', tx.seller);
    expect(m.statusCode).toBe(422);
    expect(m.json().error.details.rule).toBe('NOT_FOR_MODE');
    expect((await cmd(tx.id, 'confirm-receipt', tx.buyer)).statusCode).toBe(422);
    expect((await get(tx.id, tx.seller)).json().data.state).toBe('HANDED_OVER');
  });
});

describe('rental disputes', () => {
  it('either party disputes while the item is out or its return is reported', async () => {
    const a = await handedOver();
    const r = await cmd(a.id, 'dispute', a.seller, {
      reason: 'Not back yet',
      category: 'NOT_RETURNED',
    });
    expect(r.json().data).toMatchObject({ state: 'DISPUTED', preDisputeState: 'HANDED_OVER' });
    expect((await stateChanges(a.id)).at(-1)).toMatchObject({
      to: 'DISPUTED',
      mode: 'RENT',
      disputeReason: 'NOT_RETURNED',
      reason: 'Not back yet',
      actorId: a.seller,
    });

    const b = await handedOver(lent);
    await cmd(b.id, 'report-return', b.buyer);
    expect(
      (await cmd(b.id, 'dispute', b.buyer, { reason: 'Lender ignores me' })).json().data,
    ).toMatchObject({
      state: 'DISPUTED',
      preDisputeState: 'RETURN_REPORTED',
      disputeCategory: 'OTHER',
    });
  });

  it('damage claim: owner only, within the window after the return', async () => {
    const a = await returned();
    expect((await cmd(a.id, 'dispute', a.buyer, { reason: 'Owner is rude' })).statusCode).toBe(403);
    await backdate(a.id, 'returned_at', '23 hours');
    const claim = await cmd(a.id, 'dispute', a.seller, {
      reason: 'Lens is scratched',
      category: 'DAMAGED',
    });
    expect(claim.json().data).toMatchObject({
      state: 'DISPUTED',
      preDisputeState: 'RETURNED',
      disputeCategory: 'DAMAGED',
    });

    const b = await returned();
    await backdate(b.id, 'returned_at', '25 hours');
    const late = await cmd(b.id, 'dispute', b.seller, { reason: 'Lens is scratched' });
    expect(late.statusCode).toBe(422);
    expect(late.json().error.details.rule).toBe('DAMAGE_CLAIM_WINDOW_CLOSED');
    expect((await get(b.id, b.seller)).json().data.actions).toEqual(['complete']);
  });

  it('withdrawal restores RETURNED; resolutions settle the deposit', async () => {
    const resolve = (
      tx: { id: string; buyer: string; seller: string },
      resolution: 'RELEASE' | 'CANCEL',
    ) =>
      t.svc.runtime.deliver(
        envelope(DisputeEvents.DisputeResolved, {
          disputeId: randomUUID(),
          transactionId: tx.id,
          buyerId: tx.buyer,
          sellerId: tx.seller,
          resolution,
          resolvedBy: randomUUID(),
          note: 'Decided on the evidence',
        }),
      );
    const claim = async () => {
      const tx = await returned();
      await cmd(tx.id, 'dispute', tx.seller, { reason: 'Lens is scratched', category: 'DAMAGED' });
      return tx;
    };

    const w = await claim();
    await t.svc.runtime.deliver(
      envelope(DisputeEvents.DisputeWithdrawn, {
        disputeId: randomUUID(),
        transactionId: w.id,
        buyerId: w.buyer,
        sellerId: w.seller,
        withdrawnBy: w.seller,
        previousState: 'RETURNED',
      }),
    );
    expect((await get(w.id, w.seller)).json().data).toMatchObject({
      state: 'RETURNED',
      deposit: { status: 'HELD' },
    });

    // The owner's claim upheld: the deal completes and the owner keeps the deposit.
    const upheld = await claim();
    await resolve(upheld, 'RELEASE');
    expect((await get(upheld.id, upheld.buyer)).json().data).toMatchObject({
      state: 'COMPLETED',
      payment: { status: 'PAID' },
      deposit: { status: 'FORFEITED' },
    });

    // The renter's complaint rejected (RELEASE): completed, deposit returned.
    const complaint = await handedOver();
    await cmd(complaint.id, 'dispute', complaint.buyer, { reason: 'It broke on day one' });
    await resolve(complaint, 'RELEASE');
    expect((await get(complaint.id, complaint.buyer)).json().data).toMatchObject({
      state: 'COMPLETED',
      deposit: { status: 'RETURNED' },
    });

    const cancelled = await claim();
    await resolve(cancelled, 'CANCEL');
    expect((await get(cancelled.id, cancelled.buyer)).json().data).toMatchObject({
      state: 'CANCELLED',
      deposit: { status: 'RETURNED' },
    });
  });
});

describe('auto-complete of returned rentals and loans', () => {
  it('completes RETURNED deals past the window, not recent or disputed ones', async () => {
    const old = await returned();
    const oldLoan = await returned(lent);
    const recent = await returned();
    const contested = await returned();
    await cmd(contested.id, 'dispute', contested.seller, { reason: 'Lens is scratched' });
    await backdate(old.id, 'returned_at', '25 hours');
    await backdate(oldLoan.id, 'returned_at', '25 hours');
    await backdate(recent.id, 'returned_at', '23 hours');
    await backdate(contested.id, 'returned_at', '25 hours');

    expect(await runJob('autoComplete')).toBeGreaterThanOrEqual(2);

    const o = (await get(old.id, old.buyer)).json().data;
    expect(o).toMatchObject({
      state: 'COMPLETED',
      payment: { status: 'PAID' },
      deposit: { status: 'RETURNED' },
    });
    expect(o.transitions.at(-1)).toMatchObject({ command: 'auto-complete', actorRole: 'SYSTEM' });
    expect((await stateChanges(old.id)).at(-1)).toMatchObject({
      from: 'RETURNED',
      to: 'COMPLETED',
      actorId: null,
      mode: 'RENT',
    });
    expect((await get(oldLoan.id, oldLoan.buyer)).json().data.state).toBe('COMPLETED');
    expect((await get(recent.id, recent.buyer)).json().data.state).toBe('RETURNED');
    expect((await get(contested.id, contested.buyer)).json().data.state).toBe('DISPUTED');
  });
});

describe('event payloads', () => {
  it('every event of every flow validates against the contracts and carries mode', async () => {
    const ids = [(await disputed()).id, (await returned()).id, (await returned(lent)).id];
    for (const id of ids) {
      const events = await contractEvents(id);
      expect(events.length).toBeGreaterThan(1);
      for (const e of events) expect(e.p.mode).toEqual(expect.any(String));
    }
  });
});
