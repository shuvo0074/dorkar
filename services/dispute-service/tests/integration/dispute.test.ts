import { randomUUID } from 'node:crypto';
import { DisputeEvents, TransactionEvents, type Role } from '@dorkar/contracts';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildDisputeService } from '../../src/app';

let t: TestService<Awaited<ReturnType<typeof buildDisputeService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

/** Records media grants instead of calling media-service. */
const grants: Array<{
  ownerId: string;
  mediaIds: string[];
  accountIds: string[];
  purpose: string;
}> = [];
const media = { grant: async (g: (typeof grants)[number]) => void grants.push(g) };

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'dispute',
    migrations,
    build: (env, logger, verifier) => buildDisputeService(env, logger, { verifier, media }),
  });
});
afterAll(() => t.close());

// ---------------------------------------------------------------- helpers

const ADMIN: Role[] = ['ADMIN'];
const SUPPORT: Role[] = ['SUPPORT'];

interface Deal {
  transactionId: string;
  buyerId: string;
  sellerId: string;
  sourceId: string;
  needId: string;
}

const newDeal = (): Deal => ({
  transactionId: randomUUID(),
  buyerId: randomUUID(),
  sellerId: randomUUID(),
  sourceId: randomUUID(),
  needId: randomUUID(),
});

const createdEvent = (d: Deal) =>
  envelope(TransactionEvents.TransactionCreated, {
    transactionId: d.transactionId,
    sourceType: 'OFFER',
    sourceId: d.sourceId,
    needId: d.needId,
    buyerId: d.buyerId,
    sellerId: d.sellerId,
    amount: { amount: 1_250_000, currency: 'BDT' },
    quantity: 1,
    mode: 'BUY',
  });

const changedEvent = (
  d: Deal,
  over: Partial<{
    from: 'DELIVERED' | 'DISPUTED' | 'DELIVERY_PENDING' | 'HANDED_OVER';
    to: 'DISPUTED' | 'COMPLETED' | 'CANCELLED' | 'DELIVERED' | 'HANDED_OVER';
    actorId: string | null;
    reason: string | null;
    disputeReason: 'NOT_AS_DESCRIBED' | 'DAMAGED' | 'NOT_RECEIVED';
    mode: 'BUY' | 'RENT';
  }> = {},
) =>
  envelope(TransactionEvents.TransactionStateChanged, {
    transactionId: d.transactionId,
    needId: d.needId,
    sourceType: 'OFFER',
    sourceId: d.sourceId,
    buyerId: d.buyerId,
    sellerId: d.sellerId,
    from: over.from ?? 'DELIVERED',
    to: over.to ?? 'DISPUTED',
    actorId: over.actorId === undefined ? d.buyerId : over.actorId,
    mode: over.mode ?? 'BUY',
    reason: over.reason === undefined ? 'The phone does not match the photos' : over.reason,
    ...(over.disputeReason !== undefined
      ? { disputeReason: over.disputeReason }
      : { disputeReason: 'NOT_AS_DESCRIBED' as const }),
  });

const casesFor = (transactionId: string) =>
  db()
    .selectFrom('disputes')
    .selectAll()
    .where('transaction_id', '=', transactionId)
    .orderBy('opened_at')
    .execute();

/** A deal disputed by the buyer; returns the case id. */
async function opened(d = newDeal(), over: Parameters<typeof changedEvent>[1] = {}) {
  await t.svc.runtime.deliver(createdEvent(d));
  await t.svc.runtime.deliver(changedEvent(d, over));
  const [c] = await casesFor(d.transactionId);
  return { ...d, id: c!.id };
}

async function post(
  url: string,
  actorId: string,
  payload?: unknown,
  opts: { key?: string | null; roles?: Role[] } = {},
) {
  const headers: Record<string, string> = await t.auth.as(actorId, opts.roles ?? ['MEMBER']);
  if (opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
  return app().inject({
    method: 'POST',
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

const get = async (url: string, actorId: string, roles: Role[] = ['MEMBER']) =>
  app().inject({ url, headers: await t.auth.as(actorId, roles) });

const outbox = (disputeId: string) =>
  db()
    .selectFrom('outbox')
    .select(['type', 'payload'])
    .where('aggregate_id', '=', disputeId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();

const eventsOf = async (disputeId: string, type: string) =>
  (await outbox(disputeId))
    .filter((e) => e.type === type)
    .map((e) => (typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload));

const runJob = (job: 'respondentDeadline' | 'escalateUnassigned') =>
  db()
    .transaction()
    .execute((trx) => t.svc.jobs[job](trx));

const resolve = (id: string, adminId: string, body: object, key?: string) =>
  post(`/api/v1/admin/disputes/${id}/resolve`, adminId, body, {
    roles: ADMIN,
    ...(key ? { key } : {}),
  });

// ---------------------------------------------------------------- opening

describe('opening from TransactionStateChanged', () => {
  it('opens a case awaiting the respondent and emits DisputeOpened', async () => {
    const c = await opened();
    const [row] = await casesFor(c.transactionId);
    expect(row).toMatchObject({
      status: 'AWAITING_RESPONSE',
      opened_by: c.buyerId,
      respondent_id: c.sellerId,
      previous_state: 'DELIVERED',
      reason: 'NOT_AS_DESCRIBED',
      description: 'The phone does not match the photos',
      mode: 'BUY',
      amount: '1250000',
    });
    const hours = (row!.respond_by.getTime() - row!.opened_at.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(72, 1);

    const [payload] = await eventsOf(c.id, 'dispute.DisputeOpened');
    expect(DisputeEvents.DisputeOpened.schema.parse(payload)).toEqual({
      disputeId: c.id,
      transactionId: c.transactionId,
      buyerId: c.buyerId,
      sellerId: c.sellerId,
      openedBy: c.buyerId,
      reason: 'NOT_AS_DESCRIBED',
      previousState: 'DELIVERED',
    });
  });

  it('creates no second case on redelivery or a duplicate event', async () => {
    const d = newDeal();
    await t.svc.runtime.deliver(createdEvent(d));
    const e = changedEvent(d);
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false);
    // A different envelope for the same transition (e.g. replayed by the producer).
    expect(await t.svc.runtime.deliver(changedEvent(d))).toBe(true);
    expect(await casesFor(d.transactionId)).toHaveLength(1);
  });

  it('handles StateChanged arriving before TransactionCreated', async () => {
    const d = newDeal();
    await t.svc.runtime.deliver(
      changedEvent(d, {
        actorId: d.sellerId,
        disputeReason: 'NOT_RECEIVED',
        mode: 'RENT',
        from: 'HANDED_OVER',
      }),
    );
    let [row] = await casesFor(d.transactionId);
    expect(row).toMatchObject({
      status: 'AWAITING_RESPONSE',
      buyer_id: d.buyerId,
      seller_id: d.sellerId,
      opened_by: d.sellerId,
      respondent_id: d.buyerId,
      previous_state: 'HANDED_OVER',
      mode: 'RENT',
      amount: null,
    });
    await t.svc.runtime.deliver(createdEvent(d));
    [row] = await casesFor(d.transactionId);
    expect(row).toMatchObject({ amount: '1250000', currency: 'BDT', mode: 'RENT' });

    const res = await get(`/api/v1/disputes/${row!.id}`, d.buyerId);
    expect(res.json().data).toMatchObject({
      openedBy: 'SELLER',
      respondent: 'BUYER',
      viewerRole: 'BUYER',
    });
  });

  it('defaults the reason to OTHER when the transition carries none', async () => {
    const d = newDeal();
    await t.svc.runtime.deliver(
      envelope(TransactionEvents.TransactionStateChanged, {
        transactionId: d.transactionId,
        needId: null,
        sourceType: 'LISTING',
        sourceId: d.sourceId,
        buyerId: d.buyerId,
        sellerId: d.sellerId,
        from: 'DELIVERY_PENDING',
        to: 'DISPUTED',
        actorId: d.buyerId,
      }),
    );
    const [row] = await casesFor(d.transactionId);
    expect(row).toMatchObject({ reason: 'OTHER', description: null, mode: null });
  });
});

describe('when the transaction leaves DISPUTED', () => {
  it('records how a resolved case was applied', async () => {
    const c = await opened();
    expect(
      (await resolve(c.id, randomUUID(), { resolution: 'RELEASE', note: 'Seller proved delivery' }))
        .statusCode,
    ).toBe(200);
    await t.svc.runtime.deliver(
      changedEvent(c, { from: 'DISPUTED', to: 'COMPLETED', actorId: null }),
    );
    const [row] = await casesFor(c.transactionId);
    expect(row).toMatchObject({ status: 'RESOLVED', final_transaction_state: 'COMPLETED' });
    expect(row!.applied_at).toBeInstanceOf(Date);
  });

  it('closes an undecided case as WITHDRAWN with a system note', async () => {
    const c = await opened();
    await t.svc.runtime.deliver(
      changedEvent(c, { from: 'DISPUTED', to: 'CANCELLED', actorId: null }),
    );
    const [row] = await casesFor(c.transactionId);
    expect(row).toMatchObject({
      status: 'WITHDRAWN',
      final_transaction_state: 'CANCELLED',
      withdrawn_by: null,
    });
    expect(await eventsOf(c.id, 'dispute.DisputeWithdrawn')).toEqual([]);
    const [changed] = await eventsOf(c.id, 'dispute.DisputeStatusChanged');
    expect(changed).toMatchObject({ from: 'AWAITING_RESPONSE', to: 'WITHDRAWN', actorId: null });

    const timeline = (await get(`/api/v1/disputes/${c.id}`, c.buyerId)).json().data.timeline;
    expect(timeline.at(-1)).toMatchObject({
      kind: 'STATUS_CHANGE',
      authorRole: 'SYSTEM',
      toStatus: 'WITHDRAWN',
    });
    expect(timeline.at(-1).text).toMatch(/without a decision/);

    // The deal can be disputed again later: a new case opens.
    await t.svc.runtime.deliver(changedEvent(c, { from: 'DELIVERED', to: 'DISPUTED' }));
    expect(await casesFor(c.transactionId)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- statement & deadline

describe('respondent statement', () => {
  it('moves the case to review once; only the respondent may submit', async () => {
    const c = await opened();
    const url = `/api/v1/disputes/${c.id}/statement`;
    const text = 'I shipped exactly what was in the listing photos.';

    expect((await post(url, c.buyerId, { text })).statusCode).toBe(403);

    const res = await post(url, c.sellerId, { text });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'UNDER_REVIEW', statementSubmitted: true });
    expect(res.json().data.actions).not.toContain('statement');
    const [changed] = await eventsOf(c.id, 'dispute.DisputeStatusChanged');
    expect(DisputeEvents.DisputeStatusChanged.schema.parse(changed)).toMatchObject({
      from: 'AWAITING_RESPONSE',
      to: 'UNDER_REVIEW',
      actorId: c.sellerId,
    });

    const again = await post(url, c.sellerId, { text });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.rule).toBe('STATEMENT_ALREADY_SUBMITTED');
  });

  it('rejects contact details in the statement', async () => {
    const c = await opened();
    const res = await post(`/api/v1/disputes/${c.id}/statement`, c.sellerId, {
      text: 'Please call me on 01712-345678 to sort this out',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toMatchObject({ rule: 'NO_CONTACT_INFO', field: 'statement' });
  });
});

describe('respondent deadline job', () => {
  it('moves overdue cases to review, flags the missed deadline, still accepts a late statement', async () => {
    const c = await opened();
    const fresh = await opened();
    await db()
      .updateTable('disputes')
      .set({ respond_by: sql<Date>`now() - interval '1 minute'` })
      .where('id', '=', c.id)
      .execute();

    expect(await runJob('respondentDeadline')).toBeGreaterThanOrEqual(1);
    const [row] = await casesFor(c.transactionId);
    expect(row).toMatchObject({ status: 'UNDER_REVIEW', respondent_missed_deadline: true });
    expect((await casesFor(fresh.transactionId))[0]!.status).toBe('AWAITING_RESPONSE');
    const [changed] = await eventsOf(c.id, 'dispute.DisputeStatusChanged');
    expect(changed).toMatchObject({ from: 'AWAITING_RESPONSE', to: 'UNDER_REVIEW', actorId: null });

    // Idempotent: nothing left to do for this case.
    await runJob('respondentDeadline');
    expect(await eventsOf(c.id, 'dispute.DisputeStatusChanged')).toHaveLength(1);

    const late = await post(`/api/v1/disputes/${c.id}/statement`, c.sellerId, {
      text: 'Sorry for the delay, here is what happened.',
    });
    expect(late.statusCode).toBe(200);
    expect(late.json().data).toMatchObject({
      status: 'UNDER_REVIEW',
      respondentMissedDeadline: true,
    });
  });
});

// ---------------------------------------------------------------- evidence

describe('evidence', () => {
  it('lets both parties and staff add evidence, shown in the timeline', async () => {
    const c = await opened();
    const url = `/api/v1/disputes/${c.id}/evidence`;
    const media = [randomUUID(), randomUUID()];
    expect(
      (await post(url, c.buyerId, { text: 'Screen is cracked', mediaIds: [...media, media[0]] }))
        .statusCode,
    ).toBe(200);
    expect(grants.at(-1)).toEqual({
      ownerId: c.buyerId,
      mediaIds: media,
      accountIds: [c.sellerId],
      purpose: 'DISPUTE',
    });
    expect((await post(url, c.sellerId, { mediaIds: [randomUUID()] })).statusCode).toBe(200);
    expect(
      (await post(url, randomUUID(), { text: 'Courier report attached' }, { roles: SUPPORT }))
        .statusCode,
    ).toBe(200);

    const tl = (await get(`/api/v1/disputes/${c.id}`, c.sellerId)).json().data.timeline;
    const ev = tl.filter((e: { kind: string }) => e.kind === 'EVIDENCE');
    expect(ev.map((e: { authorRole: string }) => e.authorRole)).toEqual([
      'BUYER',
      'SELLER',
      'STAFF',
    ]);
    expect(ev[0].mediaIds).toEqual(media);
    expect(ev[2].authorId).toBeNull(); // parties never see which staff member
  });

  it('rejects contact info, empty bodies and too many files', async () => {
    const c = await opened();
    const url = `/api/v1/disputes/${c.id}/evidence`;
    const contact = await post(url, c.buyerId, { text: 'email me at rahim@example.com' });
    expect(contact.statusCode).toBe(422);
    expect(contact.json().error.details).toMatchObject({
      rule: 'NO_CONTACT_INFO',
      field: 'evidence',
    });
    expect((await post(url, c.buyerId, {})).statusCode).toBe(400);
    expect(
      (await post(url, c.buyerId, { mediaIds: Array.from({ length: 11 }, () => randomUUID()) }))
        .statusCode,
    ).toBe(400);
    expect((await post(url, c.buyerId, { text: 'x'.repeat(2001) })).statusCode).toBe(400);
  });

  it('is immutable: no edit routes, and the table refuses updates and deletes', async () => {
    const c = await opened();
    const res = await post(`/api/v1/disputes/${c.id}/evidence`, c.buyerId, {
      text: 'Original text',
    });
    const entry = res.json().data.timeline.find((e: { kind: string }) => e.kind === 'EVIDENCE');

    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const r = await app().inject({
        method,
        url: `/api/v1/disputes/${c.id}/evidence/${entry.id}`,
        headers: await t.auth.as(c.buyerId),
        payload: { text: 'Edited' },
      });
      expect(r.statusCode).toBe(404);
    }
    await expect(
      db()
        .updateTable('dispute_entries')
        .set({ text: 'Edited' })
        .where('id', '=', entry.id)
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db().deleteFrom('dispute_entries').where('id', '=', entry.id).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('is closed once the case is decided', async () => {
    const c = await opened();
    await resolve(c.id, randomUUID(), { resolution: 'CANCEL', note: 'Item never shipped' });
    const res = await post(`/api/v1/disputes/${c.id}/evidence`, c.buyerId, { text: 'More photos' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details.rule).toBe('CASE_CLOSED');
  });
});

// ---------------------------------------------------------------- staff

describe('staff case work', () => {
  it('keeps internal notes and assignment out of the parties’ view', async () => {
    const c = await opened();
    const staff = randomUUID();
    const note = await post(
      `/api/v1/admin/disputes/${c.id}/notes`,
      staff,
      { text: 'Seller has two prior disputes, check carefully' },
      { roles: SUPPORT },
    );
    expect(note.statusCode).toBe(200);
    expect(
      (
        await post(
          `/api/v1/admin/disputes/${c.id}/assign`,
          staff,
          { assigneeId: 'me' },
          { roles: SUPPORT },
        )
      ).statusCode,
    ).toBe(200);

    const staffView = (await get(`/api/v1/disputes/${c.id}`, staff, SUPPORT)).json().data;
    expect(staffView.viewerRole).toBe('STAFF');
    expect(staffView.staff).toMatchObject({ assignedTo: staff, escalated: false });
    expect(staffView.timeline.map((e: { kind: string }) => e.kind)).toEqual(
      expect.arrayContaining(['OPENED', 'NOTE', 'ASSIGNMENT']),
    );
    // SUPPORT can read but not decide.
    expect(staffView.actions).toEqual(['evidence', 'assign', 'note']);

    for (const party of [c.buyerId, c.sellerId]) {
      const res = await get(`/api/v1/disputes/${c.id}`, party);
      const body = res.json().data;
      expect(body.staff).toBeNull();
      expect(body.timeline.map((e: { kind: string }) => e.kind)).not.toContain('NOTE');
      expect(body.timeline.map((e: { kind: string }) => e.kind)).not.toContain('ASSIGNMENT');
      expect(res.body).not.toContain('prior disputes');
      expect(res.body).not.toContain(staff);
    }
  });

  it('shows info requests to the parties', async () => {
    const c = await opened();
    const res = await post(
      `/api/v1/admin/disputes/${c.id}/request-info`,
      randomUUID(),
      { party: 'SELLER', message: 'Please upload the courier receipt.' },
      { roles: ADMIN },
    );
    expect(res.statusCode).toBe(200);
    const tl = (await get(`/api/v1/disputes/${c.id}`, c.sellerId)).json().data.timeline;
    expect(tl.at(-1)).toMatchObject({
      kind: 'INFO_REQUEST',
      authorRole: 'STAFF',
      authorId: null,
      targetParty: 'SELLER',
      text: 'Please upload the courier receipt.',
    });
    expect(
      (
        await post(
          `/api/v1/admin/disputes/${c.id}/request-info`,
          randomUUID(),
          { party: 'BOTH', message: 'More?' },
          { roles: SUPPORT },
        )
      ).statusCode,
    ).toBe(403);
  });

  it('does not assign to a party, and staff cannot handle their own dispute', async () => {
    const c = await opened();
    const r = await post(
      `/api/v1/admin/disputes/${c.id}/assign`,
      randomUUID(),
      { assigneeId: c.buyerId },
      { roles: ADMIN },
    );
    expect(r.statusCode).toBe(422);
    expect(r.json().error.details.rule).toBe('ASSIGNEE_IS_PARTY');
    expect(
      (await resolve(c.id, c.sellerId, { resolution: 'RELEASE', note: 'my own case' })).statusCode,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------- decisions

describe('resolve', () => {
  it('resolves with RELEASE and emits a valid DisputeResolved', async () => {
    const c = await opened();
    const admin = randomUUID();
    const res = await resolve(c.id, admin, {
      resolution: 'RELEASE',
      note: 'Delivery photo matches the listing',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      status: 'RESOLVED',
      resolution: 'RELEASE',
      resolutionNote: 'Delivery photo matches the listing',
      actions: ['note'],
    });

    const [resolved] = await eventsOf(c.id, 'dispute.DisputeResolved');
    expect(DisputeEvents.DisputeResolved.schema.parse(resolved)).toEqual({
      disputeId: c.id,
      transactionId: c.transactionId,
      buyerId: c.buyerId,
      sellerId: c.sellerId,
      resolution: 'RELEASE',
      resolvedBy: admin,
      note: 'Delivery photo matches the listing',
    });
    const [changed] = await eventsOf(c.id, 'dispute.DisputeStatusChanged');
    expect(changed).toMatchObject({ from: 'AWAITING_RESPONSE', to: 'RESOLVED', actorId: admin });

    // The parties see the decision; nothing is left for them to do.
    const party = (await get(`/api/v1/disputes/${c.id}`, c.buyerId)).json().data;
    expect(party).toMatchObject({ status: 'RESOLVED', resolution: 'RELEASE', actions: [] });

    const again = await resolve(c.id, admin, { resolution: 'CANCEL', note: 'changed my mind' });
    expect(again.statusCode).toBe(409);
  });

  it('refuses REFUND for cash deals', async () => {
    const c = await opened();
    const res = await resolve(c.id, randomUUID(), {
      resolution: 'REFUND',
      note: 'Give the money back',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toMatchObject({
      rule: 'REFUND_NOT_SUPPORTED',
      provider: 'CASH',
    });
    expect((await casesFor(c.transactionId))[0]!.status).toBe('AWAITING_RESPONSE');
    expect(await eventsOf(c.id, 'dispute.DisputeResolved')).toEqual([]);
  });

  it('lets exactly one of two concurrent resolutions win', async () => {
    const c = await opened();
    const [a, b] = await Promise.all([
      resolve(c.id, randomUUID(), { resolution: 'RELEASE', note: 'Release it' }),
      resolve(c.id, randomUUID(), { resolution: 'CANCEL', note: 'Cancel it' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await eventsOf(c.id, 'dispute.DisputeResolved')).toHaveLength(1);
    expect(await eventsOf(c.id, 'dispute.DisputeStatusChanged')).toHaveLength(1);
  });
});

describe('withdraw', () => {
  it('lets the opener withdraw and emits DisputeWithdrawn with the previous state', async () => {
    const c = await opened(newDeal(), { from: 'DELIVERY_PENDING' });
    expect((await post(`/api/v1/disputes/${c.id}/withdraw`, c.sellerId)).statusCode).toBe(403);

    const res = await post(`/api/v1/disputes/${c.id}/withdraw`, c.buyerId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'WITHDRAWN', actions: [] });

    const [w] = await eventsOf(c.id, 'dispute.DisputeWithdrawn');
    expect(DisputeEvents.DisputeWithdrawn.schema.parse(w)).toEqual({
      disputeId: c.id,
      transactionId: c.transactionId,
      buyerId: c.buyerId,
      sellerId: c.sellerId,
      withdrawnBy: c.buyerId,
      previousState: 'DELIVERY_PENDING',
    });
    expect((await post(`/api/v1/disputes/${c.id}/withdraw`, c.buyerId)).statusCode).toBe(409);

    // transaction-service applies it: the deal goes back; the case records that.
    await t.svc.runtime.deliver(
      changedEvent(c, { from: 'DISPUTED', to: 'DELIVERED', actorId: null }),
    );
    const [row] = await casesFor(c.transactionId);
    expect(row).toMatchObject({
      status: 'WITHDRAWN',
      final_transaction_state: 'DELIVERED',
      withdrawn_by: c.buyerId,
    });
  });

  it('cannot withdraw a resolved case', async () => {
    const c = await opened();
    await resolve(c.id, randomUUID(), { resolution: 'RELEASE', note: 'Done here' });
    expect((await post(`/api/v1/disputes/${c.id}/withdraw`, c.buyerId)).statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------- authz, idempotency, lists

describe('authorization', () => {
  it('hides the case from everyone but the parties and staff', async () => {
    const c = await opened();
    const stranger = randomUUID();
    expect((await get(`/api/v1/disputes/${c.id}`, stranger)).statusCode).toBe(404);
    expect((await get(`/api/v1/disputes/${randomUUID()}`, c.buyerId)).statusCode).toBe(404);
    expect(
      (await post(`/api/v1/disputes/${c.id}/evidence`, stranger, { text: 'hi' })).statusCode,
    ).toBe(404);
    expect((await post(`/api/v1/disputes/${c.id}/withdraw`, stranger)).statusCode).toBe(404);
    expect((await get(`/api/v1/disputes/${c.id}`, randomUUID(), SUPPORT)).statusCode).toBe(200);
    expect((await app().inject({ url: `/api/v1/disputes/${c.id}` })).statusCode).toBe(401);
  });

  it('gates admin routes by permission; support cannot resolve', async () => {
    const c = await opened();
    expect((await get('/api/v1/admin/disputes', c.buyerId)).statusCode).toBe(403);
    expect(
      (await post(`/api/v1/admin/disputes/${c.id}/notes`, c.buyerId, { text: 'hello' })).statusCode,
    ).toBe(403);
    const support = await post(
      `/api/v1/admin/disputes/${c.id}/resolve`,
      randomUUID(),
      { resolution: 'RELEASE', note: 'I am support' },
      { roles: SUPPORT },
    );
    expect(support.statusCode).toBe(403);
    expect(
      (await resolve(randomUUID(), randomUUID(), { resolution: 'RELEASE', note: 'nothing' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('idempotency', () => {
  it('requires a key, replays the same response, and refuses a reused key', async () => {
    const c = await opened();
    const url = `/api/v1/disputes/${c.id}/evidence`;
    expect((await post(url, c.buyerId, { text: 'no key' }, { key: null })).statusCode).toBe(400);

    const key = randomUUID();
    const a = await post(url, c.buyerId, { text: 'Box was open' }, { key });
    const b = await post(url, c.buyerId, { text: 'Box was open' }, { key });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    const evidence = await db()
      .selectFrom('dispute_entries')
      .select('id')
      .where('dispute_id', '=', c.id)
      .where('kind', '=', 'EVIDENCE')
      .execute();
    expect(evidence).toHaveLength(1);

    const reused = await post(url, c.buyerId, { text: 'Different' }, { key });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays a resolution without a second event', async () => {
    const c = await opened();
    const admin = randomUUID();
    const key = randomUUID();
    const body = { resolution: 'CANCEL', note: 'Seller did not ship' };
    expect((await resolve(c.id, admin, body, key)).statusCode).toBe(200);
    const again = await resolve(c.id, admin, body, key);
    expect(again.statusCode).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await eventsOf(c.id, 'dispute.DisputeResolved')).toHaveLength(1);
  });

  it('audits commands', async () => {
    const c = await opened();
    await post(`/api/v1/disputes/${c.id}/withdraw`, c.buyerId);
    const actions = (
      await db().selectFrom('audit_log').select('action').where('target_id', '=', c.id).execute()
    ).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['dispute.opened', 'dispute.withdraw']));
  });
});

describe('lists and escalation', () => {
  it('lists my disputes as either party, newest first, with a cursor', async () => {
    const buyer = randomUUID();
    const first = await opened({ ...newDeal(), buyerId: buyer });
    const second = await opened({ ...newDeal(), sellerId: buyer });
    const third = await opened({ ...newDeal(), buyerId: buyer });

    const p1 = (await get('/api/v1/me/disputes?limit=2', buyer)).json();
    expect(p1.data.map((d: { id: string }) => d.id)).toEqual([third.id, second.id]);
    expect(p1.data[0]).not.toHaveProperty('assignedTo');
    const p2 = (
      await get(`/api/v1/me/disputes?limit=2&cursor=${p1.page.nextCursor}`, buyer)
    ).json();
    expect(p2.data.map((d: { id: string }) => d.id)).toEqual([first.id]);
    expect(p2.page.nextCursor).toBeNull();

    await post(`/api/v1/disputes/${first.id}/withdraw`, buyer);
    const withdrawn = (await get('/api/v1/me/disputes?status=WITHDRAWN', buyer)).json();
    expect(withdrawn.data.map((d: { id: string }) => d.id)).toEqual([first.id]);
    expect((await get('/api/v1/me/disputes?cursor=garbage', buyer)).statusCode).toBe(400);
  });

  it('serves the staff queue oldest first with assignee and escalation filters', async () => {
    const admin = randomUUID();
    const cases = [await opened(), await opened(), await opened()];
    for (const c of cases) {
      await post(
        `/api/v1/admin/disputes/${c.id}/assign`,
        admin,
        { assigneeId: 'me' },
        { roles: ADMIN },
      );
    }
    const p1 = (await get('/api/v1/admin/disputes?assignee=me&limit=2', admin, ADMIN)).json();
    expect(p1.data.map((d: { id: string }) => d.id)).toEqual([cases[0]!.id, cases[1]!.id]);
    expect(p1.data[0]).toMatchObject({ assignedTo: admin, escalated: false });
    const p2 = (
      await get(
        `/api/v1/admin/disputes?assignee=me&limit=2&cursor=${p1.page.nextCursor}`,
        admin,
        ADMIN,
      )
    ).json();
    expect(p2.data.map((d: { id: string }) => d.id)).toEqual([cases[2]!.id]);

    // Resolved cases leave the default (live) queue but are listed by status.
    await resolve(cases[0]!.id, admin, { resolution: 'RELEASE', note: 'ok then' });
    const live = (await get(`/api/v1/admin/disputes?assignee=${admin}`, admin, ADMIN)).json();
    expect(live.data.map((d: { id: string }) => d.id)).toEqual([cases[1]!.id, cases[2]!.id]);
    const resolved = (
      await get(`/api/v1/admin/disputes?assignee=${admin}&status=RESOLVED`, admin, ADMIN)
    ).json();
    expect(resolved.data.map((d: { id: string }) => d.id)).toEqual([cases[0]!.id]);
  });

  it('escalates cases left unassigned too long', async () => {
    const old = await opened();
    const recent = await opened();
    await db()
      .updateTable('disputes')
      .set({ opened_at: sql<Date>`now() - interval '25 hours'` })
      .where('id', '=', old.id)
      .execute();

    expect(await runJob('escalateUnassigned')).toBeGreaterThanOrEqual(1);
    const [row] = await casesFor(old.transactionId);
    expect(row!.escalated).toBe(true);
    expect((await casesFor(recent.transactionId))[0]!.escalated).toBe(false);

    const admin = randomUUID();
    const q = (
      await get('/api/v1/admin/disputes?escalated=true&assignee=none&limit=100', admin, ADMIN)
    ).json();
    const ids = q.data.map((d: { id: string }) => d.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(recent.id);

    const staffView = (await get(`/api/v1/disputes/${old.id}`, admin, ADMIN)).json().data;
    expect(staffView.timeline.at(-1)).toMatchObject({ kind: 'ESCALATION', authorRole: 'SYSTEM' });
    const partyView = (await get(`/api/v1/disputes/${old.id}`, old.buyerId)).json().data;
    expect(partyView.timeline.map((e: { kind: string }) => e.kind)).not.toContain('ESCALATION');
  });
});
