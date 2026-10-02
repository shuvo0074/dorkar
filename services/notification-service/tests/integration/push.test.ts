import { randomUUID } from 'node:crypto';
import {
  BiddingEvents,
  DisputeEvents,
  LendingEvents,
  MessagingEvents,
  OfferEvents,
  RentalEvents,
  TransactionEvents,
} from '@dorkar/contracts';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import type { ContactDirectory } from '../../src/application/ports';
import { buildNotificationService } from '../../src/app';
import { pgNotificationStore } from '../../src/infrastructure/pg-notification-store';
import { RecordingPushProvider } from '../../src/infrastructure/push/push-providers';
import { RecordingSmsChannel } from '../../src/infrastructure/sms/sms-channels';

const contacts: ContactDirectory = { phoneOf: async () => null };
const push = new RecordingPushProvider();

let t: TestService<Awaited<ReturnType<typeof buildNotificationService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;
const deliver = (e: Parameters<typeof t.svc.runtime.deliver>[0]) => t.svc.runtime.deliver(e);
const dispatchPush = () => t.svc.pushDispatcher!.runOnce();

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'notification_push',
    migrations,
    env: { PUSH_MAX_ATTEMPTS: '2' },
    build: (env, logger, verifier) =>
      buildNotificationService(env, logger, {
        verifier,
        contacts,
        sms: new RecordingSmsChannel(),
        push,
      }),
  });
});
afterAll(() => t.close());

beforeEach(async () => {
  // Isolate each test's deliveries from those queued earlier in the file.
  await db()
    .updateTable('deliveries')
    .set({ status: 'SKIPPED' })
    .where('status', '=', 'PENDING')
    .execute();
  push.sent.length = 0;
  push.outcomes.clear();
});

const register = async (accountId: string, token: string, platform = 'ANDROID') =>
  app().inject({
    method: 'POST',
    url: '/api/v1/me/notifications/push-devices',
    headers: await t.auth.as(accountId),
    payload: { platform, token },
  });

const devicesOf = async (accountId: string) =>
  (
    await app().inject({
      url: '/api/v1/me/notifications/push-devices',
      headers: await t.auth.as(accountId),
    })
  ).json().data as { id: string; platform: string }[];

const token = () => `fcm:${randomUUID()}`;

const notificationsOf = (recipientId: string) =>
  db()
    .selectFrom('notifications')
    .select(['id', 'type', 'payload', 'source_event_id', 'read_at', 'created_at'])
    .where('recipient_id', '=', recipientId)
    .orderBy('created_at')
    .execute();

const deliveriesOf = (recipientId: string) =>
  db()
    .selectFrom('deliveries as d')
    .innerJoin('notifications as n', 'n.id', 'd.notification_id')
    .select(['d.id', 'd.channel', 'd.status', 'd.attempts', 'd.last_error', 'n.type'])
    .where('n.recipient_id', '=', recipientId)
    .orderBy('d.created_at')
    .execute();

const makeDue = () =>
  db()
    .updateTable('deliveries')
    .set({ next_attempt_at: sql<Date>`now()` })
    .where('status', '=', 'PENDING')
    .execute();

const bidPlaced = (ownerId: string, auctionId = randomUUID()) =>
  envelope(BiddingEvents.BidPlaced, {
    auctionId,
    bidId: randomUUID(),
    bidderId: randomUUID(),
    ownerId,
    amount: { amount: 10_000_00, currency: 'BDT' },
    endsAt: new Date().toISOString(),
  });

const messageSent = (recipientId: string, conversationId: string, senderId = randomUUID()) =>
  envelope(MessagingEvents.MessageSent, {
    messageId: randomUUID(),
    conversationId,
    contextType: 'LISTING',
    contextId: randomUUID(),
    senderId,
    recipientIds: [recipientId],
  });

describe('push devices', () => {
  it('upserts by token: re-registering refreshes the same device', async () => {
    const me = randomUUID();
    const tok = token();
    const first = await register(me, tok, 'ANDROID');
    expect(first.statusCode).toBe(200);
    const again = await register(me, tok, 'WEB');
    expect(again.json().data).toMatchObject({ id: first.json().data.id, platform: 'WEB' });
    expect(await devicesOf(me)).toEqual([expect.objectContaining({ id: first.json().data.id })]);
    // The token is never echoed back.
    expect(JSON.stringify(again.json())).not.toContain(tok);
    expect(JSON.stringify(await devicesOf(me))).not.toContain(tok);
    const row = await db()
      .selectFrom('push_devices')
      .select(['token_hash'])
      .where('account_id', '=', me)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('moves a token to the account that registers it last (fresh id)', async () => {
    const alice = randomUUID();
    const bob = randomUUID();
    const tok = token();
    const a = (await register(alice, tok)).json().data;
    const b = (await register(bob, tok)).json().data;
    expect(b.id).not.toBe(a.id);
    expect(await devicesOf(alice)).toEqual([]);
    expect((await devicesOf(bob)).map((d) => d.id)).toEqual([b.id]);
    // Alice's old id no longer resolves for her.
    const del = await app().inject({
      method: 'DELETE',
      url: `/api/v1/me/notifications/push-devices/${a.id}`,
      headers: await t.auth.as(alice),
    });
    expect(del.statusCode).toBe(404);
    expect(
      await db().selectFrom('push_devices').select('id').where('account_id', '=', alice).execute(),
    ).toEqual([]);

    // Alice's notifications no longer reach that phone; Bob's do.
    await deliver(bidPlaced(alice));
    await deliver(bidPlaced(bob));
    expect((await deliveriesOf(alice)).filter((d) => d.channel === 'PUSH')).toEqual([]);
    expect((await deliveriesOf(bob)).filter((d) => d.channel === 'PUSH')).toHaveLength(1);
  });

  it('keeps at most 10 active devices, deactivating the least recently registered', async () => {
    const me = randomUUID();
    const tokens = Array.from({ length: 11 }, token);
    const ids: string[] = [];
    for (const tok of tokens) ids.push((await register(me, tok)).json().data.id);

    let active = (await devicesOf(me)).map((d) => d.id);
    expect(active).toHaveLength(10);
    expect(active).not.toContain(ids[0]);
    const oldest = await db()
      .selectFrom('push_devices')
      .select(['active', 'deactivation_reason'])
      .where('id', '=', ids[0]!)
      .executeTakeFirstOrThrow();
    expect(oldest).toEqual({ active: false, deactivation_reason: 'LIMIT' });

    // Opening the app on the oldest device again reactivates it; the next oldest goes.
    await register(me, tokens[0]!);
    active = (await devicesOf(me)).map((d) => d.id);
    expect(active).toHaveLength(10);
    expect(active).toContain(ids[0]);
    expect(active).not.toContain(ids[1]);
  });

  it('enforces the limit under concurrent registrations', async () => {
    const me = randomUUID();
    const codes = await Promise.all(
      Array.from({ length: 14 }, async () => (await register(me, token())).statusCode),
    );
    expect(codes.every((c) => c === 200)).toBe(true);
    expect(await devicesOf(me)).toHaveLength(10);
  });

  it("deletes the caller's own device only", async () => {
    const me = randomUUID();
    const other = randomUUID();
    const d = (await register(me, token())).json().data;
    const steal = await app().inject({
      method: 'DELETE',
      url: `/api/v1/me/notifications/push-devices/${d.id}`,
      headers: await t.auth.as(other),
    });
    expect(steal.statusCode).toBe(404);
    const del = await app().inject({
      method: 'DELETE',
      url: `/api/v1/me/notifications/push-devices/${d.id}`,
      headers: await t.auth.as(me),
    });
    expect(del.statusCode).toBe(204);
    expect(await devicesOf(me)).toEqual([]);
  });

  it('validates input and requires authentication', async () => {
    const me = randomUUID();
    const headers = await t.auth.as(me);
    const post = (payload: object) =>
      app().inject({
        method: 'POST',
        url: '/api/v1/me/notifications/push-devices',
        headers,
        payload,
      });
    expect((await post({ platform: 'SYMBIAN', token: token() })).statusCode).toBe(400);
    expect((await post({ platform: 'IOS', token: 'has space in it' })).statusCode).toBe(400);
    expect((await post({ platform: 'IOS', token: 'short' })).statusCode).toBe(400);
    expect((await post({ platform: 'IOS', token: token(), accountId: me })).statusCode).toBe(400);
    for (const c of [
      { method: 'GET' as const, url: '/api/v1/me/notifications/push-devices' },
      {
        method: 'POST' as const,
        url: '/api/v1/me/notifications/push-devices',
        payload: { platform: 'IOS', token: token() },
      },
      { method: 'DELETE' as const, url: `/api/v1/me/notifications/push-devices/${randomUUID()}` },
    ]) {
      expect((await app().inject(c)).statusCode, `${c.method} ${c.url}`).toBe(401);
    }
  });
});

describe('push delivery', () => {
  it('queues PUSH only for recipients with a device, and sends to every active device', async () => {
    const withDevices = randomUUID();
    const without = randomUUID();
    const t1 = token();
    const t2 = token();
    await register(withDevices, t1, 'ANDROID');
    await register(withDevices, t2, 'IOS');
    const auctionId = randomUUID();
    await deliver(bidPlaced(withDevices, auctionId));
    await deliver(bidPlaced(without));

    expect(await deliveriesOf(without)).toEqual([]); // BID_PLACED has no SMS by default
    expect(await deliveriesOf(withDevices)).toMatchObject([
      { channel: 'PUSH', status: 'PENDING', type: 'BID_PLACED' },
    ]);

    expect(await dispatchPush()).toBe(1);
    expect(push.sent.map((s) => s.token).sort()).toEqual([t1, t2].sort());
    const [note] = await notificationsOf(withDevices);
    expect(push.sent[0]!.message).toEqual({
      notificationId: note!.id,
      type: 'BID_PLACED',
      title: 'New bid on your auction',
      body: 'Someone placed a new bid on your auction.',
      path: `/auctions/${auctionId}`,
    });
    expect(JSON.stringify(push.sent)).not.toContain('10,000');
    expect(await deliveriesOf(withDevices)).toMatchObject([{ status: 'SENT', attempts: 1 }]);
    expect(await dispatchPush()).toBe(0);
    expect(t.logLines.join('\n')).not.toContain(t1);
  });

  it('deactivates devices whose token is invalid; SKIPs when none is left', async () => {
    const me = randomUUID();
    const dead = token();
    const live = token();
    await register(me, dead);
    await register(me, live);
    push.outcomes.set(dead, { invalidToken: true });

    await deliver(bidPlaced(me));
    await dispatchPush();
    expect(push.sent.map((s) => s.token)).toEqual([live]);
    expect(await deliveriesOf(me)).toMatchObject([{ status: 'SENT' }]);
    expect(await devicesOf(me)).toHaveLength(1);
    const deadRow = await db()
      .selectFrom('push_devices')
      .select(['active', 'deactivation_reason'])
      .where('account_id', '=', me)
      .where('active', '=', false)
      .executeTakeFirstOrThrow();
    expect(deadRow.deactivation_reason).toBe('INVALID_TOKEN');

    push.outcomes.set(live, { invalidToken: true });
    await deliver(bidPlaced(me));
    await dispatchPush();
    expect(await devicesOf(me)).toEqual([]);
    expect((await deliveriesOf(me)).at(-1)).toMatchObject({
      status: 'SKIPPED',
      last_error: 'NO_DEVICE',
    });
  });

  it('retries transient failures with backoff, then FAILs after the last attempt', async () => {
    const me = randomUUID();
    const tok = token();
    await register(me, tok);
    push.outcomes.set(tok, { retryable: true, error: 'FCM_503' });
    await deliver(bidPlaced(me));

    await dispatchPush();
    expect(await deliveriesOf(me)).toMatchObject([
      { status: 'PENDING', attempts: 1, last_error: 'FCM_503' },
    ]);
    expect(await dispatchPush()).toBe(0); // backing off
    await makeDue();
    await dispatchPush();
    expect(await deliveriesOf(me)).toMatchObject([{ status: 'FAILED', attempts: 2 }]); // max 2
    expect(await devicesOf(me)).toHaveLength(1); // transient errors never drop the device
  });

  it('recovers when a retry succeeds', async () => {
    const me = randomUUID();
    const tok = token();
    await register(me, tok);
    push.outcomes.set(tok, { retryable: true, error: 'FCM_429' });
    await deliver(bidPlaced(me));
    await dispatchPush();
    push.outcomes.clear();
    await makeDue();
    await dispatchPush();
    expect(await deliveriesOf(me)).toMatchObject([{ status: 'SENT', attempts: 2 }]);
  });
});

describe('preferences per channel', () => {
  const put = async (me: string, items: object[]) =>
    app().inject({
      method: 'PUT',
      url: '/api/v1/me/notifications/preferences',
      headers: await t.auth.as(me),
      payload: { items },
    });

  it('PUSH and SMS toggles are honoured independently', async () => {
    const me = randomUUID();
    await register(me, token());
    const res = await put(me, [
      { type: 'BID_PLACED', inApp: true, sms: true, push: false },
      { type: 'AUCTION_WON', inApp: true, sms: false, push: true },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.find((p: { type: string }) => p.type === 'BID_PLACED')).toEqual({
      type: 'BID_PLACED',
      inApp: true,
      sms: true,
      push: false,
    });

    await deliver(bidPlaced(me));
    await deliver(
      envelope(BiddingEvents.AuctionClosed, {
        auctionId: randomUUID(),
        kind: 'FORWARD',
        ownerId: randomUUID(),
        subjectType: 'LISTING',
        subjectId: randomUUID(),
        categoryId: randomUUID(),
        outcome: 'AWARDED',
        winnerId: me,
        winningBidId: randomUUID(),
        amount: { amount: 100, currency: 'BDT' },
        bidderIds: [me],
      }),
    );
    const ds = await deliveriesOf(me);
    expect(ds.map((d) => `${d.type}:${d.channel}`).sort()).toEqual([
      'AUCTION_WON:PUSH',
      'BID_PLACED:SMS',
    ]);
  });

  it('defaults: AUCTION_WON gets SMS and PUSH; omitting push in PUT keeps the current value', async () => {
    const me = randomUUID();
    await register(me, token());
    await put(me, [{ type: 'BID_OUTBID', inApp: true, sms: false, push: false }]);
    await put(me, [{ type: 'BID_OUTBID', inApp: true, sms: true }]); // older client
    const prefs = (
      await app().inject({
        url: '/api/v1/me/notifications/preferences',
        headers: await t.auth.as(me),
      })
    ).json().data as { type: string; push: boolean; sms: boolean }[];
    expect(prefs.find((p) => p.type === 'BID_OUTBID')).toMatchObject({ sms: true, push: false });
    expect(prefs.find((p) => p.type === 'AUCTION_WON')).toMatchObject({ sms: true, push: true });
  });

  it('SKIPs a queued push when the user turned push off before it was sent', async () => {
    const me = randomUUID();
    await register(me, token());
    await deliver(bidPlaced(me));
    await put(me, [{ type: 'BID_PLACED', inApp: true, sms: false, push: false }]);
    await dispatchPush();
    expect(await deliveriesOf(me)).toMatchObject([{ status: 'SKIPPED', last_error: 'OPTED_OUT' }]);
    expect(push.sent).toEqual([]);
  });
});

describe('Phase 2 events', () => {
  it('notify the right people across bidding, rental, lending, disputes and deals', async () => {
    const [owner, renter, lender, borrower, buyer, seller, b1, b2] = Array.from(
      { length: 8 },
      randomUUID,
    ) as [string, string, string, string, string, string, string, string];
    const ts = new Date().toISOString();
    const booking = {
      bookingId: randomUUID(),
      listingId: randomUUID(),
      ownerId: owner,
      renterId: renter,
    };
    const loan = {
      loanId: randomUUID(),
      itemId: randomUUID(),
      lenderId: lender,
      borrowerId: borrower,
    };
    const dispute = {
      disputeId: randomUUID(),
      transactionId: randomUUID(),
      buyerId: buyer,
      sellerId: seller,
    };
    const events = [
      bidPlaced(owner),
      envelope(BiddingEvents.BidOutbid, {
        auctionId: randomUUID(),
        bidId: randomUUID(),
        bidderId: b1,
        leadingAmount: { amount: 1, currency: 'BDT' },
      }),
      envelope(BiddingEvents.AuctionClosed, {
        auctionId: randomUUID(),
        kind: 'REVERSE',
        ownerId: owner,
        subjectType: 'NEED',
        subjectId: randomUUID(),
        categoryId: randomUUID(),
        outcome: 'AWARDED',
        winnerId: b2,
        winningBidId: randomUUID(),
        amount: { amount: 1, currency: 'BDT' },
        bidderIds: [b1, b2],
      }),
      ...(['PENDING_APPROVAL', 'HELD', 'CONFIRMED'] as const).map((to) =>
        envelope(RentalEvents.BookingStatusChanged, {
          ...booking,
          from: 'HELD',
          to,
          transactionId: null,
          reason: 'x',
        }),
      ),
      envelope(RentalEvents.BookingOverdue, { ...booking, transactionId: null, endAt: ts }),
      envelope(LendingEvents.LoanRequested, { ...loan, startAt: ts, returnBy: ts }),
      envelope(LendingEvents.LoanStatusChanged, {
        ...loan,
        from: 'REQUESTED',
        to: 'APPROVED',
        transactionId: null,
        reason: 'LENDER',
      }),
      envelope(LendingEvents.LoanOverdue, { ...loan, transactionId: null, returnBy: ts }),
      envelope(DisputeEvents.DisputeOpened, {
        ...dispute,
        openedBy: buyer,
        reason: 'NOT_AS_DESCRIBED',
        previousState: 'DELIVERED',
      }),
      envelope(DisputeEvents.DisputeStatusChanged, {
        ...dispute,
        from: 'OPEN',
        to: 'UNDER_REVIEW',
        actorId: null,
      }),
      envelope(DisputeEvents.DisputeResolved, {
        ...dispute,
        resolution: 'RELEASE',
        resolvedBy: randomUUID(),
        note: 'n',
      }),
      envelope(TransactionEvents.TransactionStateChanged, {
        transactionId: randomUUID(),
        needId: null,
        sourceType: 'LOAN',
        sourceId: loan.loanId,
        buyerId: borrower,
        sellerId: lender,
        from: 'CONFIRMED',
        to: 'HANDED_OVER',
        actorId: lender,
        mode: 'BORROW',
      }),
    ];
    for (const e of events) expect(await deliver(e)).toBe(true);

    const types = async (id: string) => (await notificationsOf(id)).map((n) => n.type).sort();
    expect(await types(owner)).toEqual(
      [
        'AUCTION_CLOSED',
        'BID_PLACED',
        'BOOKING_CONFIRMED',
        'BOOKING_OVERDUE',
        'BOOKING_REQUESTED',
      ].sort(),
    );
    expect(await types(renter)).toEqual(['BOOKING_CONFIRMED', 'BOOKING_OVERDUE']);
    expect(await types(b1)).toEqual(['AUCTION_LOST', 'BID_OUTBID']);
    expect(await types(b2)).toEqual(['AUCTION_WON']);
    expect(await types(lender)).toEqual(['LOAN_OVERDUE', 'LOAN_REQUESTED']);
    expect(await types(borrower)).toEqual(
      ['LOAN_APPROVED', 'LOAN_OVERDUE', 'TRANSACTION_UPDATED'].sort(),
    );
    for (const p of [buyer, seller]) {
      expect(await types(p)).toEqual(['DISPUTE_OPENED', 'DISPUTE_RESOLVED', 'DISPUTE_UPDATED']);
    }
    // SMS defaults for the critical Phase 2 moments.
    const sms = async (id: string) =>
      (await deliveriesOf(id))
        .filter((d) => d.channel === 'SMS')
        .map((d) => d.type)
        .sort();
    expect(await sms(b2)).toEqual(['AUCTION_WON']);
    expect(await sms(renter)).toEqual(['BOOKING_CONFIRMED']);
    expect(await sms(seller)).toEqual(['DISPUTE_OPENED']);
  });

  it('is idempotent per (event, recipient, channel) under redelivery', async () => {
    const owner = randomUUID();
    const renter = randomUUID();
    await register(owner, token());
    await register(renter, token());
    const e = envelope(RentalEvents.BookingStatusChanged, {
      bookingId: randomUUID(),
      listingId: randomUUID(),
      ownerId: owner,
      renterId: renter,
      from: 'PENDING_APPROVAL',
      to: 'CONFIRMED',
      transactionId: null,
      reason: 'OWNER_APPROVED',
    });
    expect(await deliver(e)).toBe(true);
    expect(await deliver(e)).toBe(false);
    // Past the inbox too: the same event recorded again changes nothing.
    const store = pgNotificationStore(db());
    const intents = [
      { recipientId: owner, type: 'BOOKING_CONFIRMED' as const, payload: {} },
      { recipientId: renter, type: 'BOOKING_CONFIRMED' as const, payload: {} },
    ];
    expect(await t.svc.notifications.onEvent(store, e, intents)).toBe(0);

    for (const id of [owner, renter]) {
      expect(await notificationsOf(id)).toHaveLength(1);
      expect((await deliveriesOf(id)).map((d) => d.channel).sort()).toEqual(['PUSH', 'SMS']);
    }
  });
});

describe('message coalescing and push throttle', () => {
  it('merges unread NEW_MESSAGE notifications per conversation (count and time)', async () => {
    const me = randomUUID();
    const conv = randomUUID();
    const otherConv = randomUUID();
    const first = messageSent(me, conv);
    await deliver(first);
    const [n1] = await notificationsOf(me);
    expect(n1!.payload).toMatchObject({ conversationId: conv, count: 1 });

    const second = messageSent(me, conv);
    await deliver(second);
    await deliver(messageSent(me, conv));
    let rows = await notificationsOf(me);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(n1!.id);
    expect(rows[0]!.payload).toMatchObject({
      conversationId: conv,
      count: 3,
    });
    expect(rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(n1!.created_at.getTime());

    // A merged event replayed past the inbox does not count twice.
    expect(
      await t.svc.notifications.onEvent(pgNotificationStore(db()), second, [
        {
          recipientId: me,
          type: 'NEW_MESSAGE',
          payload: { conversationId: conv, count: 1 },
          coalesceKey: conv,
        },
      ]),
    ).toBe(0);
    expect((await notificationsOf(me))[0]!.payload['count']).toBe(3);

    // Another conversation is its own notification.
    await deliver(messageSent(me, otherConv));
    expect(await notificationsOf(me)).toHaveLength(2);

    // Once read, the next message starts a fresh notification.
    const headers = await t.auth.as(me);
    await app().inject({ method: 'POST', url: `/api/v1/me/notifications/${n1!.id}/read`, headers });
    await deliver(messageSent(me, conv));
    rows = await notificationsOf(me);
    expect(rows).toHaveLength(3);
    expect(rows.at(-1)!.payload).toMatchObject({ conversationId: conv, count: 1 });

    const list = (await app().inject({ url: '/api/v1/me/notifications', headers })).json().data;
    expect(list[0].payload.conversationId).toBe(conv); // newest first
    const count = (
      await app().inject({ url: '/api/v1/me/notifications/unread-count', headers })
    ).json().data.count;
    expect(count).toBe(2);
  });

  it('concurrent messages to one conversation still end in one notification', async () => {
    const me = randomUUID();
    const conv = randomUUID();
    const events = Array.from({ length: 4 }, () => messageSent(me, conv));
    const results = await Promise.allSettled(events.map((e) => deliver(e)));
    // A loser of the insert race fails its inbox transaction (unique unread key); the consumer
    // redelivers it, and the retry merges.
    for (const [i, r] of results.entries()) {
      if (r.status === 'rejected') expect(await deliver(events[i]!)).toBe(true);
    }
    const rows = await notificationsOf(me);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload['count']).toBe(4);
  });

  it('pushes at most once per conversation per recipient per 5 minutes', async () => {
    const me = randomUUID();
    const conv = randomUUID();
    const otherConv = randomUUID();
    await register(me, token());

    await deliver(messageSent(me, conv));
    await dispatchPush();
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]!.message).toMatchObject({
      type: 'NEW_MESSAGE',
      body: 'You have a new message.',
      path: `/messages/${conv}`,
    });

    // Second message: merged in-app, its push is re-queued but throttled.
    await deliver(messageSent(me, conv));
    const pushRows = async () => (await deliveriesOf(me)).filter((d) => d.channel === 'PUSH');
    expect(await pushRows()).toMatchObject([{ status: 'PENDING', attempts: 0 }]);
    await dispatchPush();
    expect(push.sent).toHaveLength(1);
    expect(await pushRows()).toMatchObject([{ status: 'SKIPPED', last_error: 'THROTTLED' }]);

    // A different conversation is not throttled by this one.
    await deliver(messageSent(me, otherConv));
    await dispatchPush();
    expect(push.sent).toHaveLength(2);

    // After the window (simulated by expiring the key) the next message pushes again,
    // with the merged count.
    await t.svc.runtime.redis.del(`push-throttle:${me}:${conv}`);
    await deliver(messageSent(me, conv));
    await dispatchPush();
    expect(push.sent).toHaveLength(3);
    expect(push.sent[2]!.message.body).toBe('You have 3 new messages.');
    expect(push.sent[2]!.message.notificationId).toBe(push.sent[0]!.message.notificationId);
  });
});

describe('MVP events still flow (with push)', () => {
  it('OfferSubmitted reaches a device-holding buyer by push as well as SMS', async () => {
    const buyer = randomUUID();
    await register(buyer, token());
    await deliver(
      envelope(OfferEvents.OfferSubmitted, {
        offerId: randomUUID(),
        needId: randomUUID(),
        buyerId: buyer,
        sellerId: randomUUID(),
        price: { amount: 500_00, currency: 'BDT' },
        quantity: 1,
      }),
    );
    expect((await deliveriesOf(buyer)).map((d) => d.channel).sort()).toEqual(['PUSH', 'SMS']);
    await dispatchPush();
    expect(push.sent[0]!.message).toMatchObject({ title: 'New offer', type: 'OFFER_RECEIVED' });
    expect(JSON.stringify(push.sent[0])).not.toContain('500');
  });
});
