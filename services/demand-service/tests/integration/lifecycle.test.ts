import { randomUUID } from 'node:crypto';
import {
  DemandEvents,
  ModerationEvents,
  OfferEvents,
  TransactionEvents,
  type NeedStatus,
} from '@dorkar/contracts';
import { envelope, type TestService } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { needBody, seedCategory, startDemand, type Svc } from './harness';

let t: TestService<Svc>;
let cat: string;
const app = () => t.svc.runtime.app;
const rt = () => t.svc.runtime;

beforeAll(async () => {
  ({ t } = await startDemand());
  cat = await seedCategory(t);
});
afterAll(() => t.close());

const createNeed = async (owner: string, over: Record<string, unknown> = {}) => {
  const res = await app().inject({
    method: 'POST',
    url: '/api/v1/needs',
    headers: await t.auth.as(owner),
    payload: needBody(cat, over),
  });
  expect(res.statusCode).toBe(201);
  return res.json().data as { id: string; requesterId: string; status: NeedStatus };
};

const command = async (user: string, id: string, name: string) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/needs/${id}/${name}`,
    headers: await t.auth.as(user),
  });

const row = (id: string) =>
  rt().db.selectFrom('needs').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/**
 * Transitions in order (from the identity-ordered history), after checking that the outbox holds
 * exactly one NeedStatusChanged per history row. Outbox rows have no intra-millisecond order.
 */
const statusChanges = async (id: string) => {
  const fmt = (from: string | null, to: string) => `${from}>${to}`;
  const history = (
    await rt()
      .db.selectFrom('need_status_history')
      .select(['from_status', 'to_status'])
      .where('need_id', '=', id)
      .where('from_status', 'is not', null)
      .orderBy('id')
      .execute()
  ).map((h) => fmt(h.from_status, h.to_status));
  const events = (
    await rt()
      .db.selectFrom('outbox')
      .select('payload')
      .where('aggregate_id', '=', id)
      .where('type', '=', 'demand.NeedStatusChanged')
      .execute()
  ).map((r) => {
    const p = DemandEvents.NeedStatusChanged.schema.parse(r.payload);
    return fmt(p.from, p.to);
  });
  expect([...events].sort()).toEqual([...history].sort());
  return history;
};

/** Waits until `n` statements on this test's needs table are blocked on a row lock. */
const waitForLockWaiters = async (n: number) => {
  for (let i = 0; i < 200; i++) {
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from pg_stat_activity
      where wait_event_type = 'Lock' and query like ${`%"${t.schema}"."needs"%`}`.execute(rt().db);
    if (Number(rows[0]!.n) >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('requests never reached the lock');
};

const makeDue = (id: string) =>
  rt()
    .db.updateTable('needs')
    .set({ expires_at: sql<Date>`now() - interval '1 minute'` })
    .where('id', '=', id)
    .execute();

describe('expiry job', () => {
  it('expires only due OPEN/PAUSED needs, with history and events', async () => {
    const owner = randomUUID();
    const due = await createNeed(owner);
    const duePaused = await createNeed(owner);
    const notDue = await createNeed(owner);
    const dueDraft = await createNeed(owner, { publish: false });
    await command(owner, duePaused.id, 'pause');
    await makeDue(due.id);
    await makeDue(duePaused.id);

    const expired = await t.svc.expireNeeds();
    expect(expired).toBeGreaterThanOrEqual(2);
    expect((await row(due.id)).status).toBe('EXPIRED');
    expect((await row(duePaused.id)).status).toBe('EXPIRED');
    expect((await row(notDue.id)).status).toBe('OPEN');
    expect((await row(dueDraft.id)).status).toBe('DRAFT');
    expect(await statusChanges(due.id)).toEqual(['DRAFT>OPEN', 'OPEN>EXPIRED']);
    expect(await statusChanges(duePaused.id)).toEqual([
      'DRAFT>OPEN',
      'OPEN>PAUSED',
      'PAUSED>EXPIRED',
    ]);
    const history = await rt()
      .db.selectFrom('need_status_history')
      .selectAll()
      .where('need_id', '=', due.id)
      .orderBy('id')
      .execute();
    expect(history.at(-1)).toMatchObject({
      from_status: 'OPEN',
      to_status: 'EXPIRED',
      actor_id: null,
    });

    // Running again does nothing for these.
    await t.svc.expireNeeds();
    expect(await statusChanges(due.id)).toHaveLength(2);
  });

  it('refuses to resume a paused need past its expiry', async () => {
    const owner = randomUUID();
    const n = await createNeed(owner);
    await command(owner, n.id, 'pause');
    await makeDue(n.id);
    const res = await command(owner, n.id, 'resume');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('NEED_EXPIRED');
  });

  it('renews expired needs up to NEED_MAX_RENEWALS times with a fresh expiry', async () => {
    const owner = randomUUID();
    const n = await createNeed(owner);
    for (let i = 1; i <= 2; i++) {
      await makeDue(n.id);
      await t.svc.expireNeeds();
      const before = Date.now();
      const res = await command(owner, n.id, 'renew');
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ status: 'OPEN', renewals: i });
      expect(Date.parse(res.json().data.expiresAt)).toBeGreaterThan(before + 13 * 86_400_000);
    }
    await makeDue(n.id);
    await t.svc.expireNeeds();
    const third = await command(owner, n.id, 'renew');
    expect(third.statusCode).toBe(422);
    expect(third.json().error.details.rule).toBe('MAX_RENEWALS_REACHED');
    expect((await command(randomUUID(), n.id, 'renew')).statusCode).toBe(404);
  });
});

describe('offer and transaction events', () => {
  const offer = (needId: string, quantity: number, offerId = randomUUID()) => ({
    offerId,
    needId,
    buyerId: randomUUID(),
    sellerId: randomUUID(),
    listingId: null,
    mode: 'BUY' as const,
    price: { amount: 7_500_000, currency: 'BDT' as const },
    quantity,
    terms: {},
  });

  it('counts offers, moves to FULFILLING, back to OPEN on cancellation, then FULFILLED', async () => {
    const owner = randomUUID();
    const n = await createNeed(owner, { quantity: 3 });

    const submitted = envelope(OfferEvents.OfferSubmitted, {
      offerId: randomUUID(),
      needId: n.id,
      buyerId: owner,
      sellerId: randomUUID(),
      price: { amount: 100, currency: 'BDT' },
      quantity: 1,
    });
    expect(await rt().deliver(submitted)).toBe(true);
    expect(await rt().deliver(submitted)).toBe(false); // redelivery is a no-op
    expect((await row(n.id)).offer_count).toBe(1);

    const a = offer(n.id, 2);
    const b = offer(n.id, 1);
    await rt().deliver(envelope(OfferEvents.OfferAccepted, a));
    expect(await row(n.id)).toMatchObject({ status: 'OPEN', accepted_quantity: 2 });
    const acceptB = envelope(OfferEvents.OfferAccepted, b);
    await rt().deliver(acceptB);
    expect(await row(n.id)).toMatchObject({ status: 'FULFILLING', accepted_quantity: 3 });
    // Same accept re-published with a new envelope id: still counted once.
    await rt().deliver(envelope(OfferEvents.OfferAccepted, b));
    expect((await row(n.id)).accepted_quantity).toBe(3);

    // Cancellation of an accepted offer re-opens the need.
    const cancelB = envelope(OfferEvents.OfferStatusChanged, {
      offerId: b.offerId,
      needId: n.id,
      buyerId: b.buyerId,
      sellerId: b.sellerId,
      from: 'ACCEPTED',
      to: 'CANCELLED',
      reason: 'transaction cancelled',
    });
    await rt().deliver(cancelB);
    expect(await row(n.id)).toMatchObject({ status: 'OPEN', accepted_quantity: 2 });
    await rt().deliver({ ...cancelB, id: randomUUID() });
    expect((await row(n.id)).accepted_quantity).toBe(2);

    // Other offer status changes are ignored.
    await rt().deliver(
      envelope(OfferEvents.OfferStatusChanged, {
        offerId: a.offerId,
        needId: n.id,
        buyerId: a.buyerId,
        sellerId: a.sellerId,
        from: 'SUBMITTED',
        to: 'WITHDRAWN',
        reason: 'x',
      }),
    );
    expect((await row(n.id)).accepted_quantity).toBe(2);

    const c = offer(n.id, 1);
    await rt().deliver(envelope(OfferEvents.OfferAccepted, c));
    expect((await row(n.id)).status).toBe('FULFILLING');

    const completed = (o: ReturnType<typeof offer>) =>
      envelope(TransactionEvents.TransactionStateChanged, {
        transactionId: randomUUID(),
        needId: n.id,
        sourceType: 'OFFER',
        sourceId: o.offerId,
        buyerId: o.buyerId,
        sellerId: o.sellerId,
        from: 'DELIVERED',
        to: 'COMPLETED',
        actorId: null,
      });
    await rt().deliver(completed(a));
    expect((await row(n.id)).status).toBe('FULFILLING'); // c not completed yet
    await rt().deliver(completed(c));
    expect((await row(n.id)).status).toBe('FULFILLED');

    expect(await statusChanges(n.id)).toEqual([
      'DRAFT>OPEN',
      'OPEN>FULFILLING',
      'FULFILLING>OPEN',
      'OPEN>FULFILLING',
      'FULFILLING>FULFILLED',
    ]);
  });

  it('moves to FULFILLING on resume when offers accepted while paused cover the quantity', async () => {
    const owner = randomUUID();
    const n = await createNeed(owner, { quantity: 1 });
    await command(owner, n.id, 'pause');
    await rt().deliver(envelope(OfferEvents.OfferAccepted, offer(n.id, 1)));
    expect(await row(n.id)).toMatchObject({ status: 'PAUSED', accepted_quantity: 1 });
    const res = await command(owner, n.id, 'resume');
    expect(res.json().data.status).toBe('FULFILLING');
    expect(await statusChanges(n.id)).toEqual([
      'DRAFT>OPEN',
      'OPEN>PAUSED',
      'PAUSED>OPEN',
      'OPEN>FULFILLING',
    ]);
  });

  it('ignores events for unknown needs', async () => {
    await rt().deliver(envelope(OfferEvents.OfferAccepted, offer(randomUUID(), 1)));
  });

  it('refuses material edits once offers exist', async () => {
    const owner = randomUUID();
    const n = await createNeed(owner, { quantity: 4 });
    const other = await seedCategory(t);
    const patch = async (payload: Record<string, unknown>) =>
      app().inject({
        method: 'PATCH',
        url: `/api/v1/needs/${n.id}`,
        headers: await t.auth.as(owner),
        payload,
      });
    // Before offers: category changes are fine.
    expect((await patch({ categoryId: other })).statusCode).toBe(200);
    expect((await patch({ categoryId: cat })).statusCode).toBe(200);

    await rt().deliver(
      envelope(OfferEvents.OfferSubmitted, {
        offerId: randomUUID(),
        needId: n.id,
        buyerId: owner,
        sellerId: randomUUID(),
        price: { amount: 100, currency: 'BDT' },
        quantity: 2,
      }),
    );
    await rt().deliver(envelope(OfferEvents.OfferAccepted, offer(n.id, 2)));

    for (const [payload, field] of [
      [{ categoryId: other }, 'categoryId'],
      [
        {
          mode: 'RENT',
          modeTerms: { startAt: '2026-11-01T09:00:00Z', endAt: '2026-11-02T09:00:00Z' },
        },
        'mode',
      ],
      [{ quantity: 1 }, 'quantity'],
    ] as const) {
      const res = await patch(payload);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.details).toMatchObject({
        rule: 'MATERIAL_CHANGE_WITH_OFFERS',
        field,
      });
    }
    // Non-material edits still work; lowering quantity to what was accepted fulfils the need.
    expect((await patch({ title: 'Updated title here' })).statusCode).toBe(200);
    const res = await patch({ quantity: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('FULFILLING');
  });
});

describe('moderation', () => {
  it('hides and restores via the admin endpoint (permission-gated, audited)', async () => {
    const owner = randomUUID();
    const n = await createNeed(owner);
    const mod = randomUUID();
    const call = async (action: string, roles: Parameters<typeof t.auth.as>[1]) =>
      app().inject({
        method: 'POST',
        url: `/api/v1/admin/needs/${n.id}/${action}`,
        headers: await t.auth.as(mod, roles),
        payload: { reason: 'Prohibited item' },
      });

    expect((await call('hide', ['MEMBER'])).statusCode).toBe(403);
    const hidden = await call('hide', ['MODERATOR']);
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json().data).toEqual({ id: n.id, status: 'HIDDEN' });
    expect((await call('hide', ['MODERATOR'])).statusCode).toBe(409);

    // Hidden: public 404, owner still sees it with the moderator note redacted.
    expect((await app().inject({ url: `/api/v1/needs/${n.id}` })).statusCode).toBe(404);
    const ownerView = await app().inject({
      url: `/api/v1/needs/${n.id}`,
      headers: await t.auth.as(owner),
    });
    expect(ownerView.json().data.status).toBe('HIDDEN');
    expect(ownerView.json().data.history.at(-1).reason).toBe('MODERATION');
    expect(JSON.stringify(ownerView.json())).not.toContain('Prohibited');
    expect((await command(owner, n.id, 'close')).statusCode).toBe(409);

    const restored = await call('restore', ['MODERATOR']);
    expect(restored.json().data.status).toBe('OPEN');
    expect(await statusChanges(n.id)).toEqual(['DRAFT>OPEN', 'OPEN>HIDDEN', 'HIDDEN>OPEN']);

    const audits = await rt()
      .db.selectFrom('audit_log')
      .select(['action', 'actor_id', 'actor_type'])
      .where('target_id', '=', n.id)
      .orderBy('occurred_at')
      .execute();
    expect(audits).toEqual([
      { action: 'need.hidden', actor_id: mod, actor_type: 'ADMIN' },
      { action: 'need.restored', actor_id: mod, actor_type: 'ADMIN' },
    ]);
    expect(
      (
        await app().inject({
          method: 'POST',
          url: `/api/v1/admin/needs/${randomUUID()}/hide`,
          headers: await t.auth.as(mod, ['MODERATOR']),
          payload: { reason: 'Prohibited item' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('applies ContentModerated events idempotently and restores the previous status', async () => {
    const owner = randomUUID();
    const n = await createNeed(owner);
    await command(owner, n.id, 'pause');
    const moderated = (action: 'HIDE' | 'RESTORE') =>
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'NEED',
        targetId: n.id,
        action,
        reason: 'reported',
        moderatorId: randomUUID(),
      });
    await rt().deliver(moderated('HIDE'));
    expect((await row(n.id)).status).toBe('HIDDEN');
    await rt().deliver(moderated('HIDE')); // already hidden: no-op
    await rt().deliver(moderated('RESTORE'));
    expect((await row(n.id)).status).toBe('PAUSED');
    await rt().deliver(moderated('RESTORE'));
    expect(await statusChanges(n.id)).toEqual([
      'DRAFT>OPEN',
      'OPEN>PAUSED',
      'PAUSED>HIDDEN',
      'HIDDEN>PAUSED',
    ]);

    // Other targets are ignored.
    await rt().deliver(
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'LISTING',
        targetId: n.id,
        action: 'HIDE',
        reason: 'x',
        moderatorId: randomUUID(),
      }),
    );
    expect((await row(n.id)).status).toBe('PAUSED');
  });
});

describe('concurrency', () => {
  it('lets exactly one of a concurrent close and pause succeed', async () => {
    for (let i = 0; i < 3; i++) {
      const owner = randomUUID();
      const n = await createNeed(owner);
      // Hold the row so both requests read OPEN/v1 and then race on the guarded UPDATE.
      const pending = await rt()
        .db.transaction()
        .execute(async (trx) => {
          await trx.selectFrom('needs').select('id').where('id', '=', n.id).forUpdate().execute();
          const reqs = Promise.all([command(owner, n.id, 'close'), command(owner, n.id, 'pause')]);
          await waitForLockWaiters(2);
          return { reqs };
        });
      const results = await pending.reqs;
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 409]);
      const winner = results.find((r) => r.statusCode === 200)!.json().data.status;
      expect((await row(n.id)).status).toBe(winner);
      expect(await statusChanges(n.id)).toEqual(['DRAFT>OPEN', `OPEN>${winner}`]);
    }
  });

  it('does not exceed the open-need limit under concurrent publishes', async () => {
    const owner = randomUUID();
    // Default limit is 20: create 19 open, then race two more.
    for (let i = 0; i < 19; i++) await createNeed(owner);
    const headers = await t.auth.as(owner);
    const results = await Promise.all(
      [0, 1].map(() =>
        app().inject({ method: 'POST', url: '/api/v1/needs', headers, payload: needBody(cat) }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 422]);
  });
});
