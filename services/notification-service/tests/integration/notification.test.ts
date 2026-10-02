import { randomUUID } from 'node:crypto';
import {
  DemandEvents,
  MatchingEvents,
  OfferEvents,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
} from '@dorkar/contracts';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import type { ContactDirectory } from '../../src/application/ports';
import { buildNotificationService } from '../../src/app';
import { pgNotificationStore } from '../../src/infrastructure/pg-notification-store';
import { RecordingSmsChannel } from '../../src/infrastructure/sms/sms-channels';

class FakeContacts implements ContactDirectory {
  readonly phones = new Map<string, string>();
  lookups = 0;
  failNext = 0;
  async phoneOf(accountId: string): Promise<string | null> {
    this.lookups++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('identity down');
    }
    return this.phones.get(accountId) ?? null;
  }
}

const sms = new RecordingSmsChannel();
const contacts = new FakeContacts();

let t: TestService<Awaited<ReturnType<typeof buildNotificationService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;
const deliver = (e: Parameters<typeof t.svc.runtime.deliver>[0]) => t.svc.runtime.deliver(e);

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'notification',
    migrations,
    env: { PUBLIC_BASE_URL: 'https://dorkar.com.bd', SMS_MAX_ATTEMPTS: '3' },
    build: (env, logger, verifier) =>
      buildNotificationService(env, logger, { verifier, contacts, sms }),
  });
});
afterAll(() => t.close());

const price = { amount: 1_500_00, currency: 'BDT' as const };

const notificationsOf = (recipientId: string) =>
  db()
    .selectFrom('notifications')
    .select(['id', 'type', 'payload', 'source_event_id', 'in_app'])
    .where('recipient_id', '=', recipientId)
    .orderBy('created_at')
    .execute();

const deliveriesOf = (recipientId: string) =>
  db()
    .selectFrom('deliveries as d')
    .innerJoin('notifications as n', 'n.id', 'd.notification_id')
    .select([
      'd.id',
      'd.channel',
      'd.status',
      'd.attempts',
      'd.last_error',
      'd.next_attempt_at',
      'n.type',
    ])
    .where('n.recipient_id', '=', recipientId)
    .execute();

/** Makes every pending delivery due now (instead of waiting out the backoff). */
const makeDue = () =>
  db()
    .updateTable('deliveries')
    .set({ next_attempt_at: sql<Date>`now()` })
    .where('status', '=', 'PENDING')
    .execute();

const offerSubmitted = (buyerId: string, sellerId: string) =>
  envelope(OfferEvents.OfferSubmitted, {
    offerId: randomUUID(),
    needId: randomUUID(),
    buyerId,
    sellerId,
    price,
    quantity: 1,
  });

describe('consuming marketplace events', () => {
  it('notifies the right people for every event type', async () => {
    const buyer = randomUUID();
    const seller = randomUUID();
    const offer = { offerId: randomUUID(), needId: randomUUID(), buyerId: buyer, sellerId: seller };
    const tx = {
      transactionId: randomUUID(),
      needId: offer.needId,
      sourceType: 'OFFER' as const,
      sourceId: offer.offerId,
      buyerId: buyer,
      sellerId: seller,
    };
    const events = [
      envelope(MatchingEvents.MatchFound, {
        matchId: randomUUID(),
        needId: offer.needId,
        requesterId: buyer,
        sellerId: seller,
        listingId: null,
        score: 0.9,
      }),
      envelope(OfferEvents.OfferSubmitted, { ...offer, price, quantity: 1 }),
      envelope(OfferEvents.OfferCountered, { ...offer, by: 'BUYER', round: 1, price, quantity: 1 }),
      envelope(OfferEvents.OfferCountered, {
        ...offer,
        by: 'SELLER',
        round: 2,
        price,
        quantity: 1,
      }),
      envelope(OfferEvents.OfferAccepted, {
        ...offer,
        listingId: null,
        mode: 'BUY',
        price,
        quantity: 1,
        terms: {},
      }),
      envelope(OfferEvents.OfferStatusChanged, {
        ...offer,
        from: 'SUBMITTED',
        to: 'REJECTED',
        reason: 'BUYER',
      }),
      envelope(OfferEvents.OfferStatusChanged, {
        ...offer,
        from: 'SUBMITTED',
        to: 'EXPIRED',
        reason: 'NEED_CLOSED',
      }),
      envelope(OfferEvents.OfferStatusChanged, {
        ...offer,
        from: 'SUBMITTED',
        to: 'EXPIRED',
        reason: 'TIMEOUT',
      }),
      envelope(TransactionEvents.TransactionCreated, {
        ...tx,
        amount: price,
        quantity: 1,
        mode: 'BUY',
      }),
      envelope(TransactionEvents.TransactionStateChanged, {
        ...tx,
        from: 'CREATED',
        to: 'CONFIRMED',
        actorId: seller,
      }),
      envelope(DemandEvents.NeedStatusChanged, {
        needId: offer.needId,
        requesterId: buyer,
        from: 'OPEN',
        to: 'FULFILLING',
        reason: 'OFFER_ACCEPTED',
      }),
      envelope(DemandEvents.NeedStatusChanged, {
        needId: offer.needId,
        requesterId: buyer,
        from: 'OPEN',
        to: 'EXPIRED',
        reason: 'TIMEOUT',
      }),
      envelope(ReputationEvents.ReviewCreated, {
        reviewId: randomUUID(),
        transactionId: tx.transactionId,
        authorId: buyer,
        subjectId: seller,
        rating: 5,
      }),
      envelope(VerificationEvents.VerificationStatusChanged, {
        accountId: seller,
        kind: 'NID',
        status: 'VERIFIED',
      }),
      envelope(VerificationEvents.VerificationStatusChanged, {
        accountId: seller,
        kind: 'PHONE',
        status: 'VERIFIED',
      }),
    ];
    for (const e of events) expect(await deliver(e)).toBe(true);

    expect((await notificationsOf(buyer)).map((n) => n.type).sort()).toEqual(
      [
        'OFFER_RECEIVED',
        'OFFER_COUNTERED',
        'TRANSACTION_CREATED',
        'TRANSACTION_UPDATED',
        'NEED_FULFILLING',
        'NEED_EXPIRED',
      ].sort(),
    );
    expect((await notificationsOf(seller)).map((n) => n.type).sort()).toEqual(
      [
        'NEED_MATCHED',
        'OFFER_COUNTERED',
        'OFFER_ACCEPTED',
        'OFFER_REJECTED',
        'OFFER_CLOSED',
        'TRANSACTION_CREATED',
        'REVIEW_RECEIVED',
        'VERIFICATION_UPDATED',
      ].sort(),
    );
    const received = (await notificationsOf(buyer)).find((n) => n.type === 'OFFER_RECEIVED');
    expect(received?.payload).toEqual({ offerId: offer.offerId, needId: offer.needId, price });

    // Default SMS: OFFER_RECEIVED + TRANSACTION_CREATED for the buyer; OFFER_ACCEPTED + TRANSACTION_CREATED for the seller.
    expect((await deliveriesOf(buyer)).map((d) => d.type).sort()).toEqual([
      'OFFER_RECEIVED',
      'TRANSACTION_CREATED',
    ]);
    expect((await deliveriesOf(seller)).map((d) => d.type).sort()).toEqual([
      'OFFER_ACCEPTED',
      'TRANSACTION_CREATED',
    ]);
    expect(
      (await deliveriesOf(seller)).every((d) => d.channel === 'SMS' && d.status === 'PENDING'),
    ).toBe(true);
  });

  it('is idempotent under redelivery: no duplicate notifications or deliveries', async () => {
    const buyer = randomUUID();
    const e = offerSubmitted(buyer, randomUUID());
    expect(await deliver(e)).toBe(true);
    expect(await deliver(e)).toBe(false);
    expect(await notificationsOf(buyer)).toHaveLength(1);
    expect(await deliveriesOf(buyer)).toHaveLength(1);
  });

  it('dedupes per (event, recipient, type) even past the inbox', async () => {
    const buyer = randomUUID();
    const e = offerSubmitted(buyer, randomUUID());
    const { notifications } = t.svc;
    const intents = [{ recipientId: buyer, type: 'OFFER_RECEIVED' as const, payload: {} }];
    expect(await notifications.onEvent(pgNotificationStore(db()), e, intents)).toBe(1);
    expect(await notifications.onEvent(pgNotificationStore(db()), e, intents)).toBe(0);
    expect(await deliveriesOf(buyer)).toHaveLength(1);
  });

  it('honours preferences: SMS off → no delivery; everything off → no notification', async () => {
    const buyer = randomUUID();
    const headers = await t.auth.as(buyer);
    const put = await app().inject({
      method: 'PUT',
      url: '/api/v1/me/notifications/preferences',
      headers,
      payload: {
        items: [
          { type: 'OFFER_RECEIVED', inApp: true, sms: false },
          { type: 'TRANSACTION_CREATED', inApp: false, sms: false },
        ],
      },
    });
    expect(put.statusCode).toBe(200);

    await deliver(offerSubmitted(buyer, randomUUID()));
    await deliver(
      envelope(TransactionEvents.TransactionCreated, {
        transactionId: randomUUID(),
        sourceType: 'LISTING',
        sourceId: randomUUID(),
        needId: null,
        buyerId: buyer,
        sellerId: randomUUID(),
        amount: price,
        quantity: 1,
        mode: 'BUY',
      }),
    );
    expect((await notificationsOf(buyer)).map((n) => n.type)).toEqual(['OFFER_RECEIVED']);
    expect(await deliveriesOf(buyer)).toHaveLength(0);
  });

  it('SMS-only preference records a hidden notification that carries the delivery', async () => {
    const user = randomUUID();
    const headers = await t.auth.as(user);
    await app().inject({
      method: 'PUT',
      url: '/api/v1/me/notifications/preferences',
      headers,
      payload: { items: [{ type: 'REVIEW_RECEIVED', inApp: false, sms: true }] },
    });
    await deliver(
      envelope(ReputationEvents.ReviewCreated, {
        reviewId: randomUUID(),
        transactionId: randomUUID(),
        authorId: randomUUID(),
        subjectId: user,
        rating: 4,
      }),
    );
    expect(await notificationsOf(user)).toMatchObject([{ type: 'REVIEW_RECEIVED', in_app: false }]);
    expect(await deliveriesOf(user)).toMatchObject([
      { type: 'REVIEW_RECEIVED', status: 'PENDING' },
    ]);
    const list = await app().inject({ url: '/api/v1/me/notifications', headers });
    expect(list.json().data).toEqual([]);
    const count = await app().inject({ url: '/api/v1/me/notifications/unread-count', headers });
    expect(count.json().data.count).toBe(0);
  });
});

describe('SMS dispatch', () => {
  beforeEach(async () => {
    // Isolate each test's deliveries from those queued earlier in the file.
    await db()
      .updateTable('deliveries')
      .set({ status: 'SKIPPED' })
      .where('status', '=', 'PENDING')
      .execute();
    sms.sent.length = 0;
    sms.failNext = 0;
    contacts.failNext = 0;
  });

  it('sends once, with a short safe text, and never logs the number or text', async () => {
    const buyer = randomUUID();
    const phone = '+8801712345678';
    contacts.phones.set(buyer, phone);
    await deliver(offerSubmitted(buyer, randomUUID()));

    expect(await t.svc.dispatcher.runOnce()).toBe(1);
    expect(sms.sent).toHaveLength(1);
    const [msg] = sms.sent;
    expect(msg!.to).toBe(phone);
    const [note] = await notificationsOf(buyer);
    expect(msg!.text).toBe(
      `Dorkar: You received an offer of ৳1,500 on your request. dorkar.com.bd/n/${note!.id}`,
    );
    expect(msg!.text).not.toMatch(/01[3-9]\d{8}/);
    expect(await deliveriesOf(buyer)).toMatchObject([{ status: 'SENT', attempts: 1 }]);

    // Nothing left: a second pass sends nothing.
    expect(await t.svc.dispatcher.runOnce()).toBe(0);
    expect(sms.sent).toHaveLength(1);

    const logs = t.logLines.join('\n');
    expect(logs).toContain('sms sent');
    expect(logs).not.toContain('1712345678');
    expect(logs).not.toContain('received an offer');
  });

  it('retries with exponential backoff, then marks FAILED after the last attempt', async () => {
    const buyer = randomUUID();
    const phone = '+8801812345679';
    contacts.phones.set(buyer, phone);
    await deliver(offerSubmitted(buyer, randomUUID()));
    sms.failNext = 3; // SMS_MAX_ATTEMPTS=3 in this suite

    const before = Date.now();
    await t.svc.dispatcher.runOnce();
    let [d] = await deliveriesOf(buyer);
    expect(d).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'Error' });
    const firstDelay = d!.next_attempt_at.getTime() - before;
    expect(firstDelay).toBeGreaterThan(25_000);
    expect(firstDelay).toBeLessThan(40_000);

    // Not due yet: nothing happens.
    expect(await t.svc.dispatcher.runOnce()).toBe(0);

    await makeDue();
    const before2 = Date.now();
    await t.svc.dispatcher.runOnce();
    [d] = await deliveriesOf(buyer);
    expect(d).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(d!.next_attempt_at.getTime() - before2).toBeGreaterThan(55_000);

    await makeDue();
    await t.svc.dispatcher.runOnce();
    [d] = await deliveriesOf(buyer);
    expect(d).toMatchObject({ status: 'FAILED', attempts: 3 });
    expect(sms.sent).toHaveLength(0);

    // The simulated provider error echoes the number; it must not reach logs or the row.
    expect(t.logLines.join('\n')).not.toContain('1812345679');
    expect(d!.last_error).not.toContain('1812345679');
  });

  it('recovers when a retry succeeds', async () => {
    const buyer = randomUUID();
    contacts.phones.set(buyer, '+8801912345670');
    await deliver(offerSubmitted(buyer, randomUUID()));
    contacts.failNext = 1; // identity briefly unavailable
    await t.svc.dispatcher.runOnce();
    expect(await deliveriesOf(buyer)).toMatchObject([{ status: 'PENDING', attempts: 1 }]);
    await makeDue();
    await t.svc.dispatcher.runOnce();
    expect(await deliveriesOf(buyer)).toMatchObject([{ status: 'SENT', attempts: 2 }]);
    expect(sms.sent).toHaveLength(1);
  });

  it('SKIPs unknown or inactive accounts without sending', async () => {
    const ghost = randomUUID();
    await deliver(offerSubmitted(ghost, randomUUID()));
    await t.svc.dispatcher.runOnce();
    expect(await deliveriesOf(ghost)).toMatchObject([
      { status: 'SKIPPED', last_error: 'RECIPIENT_UNAVAILABLE' },
    ]);
    expect(sms.sent).toHaveLength(0);
  });

  it('SKIPs when the user turned SMS off after it was queued', async () => {
    const buyer = randomUUID();
    contacts.phones.set(buyer, '+8801512345671');
    await deliver(offerSubmitted(buyer, randomUUID()));
    await app().inject({
      method: 'PUT',
      url: '/api/v1/me/notifications/preferences',
      headers: await t.auth.as(buyer),
      payload: { items: [{ type: 'OFFER_RECEIVED', inApp: true, sms: false }] },
    });
    const lookups = contacts.lookups;
    await t.svc.dispatcher.runOnce();
    expect(await deliveriesOf(buyer)).toMatchObject([
      { status: 'SKIPPED', last_error: 'OPTED_OUT' },
    ]);
    expect(contacts.lookups).toBe(lookups); // no needless contact lookup
    expect(sms.sent).toHaveLength(0);
  });

  it('concurrent dispatchers never send the same delivery twice', async () => {
    const ids = Array.from({ length: 6 }, () => randomUUID());
    for (const id of ids) {
      contacts.phones.set(id, '+8801612345672');
      await deliver(offerSubmitted(id, randomUUID()));
    }
    const counts = await Promise.all([t.svc.dispatcher.runOnce(), t.svc.dispatcher.runOnce()]);
    expect(counts[0] + counts[1]).toBe(6);
    expect(sms.sent).toHaveLength(6);
  });
});

describe('my notifications', () => {
  const seed = async (recipient: string, n: number) => {
    for (let i = 0; i < n; i++) await deliver(offerSubmitted(recipient, randomUUID()));
  };

  it('lists newest first with keyset pagination', async () => {
    const me = randomUUID();
    await seed(me, 5);
    const headers = await t.auth.as(me);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/me/notifications?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app().inject({ url, headers });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      seen.push(...body.data.map((n: { id: string }) => n.id));
      cursor = body.page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    const all = await db()
      .selectFrom('notifications')
      .select('id')
      .where('recipient_id', '=', me)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    expect(seen).toEqual(all.map((r) => r.id));
    expect(new Set(seen).size).toBe(5);

    const first = (await app().inject({ url: '/api/v1/me/notifications?limit=1', headers })).json()
      .data[0];
    expect(first).toMatchObject({ type: 'OFFER_RECEIVED', read: false, readAt: null });
    expect(first.payload.price).toEqual(price);
  });

  it('rejects bad cursors and unknown query keys', async () => {
    const headers = await t.auth.as(randomUUID());
    expect(
      (await app().inject({ url: '/api/v1/me/notifications?cursor=nope', headers })).statusCode,
    ).toBe(400);
    expect(
      (await app().inject({ url: '/api/v1/me/notifications?userId=x', headers })).statusCode,
    ).toBe(400);
  });

  it('reads one, counts unread, filters unread, and reads all', async () => {
    const me = randomUUID();
    await seed(me, 3);
    const headers = await t.auth.as(me);
    const count = async () =>
      (await app().inject({ url: '/api/v1/me/notifications/unread-count', headers })).json().data
        .count;
    expect(await count()).toBe(3);

    const [n] = (await app().inject({ url: '/api/v1/me/notifications', headers })).json().data;
    const read = await app().inject({
      method: 'POST',
      url: `/api/v1/me/notifications/${n.id}/read`,
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({ id: n.id, read: true });
    const firstReadAt = read.json().data.readAt;
    // Reading again is harmless and keeps the first read time.
    const again = await app().inject({
      method: 'POST',
      url: `/api/v1/me/notifications/${n.id}/read`,
      headers,
    });
    expect(again.json().data.readAt).toBe(firstReadAt);
    expect(await count()).toBe(2);

    const unread = await app().inject({ url: '/api/v1/me/notifications?unreadOnly=true', headers });
    expect(unread.json().data).toHaveLength(2);
    expect(unread.json().data.map((x: { id: string }) => x.id)).not.toContain(n.id);

    const all = await app().inject({
      method: 'POST',
      url: '/api/v1/me/notifications/read-all',
      headers,
    });
    expect(all.json().data.updated).toBe(2);
    expect(await count()).toBe(0);
  });

  it("never exposes or touches another user's notifications", async () => {
    const owner = randomUUID();
    const other = randomUUID();
    await seed(owner, 2);
    const ownerHeaders = await t.auth.as(owner);
    const otherHeaders = await t.auth.as(other);
    const [n] = (
      await app().inject({ url: '/api/v1/me/notifications', headers: ownerHeaders })
    ).json().data;

    const steal = await app().inject({
      method: 'POST',
      url: `/api/v1/me/notifications/${n.id}/read`,
      headers: otherHeaders,
    });
    expect(steal.statusCode).toBe(404);
    const missing = await app().inject({
      method: 'POST',
      url: `/api/v1/me/notifications/${randomUUID()}/read`,
      headers: otherHeaders,
    });
    expect(missing.json().error.code).toBe(steal.json().error.code);

    await app().inject({
      method: 'POST',
      url: '/api/v1/me/notifications/read-all',
      headers: otherHeaders,
    });
    expect(
      (await app().inject({ url: '/api/v1/me/notifications', headers: otherHeaders })).json().data,
    ).toEqual([]);
    expect(
      (
        await app().inject({ url: '/api/v1/me/notifications/unread-count', headers: ownerHeaders })
      ).json().data.count,
    ).toBe(2);
  });

  it('requires authentication on every route', async () => {
    const id = randomUUID();
    const calls = [
      { method: 'GET' as const, url: '/api/v1/me/notifications' },
      { method: 'GET' as const, url: '/api/v1/me/notifications/unread-count' },
      { method: 'POST' as const, url: `/api/v1/me/notifications/${id}/read` },
      { method: 'POST' as const, url: '/api/v1/me/notifications/read-all' },
      { method: 'GET' as const, url: '/api/v1/me/notifications/preferences' },
      {
        method: 'PUT' as const,
        url: '/api/v1/me/notifications/preferences',
        payload: { items: [{ type: 'NEED_MATCHED', inApp: true, sms: true }] },
      },
    ];
    for (const c of calls) expect((await app().inject(c)).statusCode, c.url).toBe(401);
  });
});

describe('preferences', () => {
  it('returns effective defaults for every type, stores only overrides', async () => {
    const me = randomUUID();
    const headers = await t.auth.as(me);
    const res = await app().inject({ url: '/api/v1/me/notifications/preferences', headers });
    expect(res.statusCode).toBe(200);
    const prefs = res.json().data as { type: string; inApp: boolean; sms: boolean }[];
    expect(prefs).toHaveLength(12);
    expect(
      prefs
        .filter((p) => p.sms)
        .map((p) => p.type)
        .sort(),
    ).toEqual(['OFFER_ACCEPTED', 'OFFER_RECEIVED', 'TRANSACTION_CREATED']);

    const put = await app().inject({
      method: 'PUT',
      url: '/api/v1/me/notifications/preferences',
      headers,
      payload: {
        items: [
          { type: 'NEED_MATCHED', inApp: true, sms: true },
          { type: 'OFFER_RECEIVED', inApp: true, sms: true }, // equals the default
        ],
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().data.find((p: { type: string }) => p.type === 'NEED_MATCHED')).toEqual({
      type: 'NEED_MATCHED',
      inApp: true,
      sms: true,
    });
    const stored = await db()
      .selectFrom('notification_preferences')
      .select('type')
      .where('account_id', '=', me)
      .execute();
    expect(stored.map((r) => r.type)).toEqual(['NEED_MATCHED']);

    // Back to default removes the override.
    await app().inject({
      method: 'PUT',
      url: '/api/v1/me/notifications/preferences',
      headers,
      payload: { items: [{ type: 'NEED_MATCHED', inApp: true, sms: false }] },
    });
    expect(
      await db()
        .selectFrom('notification_preferences')
        .select('type')
        .where('account_id', '=', me)
        .execute(),
    ).toEqual([]);
  });

  it('validates the body', async () => {
    const headers = await t.auth.as(randomUUID());
    const put = (payload: unknown) =>
      app().inject({
        method: 'PUT',
        url: '/api/v1/me/notifications/preferences',
        headers,
        payload: payload as object,
      });
    expect((await put({ items: [{ type: 'NOPE', inApp: true, sms: true }] })).statusCode).toBe(400);
    expect((await put({ items: [{ type: 'NEED_MATCHED', inApp: true }] })).statusCode).toBe(400);
    expect((await put({ items: [], accountId: randomUUID() })).statusCode).toBe(400);
    const dup = await put({
      items: [
        { type: 'NEED_MATCHED', inApp: true, sms: true },
        { type: 'NEED_MATCHED', inApp: false, sms: false },
      ],
    });
    expect(dup.statusCode).toBe(400);
  });
});

describe('retention', () => {
  it('deletes read notifications past retention, keeps unread and recent ones', async () => {
    const me = randomUUID();
    for (let i = 0; i < 3; i++) await deliver(offerSubmitted(me, randomUUID()));
    const rows = await notificationsOf(me);
    const [oldRead, oldUnread, recentRead] = rows.map((r) => r.id) as [string, string, string];
    await db()
      .updateTable('notifications')
      .set({ created_at: sql<Date>`now() - interval '120 days'` })
      .where('id', 'in', [oldRead, oldUnread])
      .execute();
    await db()
      .updateTable('notifications')
      .set({ read_at: sql<Date>`now()` })
      .where('id', 'in', [oldRead, recentRead])
      .execute();

    expect(await t.svc.notifications.purge(pgNotificationStore(db()), 90)).toBeGreaterThanOrEqual(
      1,
    );
    expect((await notificationsOf(me)).map((r) => r.id).sort()).toEqual(
      [oldUnread, recentRead].sort(),
    );
  });
});
