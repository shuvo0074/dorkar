import { randomUUID } from 'node:crypto';
import {
  CatalogEvents,
  LendingEvents,
  MessagingEvents,
  ModerationEvents,
  OfferEvents,
  TransactionEvents,
  type ConversationContext,
} from '@dorkar/contracts';
import {
  envelope,
  startTestService,
  TEST_INTERNAL_TOKEN,
  type TestService,
} from '@dorkar/kernel/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildMessagingService } from '../../src/app';

const SEND_LIMIT = 12;

let t: TestService<Awaited<ReturnType<typeof buildMessagingService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'messaging',
    migrations,
    env: {
      MESSAGING_SEND_PER_MINUTE: String(SEND_LIMIT),
      MESSAGING_LONG_POLL_MAX_SECONDS: '3',
    },
    build: (env, logger, verifier) => buildMessagingService(env, logger, { verifier }),
  });
});
afterAll(() => t.close());

// ---------------------------------------------------------------- helpers

const listingFacts = (sellerId: string, listingId = randomUUID(), quantityAvailable = 3) => ({
  listingId,
  sellerId,
  categoryId: randomUUID(),
  kind: 'PRODUCT' as const,
  condition: 'USED' as const,
  title: 'Walton fridge',
  price: { amount: 2_500_000, currency: 'BDT' as const },
  priceUnit: 'TOTAL' as const,
  quantityAvailable,
  district: 'dhaka' as const,
  attributes: {},
  deliveryModes: ['BUYER_PICKUP' as const],
});

async function publishListing(sellerId: string, quantityAvailable = 3): Promise<string> {
  const f = listingFacts(sellerId, randomUUID(), quantityAvailable);
  await t.svc.runtime.deliver(envelope(CatalogEvents.ListingPublished, f, f.listingId));
  return f.listingId;
}

async function publishLendItem(lenderId: string, active = true): Promise<string> {
  const itemId = randomUUID();
  await t.svc.runtime.deliver(
    envelope(LendingEvents.LendItemPublished, {
      itemId,
      lenderId,
      categoryId: randomUUID(),
      title: 'Ladder',
      district: 'dhaka',
      active,
    }),
  );
  return itemId;
}

async function submitOffer(buyerId: string, sellerId: string): Promise<string> {
  const offerId = randomUUID();
  await t.svc.runtime.deliver(
    envelope(OfferEvents.OfferSubmitted, {
      offerId,
      needId: randomUUID(),
      buyerId,
      sellerId,
      price: { amount: 100_000, currency: 'BDT' },
      quantity: 1,
    }),
  );
  return offerId;
}

async function createTransaction(buyerId: string, sellerId: string): Promise<string> {
  const transactionId = randomUUID();
  await t.svc.runtime.deliver(
    envelope(TransactionEvents.TransactionCreated, {
      transactionId,
      sourceType: 'OFFER',
      sourceId: randomUUID(),
      needId: randomUUID(),
      buyerId,
      sellerId,
      amount: { amount: 100_000, currency: 'BDT' },
      quantity: 1,
      mode: 'BUY',
    }),
  );
  return transactionId;
}

const open = async (user: string, contextType: ConversationContext, contextId: string) =>
  app().inject({
    method: 'POST',
    url: '/api/v1/conversations',
    headers: await t.auth.as(user),
    payload: { contextType, contextId },
  });

/** A fresh listing conversation between a new buyer and seller. */
async function listingConversation() {
  const buyer = randomUUID();
  const seller = randomUUID();
  const listingId = await publishListing(seller);
  const res = await open(buyer, 'LISTING', listingId);
  expect(res.statusCode).toBe(201);
  return { buyer, seller, listingId, id: res.json().data.id as string };
}

const send = async (user: string, conversationId: string, body: string, clientId = randomUUID()) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/conversations/${conversationId}/messages`,
    headers: await t.auth.as(user),
    payload: { body, clientId },
  });

const getConversation = async (user: string, id: string) =>
  app().inject({ url: `/api/v1/conversations/${id}`, headers: await t.auth.as(user) });

const markRead = async (user: string, id: string, upToMessageId: string) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/conversations/${id}/read`,
    headers: await t.auth.as(user),
    payload: { upToMessageId },
  });

// ---------------------------------------------------------------- conversations

describe('participant derivation', () => {
  it('LISTING: an inquirer talks to the seller; the seller cannot open one with themselves', async () => {
    const { buyer, seller, listingId, id } = await listingConversation();
    const c = (await getConversation(buyer, id)).json().data;
    expect(c).toMatchObject({
      context: { type: 'LISTING', id: listingId },
      otherParticipantId: seller,
      unreadCount: 0,
      lastMessage: null,
    });
    expect((await getConversation(seller, id)).json().data.otherParticipantId).toBe(buyer);

    const self = await open(seller, 'LISTING', listingId);
    expect(self.statusCode).toBe(422);
    expect(self.json().error.details.rule).toBe('CANNOT_MESSAGE_SELF');
  });

  it('LISTING: a second inquirer gets their own conversation with the seller', async () => {
    const { seller, listingId, id } = await listingConversation();
    const other = await open(randomUUID(), 'LISTING', listingId);
    expect(other.statusCode).toBe(201);
    expect(other.json().data.id).not.toBe(id);
    expect(other.json().data.otherParticipantId).toBe(seller);
  });

  it('LISTING: unavailable or unknown listings take no new conversations; existing ones survive', async () => {
    const { buyer, seller, listingId, id } = await listingConversation();
    expect((await open(randomUUID(), 'LISTING', await publishListing(seller, 0))).statusCode).toBe(
      404,
    );
    expect((await open(buyer, 'LISTING', randomUUID())).statusCode).toBe(404);

    await t.svc.runtime.deliver(
      envelope(CatalogEvents.ListingUnavailable, {
        listingId,
        sellerId: seller,
        reason: 'SOLD_OUT',
      }),
    );
    expect((await open(randomUUID(), 'LISTING', listingId)).statusCode).toBe(404);
    const again = await open(buyer, 'LISTING', listingId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.id).toBe(id);
  });

  it('LEND_ITEM: an inquirer talks to the lender, only while the item is active', async () => {
    const lender = randomUUID();
    const borrower = randomUUID();
    const itemId = await publishLendItem(lender);
    const res = await open(borrower, 'LEND_ITEM', itemId);
    expect(res.statusCode).toBe(201);
    expect(res.json().data).toMatchObject({
      context: { type: 'LEND_ITEM', id: itemId },
      otherParticipantId: lender,
    });
    expect((await open(lender, 'LEND_ITEM', itemId)).statusCode).toBe(422);
    expect(
      (await open(borrower, 'LEND_ITEM', await publishLendItem(lender, false))).statusCode,
    ).toBe(404);
  });

  it.each(['OFFER', 'TRANSACTION'] as const)(
    '%s: buyer and seller share one conversation; outsiders get 404',
    async (type) => {
      const buyer = randomUUID();
      const seller = randomUUID();
      const contextId =
        type === 'OFFER'
          ? await submitOffer(buyer, seller)
          : await createTransaction(buyer, seller);

      const first = await open(seller, type, contextId);
      expect(first.statusCode).toBe(201);
      expect(first.json().data.otherParticipantId).toBe(buyer);
      const second = await open(buyer, type, contextId);
      expect(second.statusCode).toBe(200);
      expect(second.json().data.id).toBe(first.json().data.id);

      expect((await open(randomUUID(), type, contextId)).statusCode).toBe(404);
    },
  );

  it('outsiders get 404 on every conversation route', async () => {
    const { buyer, id } = await listingConversation();
    const sent = (await send(buyer, id, 'Is it still available?')).json().data;
    const outsider = randomUUID();
    const headers = await t.auth.as(outsider);
    expect((await getConversation(outsider, id)).statusCode).toBe(404);
    expect(
      (await app().inject({ url: `/api/v1/conversations/${id}/messages`, headers })).statusCode,
    ).toBe(404);
    expect((await send(outsider, id, 'hello')).statusCode).toBe(404);
    expect((await markRead(outsider, id, sent.id)).statusCode).toBe(404);
    expect((await getConversation(outsider, randomUUID())).statusCode).toBe(404);
  });

  it('requires authentication and validates input', async () => {
    expect(
      (
        await app().inject({
          method: 'POST',
          url: '/api/v1/conversations',
          payload: { contextType: 'LISTING', contextId: randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
    const bad = await app().inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: await t.auth.as(randomUUID()),
      payload: { contextType: 'NEED', contextId: randomUUID() },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('get-or-create', () => {
  it('is idempotent and audited once', async () => {
    const { buyer, listingId, id } = await listingConversation();
    const again = await open(buyer, 'LISTING', listingId);
    expect(again.statusCode).toBe(200);
    expect(again.json().data.id).toBe(id);
    const audits = await db()
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', id)
      .execute();
    expect(audits.map((a) => a.action)).toEqual(['conversation.created']);
  });

  it('concurrent creates produce one conversation', async () => {
    const buyer = randomUUID();
    const listingId = await publishListing(randomUUID());
    const results = await Promise.all(
      Array.from({ length: 6 }, () => open(buyer, 'LISTING', listingId)),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.json().data.id)).size).toBe(1);
    const rows = await db()
      .selectFrom('conversations')
      .select('id')
      .where('context_id', '=', listingId)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('listing my conversations', () => {
  it('orders by latest activity with keyset pagination and shows a preview', async () => {
    const me = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await open(me, 'LISTING', await publishListing(randomUUID()));
      ids.push(res.json().data.id);
    }
    await send(me, ids[0]!, 'Can you deliver to Mirpur?');

    const headers = await t.auth.as(me);
    const page1 = await app().inject({ url: '/api/v1/conversations?limit=2', headers });
    expect(page1.statusCode).toBe(200);
    const body1 = page1.json();
    expect(body1.data.map((c: { id: string }) => c.id)).toEqual([ids[0], ids[2]]);
    expect(body1.data[0].lastMessage).toMatchObject({
      preview: 'Can you deliver to Mirpur?',
      removed: false,
      senderId: me,
    });
    expect(body1.page.nextCursor).toBeTruthy();

    const page2 = await app().inject({
      url: `/api/v1/conversations?limit=2&cursor=${body1.page.nextCursor}`,
      headers,
    });
    expect(page2.json().data.map((c: { id: string }) => c.id)).toEqual([ids[1]]);
    expect(page2.json().page.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------- messages

describe('sending', () => {
  it('sends, emits MessageSent without the body, and validates the payload against the contract', async () => {
    const { buyer, seller, listingId, id } = await listingConversation();
    const res = await send(buyer, id, '  Is the fridge still available?  ');
    expect(res.statusCode).toBe(201);
    const m = res.json().data;
    expect(m).toMatchObject({
      conversationId: id,
      senderId: buyer,
      body: 'Is the fridge still available?',
      removed: false,
      mediaIds: [],
    });

    const rows = await db()
      .selectFrom('outbox')
      .select(['payload', 'aggregate_id'])
      .where('type', '=', MessagingEvents.MessageSent.type)
      .where('aggregate_id', '=', id)
      .execute();
    expect(rows).toHaveLength(1);
    const raw = rows[0]!.payload;
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(MessagingEvents.MessageSent.schema.strict().parse(payload)).toEqual({
      messageId: m.id,
      conversationId: id,
      contextType: 'LISTING',
      contextId: listingId,
      senderId: buyer,
      recipientIds: [seller],
    });
    expect(JSON.stringify(payload)).not.toContain('fridge');

    // Messages are not audited (that would flood the activity log).
    const audits = await db()
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', m.id)
      .execute();
    expect(audits).toHaveLength(0);
  });

  it('dedupes retries on clientId and returns the same message', async () => {
    const { buyer, seller, id } = await listingConversation();
    const clientId = randomUUID();
    const first = await send(buyer, id, 'Hello', clientId);
    expect(first.statusCode).toBe(201);
    const retry = await send(buyer, id, 'Hello (retry)', clientId);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().data).toEqual(first.json().data);

    const concurrent = randomUUID();
    const racing = await Promise.all(
      Array.from({ length: 4 }, () => send(buyer, id, 'Race', concurrent)),
    );
    expect(new Set(racing.map((r) => r.json().data.id)).size).toBe(1);
    expect(racing.filter((r) => r.statusCode === 201)).toHaveLength(1);

    const count = await db()
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('conversation_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(2);
    expect((await getConversation(seller, id)).json().data.unreadCount).toBe(2);
  });

  it('rejects phone numbers and emails', async () => {
    const { buyer, id } = await listingConversation();
    for (const body of ['call 01712345678', 'নম্বর ০১৭১২-৩৪৫৬৭৮', 'mail me at a.b@example.com']) {
      const res = await send(buyer, id, body);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(res.json().error.details.rule).toBe('CONTACT_INFO_NOT_ALLOWED');
    }
  });

  it('validates body, media and clientId', async () => {
    const { buyer, id } = await listingConversation();
    const headers = await t.auth.as(buyer);
    const post = (payload: Record<string, unknown>) =>
      app().inject({
        method: 'POST',
        url: `/api/v1/conversations/${id}/messages`,
        headers,
        payload,
      });
    expect((await post({ body: '   ', clientId: randomUUID() })).statusCode).toBe(400);
    expect((await post({ body: 'x'.repeat(2001), clientId: randomUUID() })).statusCode).toBe(400);
    expect((await post({ body: 'hi', clientId: 'nope' })).statusCode).toBe(400);
    expect(
      (
        await post({
          body: 'hi',
          clientId: randomUUID(),
          mediaIds: Array.from({ length: 5 }, () => randomUUID()),
        })
      ).statusCode,
    ).toBe(400);
    const withMedia = await post({
      body: 'photo',
      clientId: randomUUID(),
      mediaIds: [randomUUID()],
    });
    expect(withMedia.statusCode).toBe(201);
    expect(withMedia.json().data.mediaIds).toHaveLength(1);
  });

  it('requires message:send', async () => {
    const { id } = await listingConversation();
    const res = await app().inject({
      method: 'POST',
      url: `/api/v1/conversations/${id}/messages`,
      headers: { authorization: `Bearer ${await t.auth.token({ roles: [] })}` },
      payload: { body: 'hi', clientId: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });

  it(`rate-limits a sender to ${SEND_LIMIT} messages a minute (retries are free)`, async () => {
    const { buyer, id } = await listingConversation();
    const clientId = randomUUID();
    for (let i = 0; i < SEND_LIMIT; i++) {
      const res = await send(buyer, id, `message ${i}`, i === 0 ? clientId : randomUUID());
      expect(res.statusCode).toBe(201);
    }
    expect((await send(buyer, id, 'retry', clientId)).statusCode).toBe(200);
    const limited = await send(buyer, id, 'one too many');
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('blocking', () => {
  it('blocks in both directions with a generic 403, and unblocking restores messaging', async () => {
    const { buyer, seller, id } = await listingConversation();
    const sellerHeaders = await t.auth.as(seller);
    const blocked = await app().inject({
      method: 'POST',
      url: '/api/v1/me/blocked-users',
      headers: sellerHeaders,
      payload: { userId: buyer },
    });
    expect(blocked.statusCode).toBe(201);
    expect(blocked.json().data.userId).toBe(buyer);
    const again = await app().inject({
      method: 'POST',
      url: '/api/v1/me/blocked-users',
      headers: sellerHeaders,
      payload: { userId: buyer },
    });
    expect(again.statusCode).toBe(200);

    const fromBuyer = await send(buyer, id, 'hello?');
    const fromSeller = await send(seller, id, 'hello?');
    expect(fromBuyer.statusCode).toBe(403);
    expect(fromSeller.statusCode).toBe(403);
    // Neither side learns who blocked whom.
    expect(fromBuyer.json().error.message).toBe(fromSeller.json().error.message);
    expect(fromBuyer.json().error.details).toBeUndefined();

    const list = await app().inject({ url: '/api/v1/me/blocked-users', headers: sellerHeaders });
    expect(list.json().data.map((b: { userId: string }) => b.userId)).toEqual([buyer]);
    const buyerList = await app().inject({
      url: '/api/v1/me/blocked-users',
      headers: await t.auth.as(buyer),
    });
    expect(buyerList.json().data).toEqual([]);

    const unblock = await app().inject({
      method: 'DELETE',
      url: `/api/v1/me/blocked-users/${buyer}`,
      headers: sellerHeaders,
    });
    expect(unblock.statusCode).toBe(204);
    expect((await send(buyer, id, 'hello again')).statusCode).toBe(201);

    const actions = await db()
      .selectFrom('audit_log')
      .select('action')
      .where('actor_id', '=', seller)
      .orderBy('occurred_at')
      .execute();
    expect(actions.map((a) => a.action)).toEqual(['user.blocked', 'user.unblocked']);
  });

  it('cannot block yourself', async () => {
    const me = randomUUID();
    const res = await app().inject({
      method: 'POST',
      url: '/api/v1/me/blocked-users',
      headers: await t.auth.as(me),
      payload: { userId: me },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('CANNOT_BLOCK_SELF');
  });

  it('paginates the block list', async () => {
    const me = randomUUID();
    const headers = await t.auth.as(me);
    const targets = [randomUUID(), randomUUID(), randomUUID()];
    for (const userId of targets) {
      await app().inject({
        method: 'POST',
        url: '/api/v1/me/blocked-users',
        headers,
        payload: { userId },
      });
    }
    const p1 = (await app().inject({ url: '/api/v1/me/blocked-users?limit=2', headers })).json();
    expect(p1.data).toHaveLength(2);
    const p2 = (
      await app().inject({
        url: `/api/v1/me/blocked-users?limit=2&cursor=${p1.page.nextCursor}`,
        headers,
      })
    ).json();
    expect(p2.data).toHaveLength(1);
    expect(new Set([...p1.data, ...p2.data].map((b: { userId: string }) => b.userId))).toEqual(
      new Set(targets),
    );
  });
});

describe('history and read state', () => {
  it('pages history newest first', async () => {
    const { buyer, id } = await listingConversation();
    for (const body of ['one', 'two', 'three']) await send(buyer, id, body);
    const headers = await t.auth.as(buyer);
    const p1 = (
      await app().inject({ url: `/api/v1/conversations/${id}/messages?limit=2`, headers })
    ).json();
    expect(p1.data.map((m: { body: string }) => m.body)).toEqual(['three', 'two']);
    const p2 = (
      await app().inject({
        url: `/api/v1/conversations/${id}/messages?limit=2&before=${p1.page.nextCursor}`,
        headers,
      })
    ).json();
    expect(p2.data.map((m: { body: string }) => m.body)).toEqual(['one']);
    expect(p2.page.nextCursor).toBeNull();
  });

  it('keeps unread counters and a monotonic read marker', async () => {
    const { buyer, seller, id } = await listingConversation();
    const ms = [];
    for (const body of ['a', 'b', 'c']) ms.push((await send(buyer, id, body)).json().data);
    expect((await getConversation(seller, id)).json().data.unreadCount).toBe(3);
    expect((await getConversation(buyer, id)).json().data.unreadCount).toBe(0);

    const r1 = await markRead(seller, id, ms[1].id);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().data).toEqual({ lastReadMessageId: ms[1].id, unreadCount: 1 });

    // Never moves backwards.
    const r2 = await markRead(seller, id, ms[0].id);
    expect(r2.json().data).toEqual({ lastReadMessageId: ms[1].id, unreadCount: 1 });
    const c = (await getConversation(seller, id)).json().data;
    expect(c).toMatchObject({ unreadCount: 1, lastReadMessageId: ms[1].id });

    // Replying marks everything before it read; the other side gets one unread.
    await send(seller, id, 'yes');
    expect((await getConversation(seller, id)).json().data.unreadCount).toBe(0);
    expect((await getConversation(buyer, id)).json().data.unreadCount).toBe(1);

    // A message from another conversation is not a valid marker.
    const other = await listingConversation();
    const foreign = (await send(other.buyer, other.id, 'x')).json().data;
    expect((await markRead(seller, id, foreign.id)).statusCode).toBe(404);
  });
});

describe('long poll', () => {
  it('returns at once when newer messages exist', async () => {
    const { buyer, seller, id } = await listingConversation();
    const first = (await send(buyer, id, 'first')).json().data;
    await send(buyer, id, 'second');
    const started = Date.now();
    const res = await app().inject({
      url: `/api/v1/conversations/${id}/messages?after=${first.id}&wait=3`,
      headers: await t.auth.as(seller),
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.json().data.map((m: { body: string }) => m.body)).toEqual(['second']);
  });

  it('wakes as soon as a message is sent from another request', async () => {
    const { buyer, seller, id } = await listingConversation();
    const first = (await send(buyer, id, 'first')).json().data;
    const headers = await t.auth.as(seller);
    const started = Date.now();
    const poll = app().inject({
      url: `/api/v1/conversations/${id}/messages?after=${first.id}&wait=3`,
      headers,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(t.svc.notifier.activeChannels).toBe(1);
    const sent = (await send(buyer, id, 'are you there?')).json().data;
    const res = await poll;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { id: string }) => m.id)).toEqual([sent.id]);
    expect(t.svc.notifier.activeChannels).toBe(0);
  });

  it('returns [] when nothing arrives before the wait ends', async () => {
    const { buyer, seller, id } = await listingConversation();
    const first = (await send(buyer, id, 'first')).json().data;
    const started = Date.now();
    const res = await app().inject({
      url: `/api/v1/conversations/${id}/messages?after=${first.id}&wait=1`,
      headers: await t.auth.as(seller),
    });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([]);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2500);
    expect(t.svc.notifier.activeChannels).toBe(0);
  });

  it('caps the wait and validates its parameters', async () => {
    const { buyer, id } = await listingConversation();
    const first = (await send(buyer, id, 'first')).json().data;
    const headers = await t.auth.as(buyer);
    const url = `/api/v1/conversations/${id}/messages`;
    expect(
      (await app().inject({ url: `${url}?after=${first.id}&wait=4`, headers })).statusCode,
    ).toBe(400);
    expect((await app().inject({ url: `${url}?wait=1`, headers })).statusCode).toBe(400);
    expect(
      (await app().inject({ url: `${url}?after=${first.id}&before=abc`, headers })).statusCode,
    ).toBe(400);
    expect((await app().inject({ url: `${url}?after=${randomUUID()}`, headers })).statusCode).toBe(
      404,
    );
  });
});

// ---------------------------------------------------------------- moderation

describe('moderation', () => {
  it('hides and restores a message', async () => {
    const { buyer, seller, id } = await listingConversation();
    const m = (await send(buyer, id, 'something rude')).json().data;
    const moderate = (action: 'HIDE' | 'RESTORE') =>
      t.svc.runtime.deliver(
        envelope(ModerationEvents.ContentModerated, {
          caseId: randomUUID(),
          targetType: 'MESSAGE',
          targetId: m.id,
          action,
          reason: 'abuse',
          moderatorId: randomUUID(),
        }),
      );

    await moderate('HIDE');
    const headers = await t.auth.as(seller);
    const list = (
      await app().inject({ url: `/api/v1/conversations/${id}/messages`, headers })
    ).json();
    expect(list.data[0]).toMatchObject({ id: m.id, body: null, removed: true, mediaIds: [] });
    const conv = (await getConversation(seller, id)).json().data;
    expect(conv.lastMessage).toMatchObject({ id: m.id, preview: null, removed: true });

    await moderate('RESTORE');
    const restored = (
      await app().inject({ url: `/api/v1/conversations/${id}/messages`, headers })
    ).json();
    expect(restored.data[0]).toMatchObject({ body: 'something rude', removed: false });
  });

  it('ignores moderation of other target types', async () => {
    const { buyer, id } = await listingConversation();
    const m = (await send(buyer, id, 'fine')).json().data;
    await t.svc.runtime.deliver(
      envelope(ModerationEvents.ContentModerated, {
        caseId: randomUUID(),
        targetType: 'LISTING',
        targetId: m.id,
        action: 'HIDE',
        reason: 'x',
        moderatorId: randomUUID(),
      }),
    );
    const row = await db()
      .selectFrom('messages')
      .select('hidden')
      .where('id', '=', m.id)
      .executeTakeFirstOrThrow();
    expect(row.hidden).toBe(false);
  });

  it('admin read returns context around the message and is audited', async () => {
    const { buyer, seller, id } = await listingConversation();
    const sent: { id: string; body: string }[] = [];
    for (let i = 0; i < 22; i++) {
      sent.push((await send(i % 2 ? seller : buyer, id, `m${i}`)).json().data);
    }
    const target = sent[11]!;
    const moderator = randomUUID();

    // Members may not use it.
    const member = await app().inject({
      url: `/api/v1/admin/messages/${target.id}`,
      headers: await t.auth.as(buyer),
    });
    expect(member.statusCode).toBe(403);

    const res = await app().inject({
      url: `/api/v1/admin/messages/${target.id}`,
      headers: await t.auth.as(moderator, ['MODERATOR']),
    });
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.message).toMatchObject({ id: target.id, body: 'm11', hidden: false });
    expect(d.before.map((m: { body: string }) => m.body)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i + 1}`),
    );
    expect(d.after.map((m: { body: string }) => m.body)).toEqual(
      Array.from({ length: 10 }, (_, i) => `m${i + 12}`),
    );
    expect(new Set(d.conversation.participantIds)).toEqual(new Set([buyer, seller]));

    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'actor_id', 'actor_type', 'target_type'])
      .where('target_id', '=', target.id)
      .execute();
    expect(audit).toEqual([
      {
        action: 'message.read.admin',
        actor_id: moderator,
        actor_type: 'ADMIN',
        target_type: 'MESSAGE',
      },
    ]);

    expect(
      (
        await app().inject({
          url: `/api/v1/admin/messages/${randomUUID()}`,
          headers: await t.auth.as(moderator, ['MODERATOR']),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('internal lookup tells moderation who sent a message, without the body', async () => {
    const { buyer, seller, id } = await listingConversation();
    const m = (await send(buyer, id, 'secret words')).json().data;
    const res = await app().inject({
      url: `/internal/v1/messages/${m.id}`,
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      id: m.id,
      conversationId: id,
      senderId: buyer,
      hidden: false,
    });
    expect(new Set(res.json().data.participantIds)).toEqual(new Set([buyer, seller]));
    expect(res.body).not.toContain('secret');

    expect((await app().inject({ url: `/internal/v1/messages/${m.id}` })).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------- projections

describe('projection redelivery', () => {
  it('a redelivered or stale event has no second effect', async () => {
    const seller = randomUUID();
    const f = listingFacts(seller);
    const published = envelope(CatalogEvents.ListingPublished, f, f.listingId);
    expect(await t.svc.runtime.deliver(published)).toBe(true);
    expect(await t.svc.runtime.deliver(published)).toBe(false);

    // An older "unavailable" arriving late must not close a listing published after it.
    const stale = {
      ...envelope(CatalogEvents.ListingUnavailable, {
        listingId: f.listingId,
        sellerId: seller,
        reason: 'PAUSED',
      }),
      occurredAt: new Date(Date.parse(published.occurredAt) - 60_000).toISOString(),
    };
    expect(await t.svc.runtime.deliver(stale)).toBe(true);
    expect((await open(randomUUID(), 'LISTING', f.listingId)).statusCode).toBe(201);

    const offer = envelope(OfferEvents.OfferSubmitted, {
      offerId: randomUUID(),
      needId: randomUUID(),
      buyerId: randomUUID(),
      sellerId: seller,
      price: { amount: 1, currency: 'BDT' },
      quantity: 1,
    });
    expect(await t.svc.runtime.deliver(offer)).toBe(true);
    expect(await t.svc.runtime.deliver(offer)).toBe(false);
    const rows = await db()
      .selectFrom('conversation_contexts')
      .select('context_id')
      .where('owner_id', '=', seller)
      .execute();
    expect(rows).toHaveLength(2);

    // Moderation redelivery: hiding twice is the same as hiding once.
    const { buyer, id } = await listingConversation();
    const m = (await send(buyer, id, 'x')).json().data;
    const hide = envelope(ModerationEvents.ContentModerated, {
      caseId: randomUUID(),
      targetType: 'MESSAGE',
      targetId: m.id,
      action: 'HIDE',
      reason: 'spam',
      moderatorId: randomUUID(),
    });
    expect(await t.svc.runtime.deliver(hide)).toBe(true);
    expect(await t.svc.runtime.deliver(hide)).toBe(false);
    const row = await db()
      .selectFrom('messages')
      .select('hidden')
      .where('id', '=', m.id)
      .executeTakeFirstOrThrow();
    expect(row.hidden).toBe(true);
  });
});
