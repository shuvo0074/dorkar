import { randomUUID } from 'node:crypto';
import {
  ModerationEvents,
  ReputationEvents,
  TransactionEvents,
  type TransactionState,
} from '@dorkar/contracts';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildReputationService } from '../../src/app';

let t: TestService<Awaited<ReturnType<typeof buildReputationService>>>;
const app = () => t.svc.runtime.app;
const deliver = (e: Parameters<typeof t.svc.runtime.deliver>[0]) => t.svc.runtime.deliver(e);

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'reputation',
    migrations,
    build: (env, logger, verifier) => buildReputationService(env, logger, { verifier }),
  });
});
afterAll(() => t.close());

const DAY = 24 * 60 * 60 * 1000;

type UUID = ReturnType<typeof randomUUID>;

interface Deal {
  id: UUID;
  buyerId: UUID;
  sellerId: UUID;
}

const created = (d: Deal, occurredAt = new Date()) => ({
  ...envelope(
    TransactionEvents.TransactionCreated,
    {
      transactionId: d.id,
      sourceType: 'OFFER',
      sourceId: randomUUID(),
      needId: randomUUID(),
      buyerId: d.buyerId,
      sellerId: d.sellerId,
      amount: { amount: 150_000, currency: 'BDT' },
      quantity: 1,
      mode: 'BUY',
    },
    d.id,
  ),
  occurredAt: occurredAt.toISOString(),
});

const changed = (
  d: Deal,
  from: TransactionState,
  to: TransactionState,
  actorId: string | null,
  occurredAt = new Date(),
) => ({
  ...envelope(
    TransactionEvents.TransactionStateChanged,
    {
      transactionId: d.id,
      needId: null,
      sourceType: 'OFFER',
      sourceId: randomUUID(),
      buyerId: d.buyerId,
      sellerId: d.sellerId,
      from,
      to,
      actorId,
    },
    d.id,
  ),
  occurredAt: occurredAt.toISOString(),
});

/** A transaction between two accounts; completed unless told otherwise. */
async function deal(
  buyerId: UUID = randomUUID(),
  sellerId: UUID = randomUUID(),
  opts: { completedAt?: Date | null } = {},
): Promise<Deal> {
  const d = { id: randomUUID(), buyerId, sellerId };
  const completedAt = opts.completedAt ?? new Date();
  await deliver(created(d, new Date(completedAt.getTime() - 120_000)));
  await deliver(
    changed(d, 'CREATED', 'CONFIRMED', sellerId, new Date(completedAt.getTime() - 60_000)),
  );
  if (opts.completedAt !== null) {
    await deliver(changed(d, 'DELIVERED', 'COMPLETED', buyerId, completedAt));
  }
  return d;
}

const review = async (txId: string, authorId: string, payload: Record<string, unknown>) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/transactions/${txId}/reviews`,
    headers: await t.auth.as(authorId),
    payload,
  });

const summaryOf = async (userId: string) =>
  (await app().inject({ url: `/api/v1/users/${userId}/reviews` })).json().summary;

const outbox = async (aggregateId: string) =>
  t.svc.runtime.db
    .selectFrom('outbox')
    .select(['type', 'payload'])
    .where('aggregate_id', '=', aggregateId)
    .orderBy('occurred_at')
    .execute();

const parsePayload = (p: unknown) => (typeof p === 'string' ? JSON.parse(p) : p);

describe('creating a review', () => {
  it('lets a party review the other after completion; events match the contracts; audited', async () => {
    const d = await deal();
    const res = await review(d.id, d.buyerId, { rating: 4, comment: '  Fast and honest  ' });
    expect(res.statusCode).toBe(201);
    const body = res.json().data;
    expect(body).toMatchObject({
      transactionId: d.id,
      authorId: d.buyerId,
      subjectId: d.sellerId,
      authorRole: 'BUYER',
      rating: 4,
      comment: 'Fast and honest',
      status: 'VISIBLE',
    });

    const reviewEvents = await outbox(body.id);
    expect(reviewEvents.map((e) => e.type)).toEqual(['reputation.ReviewCreated']);
    expect(
      ReputationEvents.ReviewCreated.schema.parse(parsePayload(reviewEvents[0]!.payload)),
    ).toEqual({
      reviewId: body.id,
      transactionId: d.id,
      authorId: d.buyerId,
      subjectId: d.sellerId,
      rating: 4,
    });
    const updates = (await outbox(d.sellerId)).filter(
      (e) => e.type === 'reputation.ReputationUpdated',
    );
    const last = ReputationEvents.ReputationUpdated.schema.parse(
      parsePayload(updates.at(-1)!.payload),
    );
    expect(last).toEqual({
      accountId: d.sellerId,
      ratingAverage: 4,
      ratingCount: 1,
      completedCount: 1,
      cancelledCount: 0,
      disputedCount: 0,
    });

    const audit = await t.svc.runtime.db
      .selectFrom('audit_log')
      .select(['action', 'actor_id'])
      .where('target_id', '=', body.id)
      .execute();
    expect(audit).toEqual([{ action: 'review.create', actor_id: d.buyerId }]);

    // The seller can review back; both see both reviews.
    expect((await review(d.id, d.sellerId, { rating: 5 })).statusCode).toBe(201);
    for (const who of [d.buyerId, d.sellerId]) {
      const list = await app().inject({
        url: `/api/v1/transactions/${d.id}/reviews`,
        headers: await t.auth.as(who),
      });
      expect(list.statusCode).toBe(200);
      expect(
        list
          .json()
          .data.map((r: { authorRole: string }) => r.authorRole)
          .sort(),
      ).toEqual(['BUYER', 'SELLER']);
    }
  });

  it('refuses before completion (422 TRANSACTION_NOT_COMPLETED)', async () => {
    const d = await deal(undefined, undefined, { completedAt: null });
    const res = await review(d.id, d.buyerId, { rating: 5 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('TRANSACTION_NOT_COMPLETED');
  });

  it('hides the transaction from non-parties and unknown ids (404)', async () => {
    const d = await deal();
    expect((await review(d.id, randomUUID(), { rating: 5 })).statusCode).toBe(404);
    expect((await review(randomUUID(), d.buyerId, { rating: 5 })).statusCode).toBe(404);
    const list = await app().inject({
      url: `/api/v1/transactions/${d.id}/reviews`,
      headers: await t.auth.as(randomUUID()),
    });
    expect(list.statusCode).toBe(404);
  });

  it('allows one review per party per transaction, even under concurrency (409)', async () => {
    const d = await deal();
    const results = await Promise.all([
      review(d.id, d.buyerId, { rating: 5 }),
      review(d.id, d.buyerId, { rating: 1 }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await review(d.id, d.buyerId, { rating: 3 })).statusCode).toBe(409);
    expect((await summaryOf(d.sellerId)).ratingCount).toBe(1);
  });

  it('rejects contact details in the comment (422 NO_CONTACT_INFO)', async () => {
    const d = await deal();
    const res = await review(d.id, d.buyerId, { rating: 5, comment: 'call me 01712345678' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('NO_CONTACT_INFO');
  });

  it('validates the body', async () => {
    const d = await deal();
    expect((await review(d.id, d.buyerId, { rating: 6 })).statusCode).toBe(400);
    expect((await review(d.id, d.buyerId, { rating: 4.5 })).statusCode).toBe(400);
    expect((await review(d.id, d.buyerId, { rating: 5, subjectId: d.buyerId })).statusCode).toBe(
      400,
    );
    expect(
      (await review(d.id, d.buyerId, { rating: 5, comment: 'x'.repeat(1001) })).statusCode,
    ).toBe(400);
    expect(
      (
        await app().inject({
          method: 'POST',
          url: `/api/v1/transactions/${d.id}/reviews`,
          payload: { rating: 5 },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('closes the review window after REVIEW_WINDOW_DAYS', async () => {
    const old = await deal(undefined, undefined, { completedAt: new Date(Date.now() - 31 * DAY) });
    const res = await review(old.id, old.buyerId, { rating: 5 });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('REVIEW_WINDOW_CLOSED');

    const recent = await deal(undefined, undefined, {
      completedAt: new Date(Date.now() - 29 * DAY),
    });
    expect((await review(recent.id, recent.buyerId, { rating: 5 })).statusCode).toBe(201);
  });
});

describe('anti-manipulation and signals', () => {
  it('counts at most REVIEW_PAIR_CAP reviews per (author, subject) pair', async () => {
    const buyer = randomUUID();
    const seller = randomUUID();
    for (let i = 0; i < 4; i++) {
      const d = await deal(buyer, seller);
      expect((await review(d.id, buyer, { rating: 5 })).statusCode).toBe(201);
    }
    expect(await summaryOf(seller)).toMatchObject({
      ratingAverage: 5,
      ratingCount: 3,
      completedCount: 4,
      distinctCounterparties: 1,
    });

    // A distinct counterpart's 1-star now weighs against 3 (not 4) farmed 5-stars.
    const other = await deal(randomUUID(), seller);
    await review(other.id, other.buyerId, { rating: 1 });
    expect(await summaryOf(seller)).toMatchObject({
      ratingAverage: 4, // (3×5 + 1) / 4; uncapped would be 4.2
      ratingCount: 4,
      completedCount: 5,
      distinctCounterparties: 2,
    });
    // All reviews remain visible publicly; only the average is capped.
    const list = await app().inject({ url: `/api/v1/users/${seller}/reviews` });
    expect(list.json().data).toHaveLength(5);
  });

  it('counts a cancellation only for the party who cancelled', async () => {
    const d = await deal(undefined, undefined, { completedAt: null });
    await deliver(changed(d, 'CONFIRMED', 'CANCELLED', d.buyerId));
    expect(await summaryOf(d.buyerId)).toMatchObject({ cancelledCount: 1, completedCount: 0 });
    expect(await summaryOf(d.sellerId)).toMatchObject({ cancelledCount: 0 });
    const types = (await outbox(d.sellerId)).map((e) => e.type);
    expect(types).not.toContain('reputation.ReputationUpdated');
    const stats = await t.svc.runtime.db
      .selectFrom('account_stats')
      .selectAll()
      .where('account_id', '=', d.buyerId)
      .executeTakeFirstOrThrow();
    expect(stats).toMatchObject({ cancelled_count: 1, completed_count: 0 });
  });

  it('counts a dispute for both parties', async () => {
    const d = await deal(undefined, undefined, { completedAt: null });
    await deliver(changed(d, 'DELIVERED', 'DISPUTED', d.buyerId));
    for (const who of [d.buyerId, d.sellerId]) {
      expect(await summaryOf(who)).toMatchObject({ disputedCount: 1 });
      const updates = (await outbox(who)).filter((e) => e.type === 'reputation.ReputationUpdated');
      expect(updates).toHaveLength(1);
    }
  });

  it('tracks completion per role', async () => {
    const a = randomUUID();
    await deal(a);
    await deal(randomUUID(), a);
    const stats = await t.svc.runtime.db
      .selectFrom('account_stats')
      .selectAll()
      .where('account_id', '=', a)
      .executeTakeFirstOrThrow();
    expect(stats).toMatchObject({
      completed_count: 2,
      as_buyer_completed: 1,
      as_seller_completed: 1,
    });
  });

  it('is idempotent under redelivery and repeated transitions', async () => {
    const d: Deal = { id: randomUUID(), buyerId: randomUUID(), sellerId: randomUUID() };
    const c = created(d);
    expect(await deliver(c)).toBe(true);
    expect(await deliver(c)).toBe(false);
    const done = changed(d, 'DELIVERED', 'COMPLETED', d.buyerId);
    expect(await deliver(done)).toBe(true);
    expect(await deliver(done)).toBe(false);
    // Same transition re-published with a new event id must not double count.
    await deliver(changed(d, 'DELIVERED', 'COMPLETED', d.buyerId));
    expect(await summaryOf(d.sellerId)).toMatchObject({ completedCount: 1 });

    // Out-of-order: a late CONFIRMED does not undo COMPLETED.
    await deliver(changed(d, 'CREATED', 'CONFIRMED', d.sellerId, new Date(Date.now() - DAY)));
    expect((await review(d.id, d.buyerId, { rating: 5 })).statusCode).toBe(201);
  });

  it('accepts a state change that arrives before TransactionCreated', async () => {
    const d: Deal = { id: randomUUID(), buyerId: randomUUID(), sellerId: randomUUID() };
    await deliver(changed(d, 'DELIVERED', 'COMPLETED', d.buyerId));
    await deliver(created(d));
    expect((await review(d.id, d.sellerId, { rating: 4 })).statusCode).toBe(201);
    const row = await t.svc.runtime.db
      .selectFrom('transactions')
      .select(['state', 'mode'])
      .where('id', '=', d.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ state: 'COMPLETED', mode: 'BUY' });
  });
});

describe('moderation', () => {
  it('hiding a review removes it from the list and the rating; restoring brings it back', async () => {
    const seller = randomUUID();
    const d1 = await deal(randomUUID(), seller);
    const d2 = await deal(randomUUID(), seller);
    const bad = (await review(d1.id, d1.buyerId, { rating: 1, comment: 'rude' })).json().data;
    await review(d2.id, d2.buyerId, { rating: 5 });
    expect(await summaryOf(seller)).toMatchObject({ ratingAverage: 3, ratingCount: 2 });

    const moderate = (action: 'HIDE' | 'RESTORE') =>
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'REVIEW',
        targetId: bad.id,
        action,
        reason: 'abusive',
        moderatorId: randomUUID(),
      });
    const updatesBefore = (await outbox(seller)).length;
    const hide = moderate('HIDE');
    expect(await deliver(hide)).toBe(true);
    expect(await deliver(hide)).toBe(false);
    expect(await summaryOf(seller)).toMatchObject({ ratingAverage: 5, ratingCount: 1 });
    expect((await outbox(seller)).length).toBe(updatesBefore + 1);
    const list = (await app().inject({ url: `/api/v1/users/${seller}/reviews` })).json().data;
    expect(list.map((r: { id: string }) => r.id)).not.toContain(bad.id);

    const admin = await app().inject({
      url: '/api/v1/admin/reviews?status=HIDDEN',
      headers: await t.auth.as(randomUUID(), ['MODERATOR']),
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().data.map((r: { id: string }) => r.id)).toContain(bad.id);
    expect(admin.json().data.every((r: { status: string }) => r.status === 'HIDDEN')).toBe(true);

    await deliver(moderate('RESTORE'));
    expect(await summaryOf(seller)).toMatchObject({ ratingAverage: 3, ratingCount: 2 });
    const audit = await t.svc.runtime.db
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', bad.id)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['review.create', 'review.hide', 'review.restore']);
  });

  it('ignores other target types and unknown reviews', async () => {
    for (const targetType of ['LISTING', 'REVIEW'] as const) {
      expect(
        await deliver(
          envelope(ModerationEvents.ContentModerated, {
            caseId: randomUUID(),
            targetType,
            targetId: randomUUID(),
            action: 'HIDE',
            reason: 'x',
            moderatorId: randomUUID(),
          }),
        ),
      ).toBe(true);
    }
  });

  it('restricts the admin list to moderation:case:read', async () => {
    expect(
      (await app().inject({ url: '/api/v1/admin/reviews', headers: await t.auth.as(randomUUID()) }))
        .statusCode,
    ).toBe(403);
    expect((await app().inject({ url: '/api/v1/admin/reviews' })).statusCode).toBe(401);
  });
});

describe('public reviews', () => {
  it('paginates visible reviews newest first without leaking transaction details', async () => {
    const seller = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await deal(randomUUID(), seller);
      ids.push(
        (await review(d.id, d.buyerId, { rating: 3 + i, comment: `deal ${i}` })).json().data.id,
      );
    }
    const p1 = await app().inject({ url: `/api/v1/users/${seller}/reviews?limit=2` });
    expect(p1.statusCode).toBe(200);
    const b1 = p1.json();
    expect(b1.data.map((r: { id: string }) => r.id)).toEqual([ids[2], ids[1]]);
    expect(b1.page.nextCursor).toEqual(expect.any(String));
    expect(b1.summary).toMatchObject({ ratingAverage: 4, ratingCount: 3, completedCount: 3 });
    expect(Object.keys(b1.data[0]).sort()).toEqual(
      ['authorId', 'authorRole', 'comment', 'createdAt', 'id', 'rating'].sort(),
    );
    expect(JSON.stringify(b1)).not.toMatch(/transactionId|amount|150000/);

    const p2 = await app().inject({
      url: `/api/v1/users/${seller}/reviews?limit=2&cursor=${b1.page.nextCursor}`,
    });
    expect(p2.json().data.map((r: { id: string }) => r.id)).toEqual([ids[0]]);
    expect(p2.json().page.nextCursor).toBeNull();

    expect(
      (await app().inject({ url: `/api/v1/users/${seller}/reviews?cursor=garbage` })).statusCode,
    ).toBe(400);
  });

  it('returns an empty list and neutral signals for a user with no history', async () => {
    const res = await app().inject({ url: `/api/v1/users/${randomUUID()}/reviews` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [],
      page: { nextCursor: null },
      summary: {
        ratingAverage: null,
        ratingCount: 0,
        completedCount: 0,
        cancelledCount: 0,
        disputedCount: 0,
        distinctCounterparties: 0,
      },
    });
  });
});
