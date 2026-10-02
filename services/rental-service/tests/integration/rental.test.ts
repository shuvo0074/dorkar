import { randomUUID } from 'node:crypto';
import {
  CatalogEvents,
  RentalEvents,
  TransactionEvents,
  type Role,
  type TransactionState,
} from '@dorkar/contracts';
import { createInternalClient, Errors, uuidv7 } from '@dorkar/kernel';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import type { VerificationGateway } from '../../src/application/ports';
import { buildRentalService } from '../../src/app';
import { httpVerificationGateway } from '../../src/infrastructure/http-gateways';

let t: TestService<Awaited<ReturnType<typeof buildRentalService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

let verificationMode: 'ok' | 'deny' | 'down' = 'ok';
const verificationCalls: Array<Record<string, unknown>> = [];
const verification: VerificationGateway = {
  async evaluate(q) {
    verificationCalls.push(q);
    if (verificationMode === 'down') throw Errors.unavailable('Verification is down.');
    return verificationMode === 'ok'
      ? { satisfied: true, missing: [] }
      : { satisfied: false, missing: ['NID'] };
  },
};

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'rental',
    migrations,
    build: (env, logger, verifier) => buildRentalService(env, logger, { verifier, verification }),
  });
});
afterAll(() => t.close());
beforeEach(() => {
  verificationMode = 'ok';
});

// ---------------------------------------------------------------- helpers

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A whole hour `days` days from now: far enough for the default 12h notice. */
const future = (days: number, hours = 0) => {
  const base = Math.ceil(Date.now() / HOUR) * HOUR;
  return new Date(base + days * DAY + hours * HOUR);
};
const isoAt = (d: Date) => d.toISOString();

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

async function publishListing(
  over: Partial<{ kind: 'PRODUCT' | 'RENTAL'; priceUnit: string; price: number }> = {},
) {
  const listingId = randomUUID();
  const ownerId = randomUUID();
  const categoryId = randomUUID();
  await t.svc.runtime.deliver(
    envelope(CatalogEvents.ListingPublished, {
      listingId,
      sellerId: ownerId,
      categoryId,
      kind: over.kind ?? 'RENTAL',
      condition: 'USED',
      title: 'Canon EOS 90D with 18-135mm',
      price: { amount: over.price ?? 150_000, currency: 'BDT' },
      priceUnit: (over.priceUnit ?? 'PER_DAY') as 'PER_DAY',
      quantityAvailable: 1,
      district: 'dhaka',
      attributes: {},
      deliveryModes: ['BUYER_PICKUP'],
    }),
  );
  return { listingId, ownerId, categoryId };
}

const termsBody = (over: Record<string, unknown> = {}) => ({
  instantBook: false,
  minDurationHours: 24,
  maxDurationDays: 30,
  deposit: null,
  advanceNoticeHours: 12,
  bufferHours: 0,
  cancellationNote: null,
  ...over,
});

async function putTerms(listingId: string, actorId: string, over: Record<string, unknown> = {}) {
  return app().inject({
    method: 'PUT',
    url: `/api/v1/listings/${listingId}/rental-terms`,
    headers: await as(actorId),
    payload: termsBody(over),
  });
}

const book = (
  listingId: string,
  renterId: string,
  startAt: Date,
  endAt: Date,
  opts: { key?: string | null; note?: string } = {},
) =>
  post(
    '/api/v1/bookings',
    renterId,
    {
      listingId,
      startAt: isoAt(startAt),
      endAt: isoAt(endAt),
      ...(opts.note ? { note: opts.note } : {}),
    },
    opts.key !== undefined ? { key: opts.key } : {},
  );

const cmd = (id: string, command: string, actorId: string, payload?: unknown, key?: string) =>
  post(`/api/v1/bookings/${id}/${command}`, actorId, payload, key ? { key } : {});

const get = async (id: string, actorId: string, roles?: Role[]) =>
  app().inject({ url: `/api/v1/bookings/${id}`, headers: await as(actorId, roles) });

const availability = (listingId: string, from: Date, to: Date) =>
  app().inject({
    url: `/api/v1/listings/${listingId}/availability?from=${encodeURIComponent(isoAt(from))}&to=${encodeURIComponent(isoAt(to))}`,
  });

const outbox = async (bookingId: string, type?: string) => {
  let q = db()
    .selectFrom('outbox')
    .select(['type', 'payload'])
    .where('aggregate_id', '=', bookingId);
  if (type) q = q.where('type', '=', type);
  return q.orderBy('occurred_at').orderBy('id').execute();
};

const transitionCount = async (bookingId: string) =>
  Number(
    (
      await db()
        .selectFrom('booking_transitions')
        .select(db().fn.countAll<string>().as('n'))
        .where('booking_id', '=', bookingId)
        .executeTakeFirstOrThrow()
    ).n,
  );

const runJob = (job: 'expireBookings' | 'notifyOverdue') =>
  db()
    .transaction()
    .execute((trx) => t.svc.jobs[job](trx));

/** A listing with a confirmed (approved) booking. */
async function confirmedBooking(terms: Record<string, unknown> = {}) {
  const l = await publishListing();
  if (Object.keys(terms).length)
    expect((await putTerms(l.listingId, l.ownerId, terms)).statusCode).toBe(200);
  const renterId = randomUUID();
  const startAt = future(3);
  const endAt = future(5);
  const res = await book(l.listingId, renterId, startAt, endAt);
  expect(res.statusCode).toBe(201);
  const id = res.json().data.id as string;
  expect((await cmd(id, 'approve', l.ownerId)).statusCode).toBe(200);
  return { ...l, id, renterId, startAt, endAt };
}

const txChanged = (
  b: { id: string; renterId: string; ownerId: string },
  transactionId: string,
  from: TransactionState,
  to: TransactionState,
) =>
  envelope(TransactionEvents.TransactionStateChanged, {
    transactionId,
    needId: null,
    sourceType: 'BOOKING',
    sourceId: b.id,
    buyerId: b.renterId,
    sellerId: b.ownerId,
    from,
    to,
    actorId: null,
    mode: 'RENT',
  });

const txCreated = (b: { id: string; renterId: string; ownerId: string }, transactionId: string) =>
  envelope(TransactionEvents.TransactionCreated, {
    transactionId,
    sourceType: 'BOOKING',
    sourceId: b.id,
    needId: null,
    listingId: null,
    buyerId: b.renterId,
    sellerId: b.ownerId,
    amount: { amount: 300_000, currency: 'BDT' },
    quantity: 1,
    mode: 'RENT',
  });

// ---------------------------------------------------------------- terms

describe('rental terms', () => {
  it('serves defaults publicly until the owner sets terms', async () => {
    const { listingId } = await publishListing();
    const res = await app().inject({ url: `/api/v1/listings/${listingId}/rental-terms` });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      listingId,
      instantBook: false,
      minDurationHours: 24,
      maxDurationDays: 30,
      deposit: null,
      advanceNoticeHours: 12,
      bufferHours: 0,
      cancellationNote: null,
      updatedAt: null,
    });
  });

  it('only the owner can set them; others get 404; unknown listings 404', async () => {
    const { listingId, ownerId } = await publishListing();
    const body = { deposit: { amount: 500_000, currency: 'BDT' }, instantBook: true };
    expect((await putTerms(listingId, randomUUID(), body)).statusCode).toBe(404);
    const res = await putTerms(listingId, ownerId, body);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ instantBook: true, deposit: { amount: 500_000 } });
    expect(res.json().data.updatedAt).not.toBeNull();
    const pub = await app().inject({ url: `/api/v1/listings/${listingId}/rental-terms` });
    expect(pub.json().data.instantBook).toBe(true);
    expect((await putTerms(randomUUID(), ownerId)).statusCode).toBe(404);
    expect(
      (await app().inject({ url: `/api/v1/listings/${randomUUID()}/rental-terms` })).statusCode,
    ).toBe(404);
  });

  it('validates: unknown fields 400, inconsistent 422, contact info 422', async () => {
    const { listingId, ownerId } = await publishListing();
    expect((await putTerms(listingId, ownerId, { sneaky: 1 })).statusCode).toBe(400);
    const bad = await putTerms(listingId, ownerId, { minDurationHours: 100, maxDurationDays: 2 });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details.rule).toBe('TERMS_INCONSISTENT');
    const contact = await putTerms(listingId, ownerId, {
      cancellationNote: 'Call 01712-345678 to cancel',
    });
    expect(contact.statusCode).toBe(422);
    expect(contact.json().error.details.rule).toBe('NO_CONTACT_INFO');
  });

  it('non-rental listings are not part of rental', async () => {
    const { listingId } = await publishListing({ kind: 'PRODUCT' });
    expect(
      (await app().inject({ url: `/api/v1/listings/${listingId}/rental-terms` })).statusCode,
    ).toBe(404);
    expect((await book(listingId, randomUUID(), future(2), future(3))).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- approval / instant flows

describe('request → approve', () => {
  it('creates PENDING_APPROVAL with price, deposit and per-role actions', async () => {
    const l = await publishListing({ price: 150_000, priceUnit: 'PER_DAY' });
    await putTerms(l.listingId, l.ownerId, {
      deposit: { amount: 1_000_000, currency: 'BDT' },
      cancellationNote: 'Free cancellation until approval.',
    });
    const renterId = randomUUID();
    const startAt = future(2);
    const endAt = future(4, 1); // 49h → 3 days
    const res = await book(l.listingId, renterId, startAt, endAt, { note: 'For a wedding shoot' });
    expect(res.statusCode).toBe(201);
    const b = res.json().data;
    expect(b).toMatchObject({
      listingId: l.listingId,
      ownerId: l.ownerId,
      renterId,
      status: 'PENDING_APPROVAL',
      startAt: isoAt(startAt),
      endAt: isoAt(endAt),
      amount: { amount: 450_000, currency: 'BDT' },
      deposit: { amount: 1_000_000, currency: 'BDT' },
      note: 'For a wedding shoot',
      transactionId: null,
      disputed: false,
      viewerRole: 'RENTER',
      actions: ['cancel'],
    });
    expect(b.terms).toMatchObject({ priceUnit: 'PER_DAY', billedUnits: 3, hours: 49 });
    const hold = new Date(b.holdExpiresAt).getTime();
    expect(Math.abs(hold - (Date.now() + DAY))).toBeLessThan(60_000);
    expect(verificationCalls.at(-1)).toMatchObject({
      action: 'BOOKING_CREATE',
      categoryId: l.categoryId,
      mode: 'RENT',
      amount: 450_000,
    });

    const ownerView = await get(b.id, l.ownerId);
    expect(ownerView.json().data).toMatchObject({
      viewerRole: 'OWNER',
      actions: ['approve', 'decline'],
    });

    // The renter cannot approve their own request.
    expect((await cmd(b.id, 'approve', renterId)).statusCode).toBe(403);

    const approved = await cmd(b.id, 'approve', l.ownerId);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data).toMatchObject({
      status: 'CONFIRMED',
      holdExpiresAt: null,
      actions: [],
    });
    expect(approved.json().data.transitions.map((x: { to: string }) => x.to)).toEqual([
      'PENDING_APPROVAL',
      'CONFIRMED',
    ]);

    // Events written in one transaction share a millisecond; their relative order is not defined.
    const events = await outbox(b.id);
    expect(events.map((e) => e.type).sort()).toEqual([
      'rental.BookingConfirmed',
      'rental.BookingStatusChanged',
      'rental.BookingStatusChanged',
    ]);
    const changes = events
      .filter((e) => e.type === 'rental.BookingStatusChanged')
      .map((e) => RentalEvents.BookingStatusChanged.schema.parse(e.payload));
    expect(changes.map((c) => [c.from, c.to, c.transactionId, c.reason])).toEqual([
      ['PENDING_APPROVAL', 'PENDING_APPROVAL', null, 'REQUESTED'],
      ['PENDING_APPROVAL', 'CONFIRMED', null, 'OWNER_APPROVED'],
    ]);
    const confirmed = RentalEvents.BookingConfirmed.schema.parse(
      events.find((e) => e.type === 'rental.BookingConfirmed')!.payload,
    );
    expect(confirmed).toEqual({
      bookingId: b.id,
      listingId: l.listingId,
      ownerId: l.ownerId,
      renterId,
      startAt: isoAt(startAt),
      endAt: isoAt(endAt),
      amount: { amount: 450_000, currency: 'BDT' },
      deposit: { amount: 1_000_000, currency: 'BDT' },
      terms: expect.objectContaining({
        priceUnit: 'PER_DAY',
        unitPrice: { amount: 150_000, currency: 'BDT' },
        hours: 49,
        billedUnits: 3,
        depositNote: expect.any(String),
        cancellationNote: 'Free cancellation until approval.',
      }),
    });

    // Approving twice is a state conflict.
    expect((await cmd(b.id, 'approve', l.ownerId)).statusCode).toBe(409);
  });

  it('decline records the reason and frees the calendar', async () => {
    const l = await publishListing();
    const startAt = future(2);
    const endAt = future(3);
    const first = (await book(l.listingId, randomUUID(), startAt, endAt)).json().data;
    expect((await book(l.listingId, randomUUID(), startAt, endAt)).statusCode).toBe(409);
    expect((await cmd(first.id, 'decline', l.ownerId, {})).statusCode).toBe(400);
    const declined = await cmd(first.id, 'decline', l.ownerId, {
      reason: 'Under repair that week',
    });
    expect(declined.statusCode).toBe(200);
    expect(declined.json().data).toMatchObject({
      status: 'DECLINED',
      declineReason: 'Under repair that week',
    });
    const [, changed] = await outbox(first.id, 'rental.BookingStatusChanged');
    expect(changed!.payload).toMatchObject({ to: 'DECLINED', reason: 'Under repair that week' });
    expect((await book(l.listingId, randomUUID(), startAt, endAt)).statusCode).toBe(201);
  });

  it('the renter can cancel while pending; the owner cannot', async () => {
    const l = await publishListing();
    const renterId = randomUUID();
    const b = (await book(l.listingId, renterId, future(2), future(3))).json().data;
    expect((await cmd(b.id, 'cancel', l.ownerId)).statusCode).toBe(403);
    const res = await cmd(b.id, 'cancel', renterId, { reason: 'Plans changed' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Plans changed' });
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(201);
  });

  it('after confirmation the renter cannot cancel here (it goes through the transaction)', async () => {
    const b = await confirmedBooking();
    const res = await cmd(b.id, 'cancel', b.renterId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('instant book', () => {
  it('holds for 15 minutes; the renter confirms → CONFIRMED + BookingConfirmed', async () => {
    const l = await publishListing({ priceUnit: 'PER_HOUR', price: 20_000 });
    await putTerms(l.listingId, l.ownerId, { instantBook: true, minDurationHours: 2 });
    const renterId = randomUUID();
    const startAt = future(1);
    const endAt = future(1, 5);
    const res = await book(l.listingId, renterId, startAt, endAt);
    expect(res.statusCode).toBe(201);
    const b = res.json().data;
    expect(b).toMatchObject({
      status: 'HELD',
      amount: { amount: 100_000 },
      actions: ['confirm', 'cancel'],
    });
    const hold = new Date(b.holdExpiresAt).getTime();
    expect(Math.abs(hold - (Date.now() + 15 * 60_000))).toBeLessThan(60_000);

    expect((await cmd(b.id, 'confirm', l.ownerId)).statusCode).toBe(403);
    const confirmed = await cmd(b.id, 'confirm', renterId);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().data.status).toBe('CONFIRMED');
    const [evt] = await outbox(b.id, 'rental.BookingConfirmed');
    expect(RentalEvents.BookingConfirmed.schema.parse(evt!.payload)).toMatchObject({
      bookingId: b.id,
      amount: { amount: 100_000, currency: 'BDT' },
      deposit: null,
      terms: { priceUnit: 'PER_HOUR', unitPrice: { amount: 20_000 }, hours: 5, billedUnits: 5 },
    });
  });

  it('a lapsed hold cannot be confirmed', async () => {
    const l = await publishListing();
    await putTerms(l.listingId, l.ownerId, { instantBook: true });
    const renterId = randomUUID();
    const b = (await book(l.listingId, renterId, future(2), future(3))).json().data;
    await db()
      .updateTable('bookings')
      .set({ hold_expires_at: sql<Date>`now() - interval '1 second'` })
      .where('id', '=', b.id)
      .execute();
    const res = await cmd(b.id, 'confirm', renterId);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('HOLD_EXPIRED');
  });
});

// ---------------------------------------------------------------- calendar invariants

describe('calendar', () => {
  it('10 parallel overlapping requests: exactly one is created, the rest 409 BOOKING_CONFLICT', async () => {
    const l = await publishListing();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        book(l.listingId, randomUUID(), future(5, i), future(7, i)),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(9);
    for (const r of results.filter((x) => x.statusCode === 409)) {
      expect(r.json().error.details.rule).toBe('BOOKING_CONFLICT');
    }
    const rows = await db()
      .selectFrom('bookings')
      .select('id')
      .where('listing_id', '=', l.listingId)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('adjacent periods both succeed ([) bounds)', async () => {
    const l = await publishListing();
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(201);
    expect((await book(l.listingId, randomUUID(), future(3), future(4))).statusCode).toBe(201);
    expect((await book(l.listingId, randomUUID(), future(1), future(2))).statusCode).toBe(201);
    const res = await availability(l.listingId, future(0, 12), future(5));
    expect(res.json().data.busy).toEqual([{ startAt: isoAt(future(1)), endAt: isoAt(future(4)) }]);
  });

  it('honours the buffer after each booking', async () => {
    const l = await publishListing();
    await putTerms(l.listingId, l.ownerId, { bufferHours: 3 });
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(201);
    const tooSoon = await book(l.listingId, randomUUID(), future(3, 2), future(4, 2));
    expect(tooSoon.statusCode).toBe(409);
    expect(tooSoon.json().error.details.rule).toBe('BOOKING_CONFLICT');
    expect((await book(l.listingId, randomUUID(), future(3, 3), future(4, 3))).statusCode).toBe(
      201,
    );
    // A booking placed before an existing one must leave its own buffer free too.
    expect((await book(l.listingId, randomUUID(), future(1), future(2))).statusCode).toBe(409);
    expect((await book(l.listingId, randomUUID(), future(1), future(1, 21))).statusCode).toBe(
      422, // 21h < 24h minimum
    );
  });

  it('owner blocks prevent bookings and can be removed; others cannot touch them', async () => {
    const l = await publishListing();
    const blockBody = { startAt: isoAt(future(10)), endAt: isoAt(future(12)), reason: 'Servicing' };
    const url = `/api/v1/listings/${l.listingId}/availability/blocks`;
    expect((await post(url, randomUUID(), blockBody)).statusCode).toBe(404);
    expect((await post(url, l.ownerId, blockBody, { key: null })).statusCode).toBe(400);
    const created = await post(url, l.ownerId, blockBody);
    expect(created.statusCode).toBe(201);
    const blockId = created.json().data.id as string;

    const blocked = await book(l.listingId, randomUUID(), future(11), future(13));
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.details.rule).toBe('BOOKING_CONFLICT');

    const list = await app().inject({ url, headers: await as(l.ownerId) });
    expect(list.json().data).toEqual([
      expect.objectContaining({ id: blockId, reason: 'Servicing' }),
    ]);
    expect((await app().inject({ url, headers: await as(randomUUID()) })).statusCode).toBe(404);

    // Overlapping an existing booking is refused too.
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(201);
    const overBooking = await post(url, l.ownerId, {
      startAt: isoAt(future(2, 12)),
      endAt: isoAt(future(4)),
    });
    expect(overBooking.statusCode).toBe(409);

    const del = async (actor: string) =>
      app().inject({ method: 'DELETE', url: `${url}/${blockId}`, headers: await as(actor) });
    expect((await del(randomUUID())).statusCode).toBe(404);
    expect((await del(l.ownerId)).statusCode).toBe(204);
    expect((await del(l.ownerId)).statusCode).toBe(404);
    expect((await book(l.listingId, randomUUID(), future(11), future(13))).statusCode).toBe(201);
  });

  it('availability shows merged busy intervals only, never who or why', async () => {
    const l = await publishListing();
    await putTerms(l.listingId, l.ownerId, { bufferHours: 2 });
    const renterId = randomUUID();
    const b = (await book(l.listingId, renterId, future(2), future(3))).json().data;
    await post(`/api/v1/listings/${l.listingId}/availability/blocks`, l.ownerId, {
      startAt: isoAt(future(3, 2)),
      endAt: isoAt(future(4)),
      reason: 'Family use',
    });
    await post(`/api/v1/listings/${l.listingId}/availability/blocks`, l.ownerId, {
      startAt: isoAt(future(6)),
      endAt: isoAt(future(7)),
    });
    const res = await availability(l.listingId, future(1), future(6, 12));
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      listingId: l.listingId,
      from: isoAt(future(1)),
      to: isoAt(future(6, 12)),
      busy: [
        { startAt: isoAt(future(2)), endAt: isoAt(future(4)) }, // booking + buffer + block
        { startAt: isoAt(future(6)), endAt: isoAt(future(6, 12)) }, // clipped
      ],
    });
    const raw = res.body;
    expect(raw).not.toContain(renterId);
    expect(raw).not.toContain(b.id);
    expect(raw).not.toContain('Family');
    expect(raw).not.toMatch(/BLOCK|BOOKING/);
  });

  it('availability validates the window and 404s unknown listings', async () => {
    const l = await publishListing();
    expect((await availability(l.listingId, future(1), future(122))).statusCode).toBe(400);
    expect((await availability(l.listingId, future(2), future(1))).statusCode).toBe(400);
    expect((await availability(randomUUID(), future(1), future(2))).statusCode).toBe(404);
    const dflt = await app().inject({ url: `/api/v1/listings/${l.listingId}/availability` });
    expect(dflt.statusCode).toBe(200);
    expect(dflt.json().data.busy).toEqual([]);
  });

  it('the database itself refuses overlapping active slots (app bugs cannot double-book)', async () => {
    const listingId = randomUUID();
    const insert = (from: Date, to: Date, active = true) =>
      db()
        .insertInto('calendar_slots')
        .values({
          id: uuidv7(),
          listing_id: listingId,
          period: sql<string>`tstzrange(${from}, ${to}, '[)')`,
          kind: 'BLOCK',
          ref_id: null,
          reason: null,
          created_by: null,
          active,
        })
        .execute();
    await insert(future(1), future(2));
    await expect(insert(future(1, 12), future(3))).rejects.toMatchObject({ code: '23P01' });
    await insert(future(2), future(3)); // adjacent
    await insert(future(1), future(3), false); // inactive slots do not count
  });
});

// ---------------------------------------------------------------- expiry

describe('expiry', () => {
  it('the job expires lapsed holds and frees the calendar', async () => {
    const l = await publishListing();
    await putTerms(l.listingId, l.ownerId, { instantBook: true });
    const held = (await book(l.listingId, randomUUID(), future(2), future(3))).json().data;
    const pending = await publishListing();
    const waiting = (await book(pending.listingId, randomUUID(), future(2), future(3))).json().data;
    await db()
      .updateTable('bookings')
      .set({ hold_expires_at: sql<Date>`now() - interval '1 second'` })
      .where('id', 'in', [held.id, waiting.id])
      .execute();

    expect(await runJob('expireBookings')).toBeGreaterThanOrEqual(2);
    expect((await get(held.id, l.ownerId)).json().data.status).toBe('EXPIRED');
    expect((await get(waiting.id, pending.ownerId)).json().data.status).toBe('EXPIRED');
    const [, expired] = await outbox(held.id, 'rental.BookingStatusChanged');
    expect(expired!.payload).toMatchObject({ from: 'HELD', to: 'EXPIRED' });
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(201);

    // Running again changes nothing.
    const before = await transitionCount(held.id);
    await runJob('expireBookings');
    expect(await transitionCount(held.id)).toBe(before);
  });

  it('a lapsed hold does not block a new request even before the job runs', async () => {
    const l = await publishListing();
    await putTerms(l.listingId, l.ownerId, { instantBook: true });
    const held = (await book(l.listingId, randomUUID(), future(2), future(3))).json().data;
    await db()
      .updateTable('bookings')
      .set({ hold_expires_at: sql<Date>`now() - interval '1 second'` })
      .where('id', '=', held.id)
      .execute();
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(201);
    expect((await get(held.id, l.ownerId)).json().data.status).toBe('EXPIRED');
  });

  it('a live hold blocks the period', async () => {
    const l = await publishListing();
    await putTerms(l.listingId, l.ownerId, { instantBook: true });
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(201);
    expect(await runJob('expireBookings')).toBe(0);
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------- transaction mirror

describe('transaction mirror', () => {
  it('follows the transaction: created → handed over → disputed → returned → completed', async () => {
    const b = await confirmedBooking();
    const txId = randomUUID();
    await t.svc.runtime.deliver(txCreated(b, txId));
    expect((await get(b.id, b.renterId)).json().data).toMatchObject({
      status: 'CONFIRMED',
      transactionId: txId,
    });

    await t.svc.runtime.deliver(txChanged(b, txId, 'CREATED', 'CONFIRMED'));
    expect((await get(b.id, b.renterId)).json().data.status).toBe('CONFIRMED');

    await t.svc.runtime.deliver(txChanged(b, txId, 'CONFIRMED', 'HANDED_OVER'));
    expect((await get(b.id, b.renterId)).json().data.status).toBe('ACTIVE');

    await t.svc.runtime.deliver(txChanged(b, txId, 'HANDED_OVER', 'DISPUTED'));
    expect((await get(b.id, b.renterId)).json().data).toMatchObject({
      status: 'ACTIVE',
      disputed: true,
    });
    // Dispute withdrawn: back to HANDED_OVER; the booking was already ACTIVE.
    const n = await transitionCount(b.id);
    await t.svc.runtime.deliver(txChanged(b, txId, 'DISPUTED', 'HANDED_OVER'));
    expect((await get(b.id, b.renterId)).json().data).toMatchObject({
      status: 'ACTIVE',
      disputed: false,
    });
    expect(await transitionCount(b.id)).toBe(n);

    await t.svc.runtime.deliver(txChanged(b, txId, 'HANDED_OVER', 'RETURN_REPORTED'));
    expect((await get(b.id, b.renterId)).json().data.status).toBe('ACTIVE');
    await t.svc.runtime.deliver(txChanged(b, txId, 'RETURN_REPORTED', 'RETURNED'));
    expect((await get(b.id, b.renterId)).json().data.status).toBe('RETURNED');
    await t.svc.runtime.deliver(txChanged(b, txId, 'RETURNED', 'COMPLETED'));
    const done = (await get(b.id, b.renterId)).json().data;
    expect(done.status).toBe('CLOSED');
    expect(done.transitions.map((x: { to: string }) => x.to)).toEqual([
      'PENDING_APPROVAL',
      'CONFIRMED',
      'ACTIVE',
      'RETURNED',
      'CLOSED',
    ]);

    const changes = (await outbox(b.id, 'rental.BookingStatusChanged')).map((e) =>
      RentalEvents.BookingStatusChanged.schema.parse(e.payload),
    );
    expect(changes.slice(2).map((c) => [c.from, c.to, c.transactionId])).toEqual([
      ['CONFIRMED', 'ACTIVE', txId],
      ['ACTIVE', 'RETURNED', txId],
      ['RETURNED', 'CLOSED', txId],
    ]);
  });

  it('a cancelled transaction cancels the booking and frees the calendar', async () => {
    const b = await confirmedBooking();
    expect((await book(b.listingId, randomUUID(), b.startAt, b.endAt)).statusCode).toBe(409);
    const txId = randomUUID();
    await t.svc.runtime.deliver(txCreated(b, txId));
    await t.svc.runtime.deliver(txChanged(b, txId, 'CREATED', 'CANCELLED'));
    const view = (await get(b.id, b.ownerId)).json().data;
    expect(view.status).toBe('CANCELLED');
    const [, , last] = await outbox(b.id, 'rental.BookingStatusChanged');
    expect(last!.payload).toMatchObject({
      from: 'CONFIRMED',
      to: 'CANCELLED',
      transactionId: txId,
    });
    expect((await book(b.listingId, randomUUID(), b.startAt, b.endAt)).statusCode).toBe(201);
  });

  it('expired or refunded transactions also cancel', async () => {
    for (const to of ['EXPIRED', 'REFUNDED'] as const) {
      const b = await confirmedBooking();
      await t.svc.runtime.deliver(txChanged(b, randomUUID(), 'CREATED', to));
      expect((await get(b.id, b.ownerId)).json().data).toMatchObject({
        status: 'CANCELLED',
        transactionId: expect.any(String),
      });
    }
  });

  it('redelivery has no double effect', async () => {
    const b = await confirmedBooking();
    const txId = randomUUID();
    const e = txChanged(b, txId, 'CONFIRMED', 'HANDED_OVER');
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false); // inbox
    // The same fact in a new envelope is absorbed by the state machine.
    expect(await t.svc.runtime.deliver(txChanged(b, txId, 'CONFIRMED', 'HANDED_OVER'))).toBe(true);
    expect(await transitionCount(b.id)).toBe(3);
    expect(await outbox(b.id, 'rental.BookingStatusChanged')).toHaveLength(3);
  });

  it('ignores transactions from other sources and unknown bookings', async () => {
    const b = await confirmedBooking();
    await t.svc.runtime.deliver(
      envelope(TransactionEvents.TransactionStateChanged, {
        transactionId: randomUUID(),
        needId: null,
        sourceType: 'OFFER',
        sourceId: b.id,
        buyerId: b.renterId,
        sellerId: b.ownerId,
        from: 'CONFIRMED',
        to: 'CANCELLED',
        actorId: null,
      }),
    );
    expect((await get(b.id, b.ownerId)).json().data.status).toBe('CONFIRMED');
    const ghost = { id: randomUUID(), renterId: randomUUID(), ownerId: randomUUID() };
    expect(
      await t.svc.runtime.deliver(txChanged(ghost, randomUUID(), 'CONFIRMED', 'HANDED_OVER')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------- overdue

describe('overdue', () => {
  async function activePastEnd() {
    const b = await confirmedBooking();
    const txId = randomUUID();
    await t.svc.runtime.deliver(txCreated(b, txId));
    await t.svc.runtime.deliver(txChanged(b, txId, 'CONFIRMED', 'HANDED_OVER'));
    await db()
      .updateTable('bookings')
      .set({
        start_at: sql<Date>`now() - interval '3 days'`,
        end_at: sql<Date>`now() - interval '3 hours'`,
      })
      .where('id', '=', b.id)
      .execute();
    return { ...b, txId };
  }

  it('emits BookingOverdue once, after the grace period', async () => {
    const b = await activePastEnd();
    expect(await runJob('notifyOverdue')).toBeGreaterThanOrEqual(1);
    await runJob('notifyOverdue');
    const events = await outbox(b.id, 'rental.BookingOverdue');
    expect(events).toHaveLength(1);
    expect(RentalEvents.BookingOverdue.schema.parse(events[0]!.payload)).toMatchObject({
      bookingId: b.id,
      transactionId: b.txId,
      renterId: b.renterId,
      ownerId: b.ownerId,
    });
    expect((await get(b.id, b.renterId)).json().data.overdueNotifiedAt).not.toBeNull();
  });

  it('not within the grace period, and not once the renter reported the return', async () => {
    const within = await confirmedBooking();
    const tx = randomUUID();
    await t.svc.runtime.deliver(txChanged(within, tx, 'CONFIRMED', 'HANDED_OVER'));
    await db()
      .updateTable('bookings')
      .set({
        start_at: sql<Date>`now() - interval '3 days'`,
        end_at: sql<Date>`now() - interval '1 hour'`,
      })
      .where('id', '=', within.id)
      .execute();
    const reported = await activePastEnd();
    await t.svc.runtime.deliver(
      txChanged(reported, reported.txId, 'HANDED_OVER', 'RETURN_REPORTED'),
    );
    await runJob('notifyOverdue');
    expect(await outbox(within.id, 'rental.BookingOverdue')).toHaveLength(0);
    expect(await outbox(reported.id, 'rental.BookingOverdue')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- authz, validation, idempotency

describe('authorization and reads', () => {
  it('strangers get 404; staff with transaction:read:any can read', async () => {
    const b = await confirmedBooking();
    expect((await get(b.id, randomUUID())).statusCode).toBe(404);
    expect((await get(randomUUID(), b.renterId)).statusCode).toBe(404);
    const staff = await get(b.id, randomUUID(), ['SUPPORT']);
    expect(staff.statusCode).toBe(200);
    expect(staff.json().data).toMatchObject({ viewerRole: null, actions: [] });
    for (const c of ['approve', 'decline', 'cancel', 'confirm']) {
      expect(
        (await cmd(b.id, c, randomUUID(), c === 'decline' ? { reason: 'nope nope' } : undefined))
          .statusCode,
      ).toBe(404);
    }
    expect((await app().inject({ url: `/api/v1/bookings/${b.id}` })).statusCode).toBe(401);
  });

  it('my bookings by role and status, paginated', async () => {
    const l = await publishListing();
    const renterId = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await book(l.listingId, renterId, future(2 + i * 2), future(3 + i * 2));
      ids.push(r.json().data.id);
    }
    await cmd(ids[0]!, 'cancel', renterId);
    const page1 = await app().inject({
      url: '/api/v1/me/bookings?role=renter&limit=2',
      headers: await as(renterId),
    });
    expect(page1.json().data.map((b: { id: string }) => b.id)).toEqual([ids[2], ids[1]]);
    const next = page1.json().page.nextCursor as string;
    const page2 = await app().inject({
      url: `/api/v1/me/bookings?role=renter&limit=2&cursor=${next}`,
      headers: await as(renterId),
    });
    expect(page2.json().data.map((b: { id: string }) => b.id)).toEqual([ids[0]]);
    expect(page2.json().page.nextCursor).toBeNull();

    const asOwner = await app().inject({
      url: '/api/v1/me/bookings?role=owner&status=PENDING_APPROVAL',
      headers: await as(l.ownerId),
    });
    expect(asOwner.json().data).toHaveLength(2);
    const ownerAsRenter = await app().inject({
      url: '/api/v1/me/bookings?role=renter',
      headers: await as(l.ownerId),
    });
    expect(ownerAsRenter.json().data).toHaveLength(0);
    const bad = await app().inject({
      url: '/api/v1/me/bookings?cursor=garbage',
      headers: await as(renterId),
    });
    expect(bad.statusCode).toBe(400);
  });

  it('admin list requires transaction:read:any', async () => {
    const b = await confirmedBooking();
    const url = '/api/v1/admin/bookings?status=CONFIRMED&limit=100';
    expect((await app().inject({ url, headers: await as(randomUUID()) })).statusCode).toBe(403);
    const res = await app().inject({ url, headers: await as(randomUUID(), ['SUPPORT']) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((x: { id: string }) => x.id)).toContain(b.id);
    expect(res.json().data.every((x: { status: string }) => x.status === 'CONFIRMED')).toBe(true);
  });
});

describe('booking request validation', () => {
  it('enforces the terms and the platform window', async () => {
    const l = await publishListing();
    const renter = randomUUID();
    const rule = async (start: Date, end: Date, who = renter) =>
      (await book(l.listingId, who, start, end)).json().error?.details?.rule;
    expect(await rule(future(2), future(2, 23))).toBe('DURATION_TOO_SHORT');
    expect(await rule(future(2), future(33))).toBe('DURATION_TOO_LONG');
    expect(await rule(future(0, 6), future(1, 6))).toBe('ADVANCE_NOTICE');
    expect(await rule(future(179), future(181))).toBe('TOO_FAR_AHEAD');
    expect(await rule(future(2), future(3), l.ownerId)).toBe('OWN_LISTING');
    expect((await book(l.listingId, renter, future(3), future(2))).statusCode).toBe(422);
    expect((await book(randomUUID(), renter, future(2), future(3))).statusCode).toBe(404);
  });

  it('rejects contact info in the note, unknown fields, and unavailable listings', async () => {
    const l = await publishListing();
    const res = await book(l.listingId, randomUUID(), future(2), future(3), {
      note: 'WhatsApp me on +8801712345678',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toMatchObject({ rule: 'NO_CONTACT_INFO', field: 'note' });

    const extra = await post('/api/v1/bookings', randomUUID(), {
      listingId: l.listingId,
      startAt: isoAt(future(2)),
      endAt: isoAt(future(3)),
      price: 1,
    });
    expect(extra.statusCode).toBe(400);

    await t.svc.runtime.deliver(
      envelope(CatalogEvents.ListingUnavailable, {
        listingId: l.listingId,
        sellerId: l.ownerId,
        reason: 'PAUSED',
      }),
    );
    const paused = await book(l.listingId, randomUUID(), future(2), future(3));
    expect(paused.statusCode).toBe(422);
    expect(paused.json().error.details.rule).toBe('LISTING_UNAVAILABLE');
  });

  it('fails closed on verification: unsatisfied → 403, unavailable → 503', async () => {
    const l = await publishListing();
    verificationMode = 'deny';
    const denied = await book(l.listingId, randomUUID(), future(2), future(3));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({
      code: 'VERIFICATION_REQUIRED',
      details: { missing: ['NID'] },
    });
    verificationMode = 'down';
    expect((await book(l.listingId, randomUUID(), future(2), future(3))).statusCode).toBe(503);
    const rows = await db()
      .selectFrom('bookings')
      .select('id')
      .where('listing_id', '=', l.listingId)
      .execute();
    expect(rows).toHaveLength(0);
  });
});

describe('idempotency', () => {
  it('replays the same response for the same key and body, once', async () => {
    const l = await publishListing();
    const renter = randomUUID();
    const key = randomUUID();
    const a = await book(l.listingId, renter, future(2), future(3), { key });
    const b = await book(l.listingId, renter, future(2), future(3), { key });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const rows = await db()
      .selectFrom('bookings')
      .select('id')
      .where('listing_id', '=', l.listingId)
      .execute();
    expect(rows).toHaveLength(1);

    const reused = await book(l.listingId, renter, future(4), future(5), { key });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await book(l.listingId, renter, future(6), future(7), { key: null })).statusCode).toBe(
      400,
    );
  });

  it('commands are idempotent too', async () => {
    const l = await publishListing();
    const b = (await book(l.listingId, randomUUID(), future(2), future(3))).json().data;
    const key = randomUUID();
    const first = await cmd(b.id, 'approve', l.ownerId, undefined, key);
    const again = await cmd(b.id, 'approve', l.ownerId, undefined, key);
    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await outbox(b.id, 'rental.BookingConfirmed')).toHaveLength(1);
    const noKey = await post(`/api/v1/bookings/${b.id}/approve`, l.ownerId, undefined, {
      key: null,
    });
    expect(noKey.statusCode).toBe(400);
  });

  it('requires booking:create and authentication', async () => {
    const l = await publishListing();
    const res = await app().inject({
      method: 'POST',
      url: '/api/v1/bookings',
      payload: { listingId: l.listingId, startAt: isoAt(future(2)), endAt: isoAt(future(3)) },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('verification gateway', () => {
  it('fails closed with 503 when verification is unreachable', async () => {
    const gw = httpVerificationGateway(
      createInternalClient({
        baseUrl: 'http://127.0.0.1:9',
        token: 'x'.repeat(32),
        timeoutMs: 300,
      }),
    );
    const ctx = { requestId: 'r', correlationId: 'c', ipHash: null, userAgent: null, actor: null };
    await expect(
      gw.evaluate(
        {
          accountId: randomUUID(),
          action: 'BOOKING_CREATE',
          categoryId: randomUUID(),
          mode: 'RENT',
          amount: 1,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 503 });
  });
});
