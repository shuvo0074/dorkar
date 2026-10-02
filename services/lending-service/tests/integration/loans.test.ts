import { randomUUID } from 'node:crypto';
import {
  LendingEvents,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
  type TransactionState,
} from '@dorkar/contracts';
import { envelope } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { helpers, startLending, verification, type Lending } from './harness';

let t: Lending;
const h = helpers(() => t);

beforeAll(async () => {
  t = await startLending('lending_loans');
});
afterAll(() => t.close());
beforeEach(() => {
  verification.mode = 'ok';
  verification.calls = [];
});

// ---------------------------------------------------------------- helpers

/** A REQUESTED loan on a fresh item. */
async function requested(itemOver: Record<string, unknown> = {}, w = h.window()) {
  const item = await h.item(itemOver);
  const borrower = randomUUID();
  const res = await h.request(item.id, borrower, w);
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().data.id as string, item, lender: item.lender, borrower };
}

const cmd = (loanId: string, command: string, actorId: string, payload?: unknown, key?: string) =>
  h.post(`/api/v1/loans/${loanId}/${command}`, actorId, payload, key ? { key } : {});

async function approved() {
  const loan = await requested();
  expect((await cmd(loan.id, 'approve', loan.lender)).statusCode).toBe(200);
  return loan;
}

const loanRow = (id: string) =>
  h.db().selectFrom('loans').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

const statusChanges = async (loanId: string) =>
  (await h.outbox(loanId, LendingEvents.LoanStatusChanged.type)).map((e) =>
    LendingEvents.LoanStatusChanged.schema.parse(e.payload),
  );

const txEvent = (
  loan: { id: string; lender: string; borrower: string },
  transactionId: string,
  from: TransactionState,
  to: TransactionState,
  sourceType: 'LOAN' | 'OFFER' = 'LOAN',
) =>
  envelope(
    TransactionEvents.TransactionStateChanged,
    {
      transactionId,
      needId: null,
      sourceType,
      sourceId: loan.id,
      buyerId: loan.borrower,
      sellerId: loan.lender,
      from,
      to,
      actorId: null,
      mode: 'BORROW',
    },
    transactionId as ReturnType<typeof randomUUID>,
  );

const txCreated = (loan: { id: string; lender: string; borrower: string }, transactionId: string) =>
  envelope(
    TransactionEvents.TransactionCreated,
    {
      transactionId,
      sourceType: 'LOAN',
      sourceId: loan.id,
      needId: null,
      listingId: null,
      buyerId: loan.borrower,
      sellerId: loan.lender,
      amount: { amount: 0, currency: 'BDT' },
      quantity: 1,
      mode: 'BORROW',
    },
    transactionId as ReturnType<typeof randomUUID>,
  );

const runJob = (job: 'expireRequests' | 'notifyOverdue') =>
  h
    .db()
    .transaction()
    .execute((trx) => t.svc.jobs[job](trx));

// ---------------------------------------------------------------- requesting

describe('requesting a loan', () => {
  it('creates a REQUESTED loan, history and LoanRequested', async () => {
    const item = await h.item();
    const borrower = randomUUID();
    const w = h.window(2, 5);
    const res = await h.request(item.id, borrower, w, { message: 'For a weekend project' });
    expect(res.statusCode).toBe(201);
    const loan = res.json().data;
    expect(loan).toMatchObject({
      itemId: item.id,
      itemTitle: 'Bosch cordless drill',
      lenderId: item.lender,
      borrowerId: borrower,
      startAt: w.startAt,
      returnBy: w.returnBy,
      message: 'For a weekend project',
      deposit: { amount: 50_000, currency: 'BDT' },
      status: 'REQUESTED',
      transactionId: null,
      overdue: false,
      viewerRole: 'BORROWER',
      actions: ['cancel'],
    });
    expect(loan.transitions).toMatchObject([
      { from: null, to: 'REQUESTED', actorRole: 'BORROWER' },
    ]);
    const [ev] = await h.outbox(loan.id, LendingEvents.LoanRequested.type);
    expect(LendingEvents.LoanRequested.schema.parse(ev!.payload)).toEqual({
      loanId: loan.id,
      itemId: item.id,
      lenderId: item.lender,
      borrowerId: borrower,
      startAt: w.startAt,
      returnBy: w.returnBy,
    });
    expect(verification.calls.at(-1)).toEqual({
      accountId: borrower,
      action: 'LOAN_REQUEST',
      amount: 50_000,
    });
  });

  it('enforces the request rules', async () => {
    const item = await h.item({ maxLoanDays: 5 });
    const rule = async (res: Awaited<ReturnType<typeof h.request>>) => {
      expect(res.statusCode, res.body).toBe(422);
      return res.json().error.details.rule as string;
    };
    expect(await rule(await h.request(item.id, item.lender))).toBe('OWN_ITEM');
    expect(await rule(await h.request(item.id, randomUUID(), h.window(1, 6)))).toBe(
      'LOAN_TOO_LONG',
    );
    expect(await rule(await h.request(item.id, randomUUID(), h.window(-0.1, 2)))).toBe(
      'LOAN_START_IN_PAST',
    );
    const w = h.window();
    expect(
      await rule(
        await h.request(item.id, randomUUID(), { startAt: w.returnBy, returnBy: w.startAt }),
      ),
    ).toBe('INVALID_LOAN_PERIOD');
    expect(
      await rule(
        await h.request(item.id, randomUUID(), h.window(), { message: 'call 01712345678' }),
      ),
    ).toBe('NO_CONTACT_INFO');

    await h.post(`/api/v1/lend-items/${item.id}/deactivate`, item.lender);
    expect(await rule(await h.request(item.id, randomUUID()))).toBe('ITEM_NOT_AVAILABLE');
    expect((await h.request(randomUUID(), randomUUID())).statusCode).toBe(404);
  });

  it('allows one open request per item and borrower', async () => {
    const loan = await requested();
    const dup = await h.request(loan.item.id, loan.borrower, h.window(5, 2));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.details.rule).toBe('LOAN_ALREADY_REQUESTED');
    // Once the first is cancelled the borrower may ask again.
    expect((await cmd(loan.id, 'cancel', loan.borrower)).statusCode).toBe(200);
    expect((await h.request(loan.item.id, loan.borrower, h.window(5, 2))).statusCode).toBe(201);
  });

  it('fails closed on the LOAN_REQUEST policy', async () => {
    const item = await h.item();
    verification.mode = 'deny';
    const denied = await h.request(item.id, randomUUID());
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('VERIFICATION_REQUIRED');
    verification.mode = 'down';
    expect((await h.request(item.id, randomUUID())).statusCode).toBe(503);
    const n = await h
      .db()
      .selectFrom('loans')
      .select('id')
      .where('item_id', '=', item.id)
      .execute();
    expect(n).toHaveLength(0);
  });

  it('is idempotent: Idempotency-Key required, retries replay', async () => {
    const item = await h.item();
    const borrower = randomUUID();
    const body = { itemId: item.id, ...h.window() };
    expect((await h.post('/api/v1/loans', borrower, body, { key: null })).statusCode).toBe(400);
    const key = randomUUID();
    const a = await h.post('/api/v1/loans', borrower, body, { key });
    const b = await h.post('/api/v1/loans', borrower, body, { key });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json()).toEqual(a.json());
    expect(await h.outbox(a.json().data.id, LendingEvents.LoanRequested.type)).toHaveLength(1);

    // Commands too.
    const loanId = a.json().data.id as string;
    const k2 = randomUUID();
    const c1 = await cmd(loanId, 'approve', item.lender, undefined, k2);
    const c2 = await cmd(loanId, 'approve', item.lender, undefined, k2);
    expect(c1.statusCode).toBe(200);
    expect(c2.headers['idempotent-replayed']).toBe('true');
    expect(c2.json()).toEqual(c1.json());
    expect(await h.outbox(loanId, LendingEvents.LoanApproved.type)).toHaveLength(1);
    expect(
      (await h.post(`/api/v1/loans/${loanId}/approve`, item.lender, undefined, { key: null }))
        .statusCode,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------- trust gate

describe('trust gate', () => {
  it('is driven by the borrower’s NID, completed deals and rating projections', async () => {
    const item = await h.item({
      requirements: { nidVerified: true, minCompletedDeals: 2, minRating: 4 },
    });
    const borrower = randomUUID();
    const failed = async () => {
      const res = await h.request(item.id, borrower);
      if (res.statusCode === 201) return 'ok';
      expect(res.statusCode).toBe(422);
      const details = res.json().error.details;
      expect(details.rule).toBe('BORROWER_NOT_ELIGIBLE');
      expect(Object.keys(details).sort()).toEqual(['failed', 'rule']);
      return details.failed as string[];
    };
    const reputation = (
      completedCount: number,
      ratingAverage: number | null,
      ratingCount: number,
    ) =>
      t.svc.runtime.deliver(
        envelope(ReputationEvents.ReputationUpdated, {
          accountId: borrower,
          completedCount,
          ratingAverage,
          ratingCount,
          cancelledCount: 0,
          disputedCount: 0,
        }),
      );
    const nid = (status: 'VERIFIED' | 'REVOKED') =>
      t.svc.runtime.deliver(
        envelope(VerificationEvents.VerificationStatusChanged, {
          accountId: borrower,
          kind: 'NID',
          status,
        }),
      );

    expect(await failed()).toEqual(['nidVerified', 'minCompletedDeals', 'minRating']);
    await nid('VERIFIED');
    expect(await failed()).toEqual(['minCompletedDeals', 'minRating']);
    await reputation(3, 3.5, 4);
    expect(await failed()).toEqual(['minRating']);
    // Other verification kinds do not count as NID.
    await t.svc.runtime.deliver(
      envelope(VerificationEvents.VerificationStatusChanged, {
        accountId: borrower,
        kind: 'PHONE',
        status: 'REVOKED',
      }),
    );
    await nid('REVOKED');
    await reputation(3, 4.2, 5);
    expect(await failed()).toEqual(['nidVerified']);
    await nid('VERIFIED');
    expect(await failed()).toBe('ok');
  });

  it('shows the item’s requirements, never the lender’s or borrower’s private data', async () => {
    const item = await h.item({ requirements: { nidVerified: true, minCompletedDeals: 0 } });
    const res = await h.request(item.id, randomUUID());
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toEqual({
      rule: 'BORROWER_NOT_ELIGIBLE',
      failed: ['nidVerified'],
    });
  });
});

// ---------------------------------------------------------------- decisions

describe('approve, decline, cancel', () => {
  it('approves: LoanApproved carries the deal facts for the transaction service', async () => {
    const loan = await requested();
    const view = await h.getAs(`/api/v1/loans/${loan.id}`, loan.lender);
    expect(view.json().data).toMatchObject({
      viewerRole: 'LENDER',
      actions: ['approve', 'decline'],
    });

    const res = await cmd(loan.id, 'approve', loan.lender);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ status: 'APPROVED', actions: [], version: 1 });
    const [ev] = await h.outbox(loan.id, LendingEvents.LoanApproved.type);
    expect(LendingEvents.LoanApproved.schema.parse(ev!.payload)).toEqual({
      loanId: loan.id,
      itemId: loan.item.id,
      lenderId: loan.lender,
      borrowerId: loan.borrower,
      startAt: data.startAt,
      returnBy: data.returnBy,
      deposit: { amount: 50_000, currency: 'BDT' },
      terms: { itemTitle: 'Bosch cordless drill', categoryId: loan.item.categoryId },
    });
    expect(await statusChanges(loan.id)).toEqual([
      {
        loanId: loan.id,
        itemId: loan.item.id,
        lenderId: loan.lender,
        borrowerId: loan.borrower,
        from: 'REQUESTED',
        to: 'APPROVED',
        transactionId: null,
        reason: 'approve',
      },
    ]);
    const audit = await h
      .db()
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', loan.id)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['lending.loan.requested', 'lending.loan.approve']);

    const again = await cmd(loan.id, 'approve', loan.lender);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('declines with a reason the borrower can read', async () => {
    const loan = await requested();
    expect((await cmd(loan.id, 'decline', loan.lender, {})).statusCode).toBe(400);
    expect(
      (await cmd(loan.id, 'decline', loan.lender, { reason: 'call me on 01712345678' })).statusCode,
    ).toBe(422);
    const res = await cmd(loan.id, 'decline', loan.lender, { reason: 'I need it that week' });
    expect(res.statusCode).toBe(200);
    const view = await h.getAs(`/api/v1/loans/${loan.id}`, loan.borrower);
    expect(view.json().data).toMatchObject({
      status: 'DECLINED',
      declineReason: 'I need it that week',
      actions: [],
    });
    // Free text never travels in events.
    expect((await statusChanges(loan.id)).map((e) => e.reason)).toEqual(['decline']);
  });

  it('lets the borrower cancel while REQUESTED only', async () => {
    const loan = await requested();
    expect((await cmd(loan.id, 'cancel', loan.borrower)).statusCode).toBe(200);
    expect((await cmd(loan.id, 'cancel', loan.borrower)).statusCode).toBe(409);

    const a = await approved();
    const late = await cmd(a.id, 'cancel', a.borrower);
    expect(late.statusCode).toBe(409);
  });

  it('enforces who may do what: wrong party 403, strangers 404', async () => {
    const loan = await requested();
    expect((await cmd(loan.id, 'approve', loan.borrower)).statusCode).toBe(403);
    expect((await cmd(loan.id, 'cancel', loan.lender)).statusCode).toBe(403);
    const stranger = randomUUID();
    expect((await cmd(loan.id, 'approve', stranger)).statusCode).toBe(404);
    expect((await h.getAs(`/api/v1/loans/${loan.id}`, stranger)).statusCode).toBe(404);
    expect((await h.getAs(`/api/v1/loans/${randomUUID()}`, stranger)).statusCode).toBe(404);
    expect((await h.app().inject({ url: `/api/v1/loans/${loan.id}` })).statusCode).toBe(401);

    const support = await h.getAs(`/api/v1/loans/${loan.id}`, stranger, ['SUPPORT']);
    expect(support.statusCode).toBe(200);
    expect(support.json().data).toMatchObject({ viewerRole: null, actions: [] });
    // Reading is not acting.
    expect(
      (
        await h.post(`/api/v1/loans/${loan.id}/approve`, stranger, undefined, {
          roles: ['SUPPORT'],
        })
      ).statusCode,
    ).toBe(404);
  });

  it('refuses to approve once the item is off the shelf', async () => {
    const loan = await requested();
    await h.post(`/api/v1/lend-items/${loan.item.id}/deactivate`, loan.lender);
    const view = await h.getAs(`/api/v1/loans/${loan.id}`, loan.lender);
    expect(view.json().data.actions).toEqual(['decline']);
    const res = await cmd(loan.id, 'approve', loan.lender);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('ITEM_NOT_AVAILABLE');
  });
});

// ---------------------------------------------------------------- overlap

describe('calendar exclusivity', () => {
  it('approves exactly one of two overlapping requests approved in parallel', async () => {
    const item = await h.item();
    const [b1, b2] = [randomUUID(), randomUUID()];
    const r1 = await h.request(item.id, b1, h.window(1, 4));
    const r2 = await h.request(item.id, b2, h.window(3, 4));
    const [l1, l2] = [r1.json().data.id as string, r2.json().data.id as string];

    const results = await Promise.all([
      cmd(l1, 'approve', item.lender),
      cmd(l2, 'approve', item.lender),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const conflict = results.find((r) => r.statusCode === 409)!;
    expect(conflict.json().error).toMatchObject({
      code: 'CONFLICT',
      details: { rule: 'LOAN_CONFLICT' },
    });
    const rows = await h
      .db()
      .selectFrom('loans')
      .select('status')
      .where('item_id', '=', item.id)
      .execute();
    expect(rows.map((r) => r.status).sort()).toEqual(['APPROVED', 'REQUESTED']);
    expect(
      await h
        .db()
        .selectFrom('outbox')
        .select('id')
        .where('type', '=', LendingEvents.LoanApproved.type)
        .where('aggregate_id', 'in', [l1, l2])
        .execute(),
    ).toHaveLength(1);
  });

  it('allows back-to-back and non-overlapping periods', async () => {
    const item = await h.item();
    const start = Date.now() + h.DAY;
    const iso = (ms: number) => new Date(ms).toISOString();
    const a = await h.request(item.id, randomUUID(), {
      startAt: iso(start),
      returnBy: iso(start + 2 * h.DAY),
    });
    const b = await h.request(item.id, randomUUID(), {
      startAt: iso(start + 2 * h.DAY),
      returnBy: iso(start + 4 * h.DAY),
    });
    expect((await cmd(a.json().data.id, 'approve', item.lender)).statusCode).toBe(200);
    expect((await cmd(b.json().data.id, 'approve', item.lender)).statusCode).toBe(200);
  });

  it('frees the period when the transaction is cancelled', async () => {
    const loan = await approved();
    const w = await loanRow(loan.id);
    const other = await h.request(loan.item.id, randomUUID(), {
      startAt: w.start_at.toISOString(),
      returnBy: w.return_by.toISOString(),
    });
    const otherId = other.json().data.id as string;
    expect((await cmd(otherId, 'approve', loan.lender)).statusCode).toBe(409);

    const txId = randomUUID();
    await t.svc.runtime.deliver(txEvent(loan, txId, 'CREATED', 'CANCELLED'));
    expect((await loanRow(loan.id)).status).toBe('CANCELLED');
    expect((await cmd(otherId, 'approve', loan.lender)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- expiry

describe('request TTL', () => {
  it('expires unanswered requests once', async () => {
    const fresh = await requested();
    const stale = await requested();
    await h
      .db()
      .updateTable('loans')
      .set({ created_at: sql<Date>`created_at - interval '49 hours'` })
      .where('id', '=', stale.id)
      .execute();

    expect(await runJob('expireRequests')).toBeGreaterThanOrEqual(1);
    expect((await loanRow(stale.id)).status).toBe('EXPIRED');
    expect((await loanRow(fresh.id)).status).toBe('REQUESTED');
    expect(await statusChanges(stale.id)).toMatchObject([
      { from: 'REQUESTED', to: 'EXPIRED', reason: 'expire' },
    ]);
    const view = await h.getAs(`/api/v1/loans/${stale.id}`, stale.borrower);
    expect(view.json().data.transitions.at(-1)).toMatchObject({
      from: 'REQUESTED',
      to: 'EXPIRED',
      actorRole: 'SYSTEM',
      actorId: null,
    });

    await runJob('expireRequests');
    expect(await statusChanges(stale.id)).toHaveLength(1);
    expect((await cmd(stale.id, 'approve', stale.lender)).statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------- transaction mirror

describe('transaction mirror', () => {
  it('follows the BORROW transaction through hand-over, return and completion', async () => {
    const loan = await approved();
    const txId = randomUUID();
    expect(await t.svc.runtime.deliver(txCreated(loan, txId))).toBe(true);
    expect((await loanRow(loan.id)).transaction_id).toBe(txId);

    const steps: Array<[TransactionState, TransactionState, string]> = [
      ['CREATED', 'CONFIRMED', 'APPROVED'],
      ['CONFIRMED', 'HANDED_OVER', 'LENT'],
      ['HANDED_OVER', 'RETURN_REPORTED', 'RETURN_REPORTED'],
      ['RETURN_REPORTED', 'RETURNED', 'RETURNED'],
      ['RETURNED', 'COMPLETED', 'CLOSED'],
    ];
    for (const [from, to, expected] of steps) {
      await t.svc.runtime.deliver(txEvent(loan, txId, from, to));
      expect((await loanRow(loan.id)).status, `${from}→${to}`).toBe(expected);
    }
    const row = await loanRow(loan.id);
    expect(row.returned_at).not.toBeNull();

    expect(
      (await statusChanges(loan.id)).map((e) => [e.from, e.to, e.transactionId, e.reason]),
    ).toEqual([
      ['REQUESTED', 'APPROVED', null, 'approve'],
      ['APPROVED', 'LENT', txId, 'transaction:HANDED_OVER'],
      ['LENT', 'RETURN_REPORTED', txId, 'transaction:RETURN_REPORTED'],
      ['RETURN_REPORTED', 'RETURNED', txId, 'transaction:RETURNED'],
      ['RETURNED', 'CLOSED', txId, 'transaction:COMPLETED'],
    ]);
    const view = await h.getAs(`/api/v1/loans/${loan.id}`, loan.borrower);
    expect(view.json().data).toMatchObject({ status: 'CLOSED', transactionId: txId });
    expect(view.json().data.transitions).toHaveLength(6);

    // The lender's record now shows one completed, on-time loan.
    const item = await h.app().inject({ url: `/api/v1/lend-items/${loan.item.id}` });
    expect(item.json().data.lenderStats).toEqual({ completedLoans: 1, onTimeReturnRate: 1 });
  });

  it('mirrors disputes, and ignores redelivery and other sources', async () => {
    const loan = await approved();
    const txId = randomUUID();
    const handed = txEvent(loan, txId, 'CONFIRMED', 'HANDED_OVER');
    expect(await t.svc.runtime.deliver(handed)).toBe(true);
    expect(await t.svc.runtime.deliver(handed)).toBe(false);
    expect((await loanRow(loan.id)).transaction_id).toBe(txId); // learnt from the state change

    await t.svc.runtime.deliver(txEvent(loan, txId, 'HANDED_OVER', 'DELIVERED'));
    expect((await loanRow(loan.id)).status).toBe('LENT');
    await t.svc.runtime.deliver(txEvent(loan, randomUUID(), 'CREATED', 'CANCELLED', 'OFFER'));
    expect((await loanRow(loan.id)).status).toBe('LENT');

    await t.svc.runtime.deliver(txEvent(loan, txId, 'HANDED_OVER', 'DISPUTED'));
    expect((await loanRow(loan.id)).status).toBe('DISPUTED');
    // Dispute withdrawn: back to where the transaction was.
    await t.svc.runtime.deliver(txEvent(loan, txId, 'DISPUTED', 'HANDED_OVER'));
    expect((await loanRow(loan.id)).status).toBe('LENT');
    await t.svc.runtime.deliver(txEvent(loan, txId, 'HANDED_OVER', 'DISPUTED'));
    await t.svc.runtime.deliver(txEvent(loan, txId, 'DISPUTED', 'CANCELLED'));
    expect((await loanRow(loan.id)).status).toBe('CANCELLED');
    // Terminal: later events do not resurrect it.
    await t.svc.runtime.deliver(txEvent(loan, txId, 'CANCELLED', 'COMPLETED'));
    expect((await loanRow(loan.id)).status).toBe('CANCELLED');

    const transitions = await h
      .db()
      .selectFrom('loan_transitions')
      .select('to_status')
      .where('loan_id', '=', loan.id)
      .orderBy('at')
      .orderBy('id')
      .execute();
    expect(transitions.map((r) => r.to_status)).toEqual([
      'REQUESTED',
      'APPROVED',
      'LENT',
      'DISPUTED',
      'LENT',
      'DISPUTED',
      'CANCELLED',
    ]);
  });

  it('does not touch loans that never reached agreement', async () => {
    const loan = await requested();
    await t.svc.runtime.deliver(txEvent(loan, randomUUID(), 'CONFIRMED', 'HANDED_OVER'));
    expect((await loanRow(loan.id)).status).toBe('REQUESTED');
  });

  it('keeps history append-only', async () => {
    const loan = await requested();
    await expect(
      h.db().deleteFrom('loan_transitions').where('loan_id', '=', loan.id).execute(),
    ).rejects.toThrow(/append-only/);
  });
});

// ---------------------------------------------------------------- overdue

describe('overdue', () => {
  it('emits LoanOverdue once for a lent item past its return date', async () => {
    const loan = await approved();
    const txId = randomUUID();
    await t.svc.runtime.deliver(txEvent(loan, txId, 'CONFIRMED', 'HANDED_OVER'));
    await h
      .db()
      .updateTable('loans')
      .set({
        start_at: sql<Date>`now() - interval '5 days'`,
        return_by: sql<Date>`now() - interval '1 hour'`,
      })
      .where('id', '=', loan.id)
      .execute();
    // Not yet due, or not lent: no event.
    const pending = await requested();

    expect(await runJob('notifyOverdue')).toBeGreaterThanOrEqual(1);
    expect(await runJob('notifyOverdue')).toBe(0);
    const events = await h.outbox(loan.id, LendingEvents.LoanOverdue.type);
    expect(events).toHaveLength(1);
    const row = await loanRow(loan.id);
    expect(LendingEvents.LoanOverdue.schema.parse(events[0]!.payload)).toEqual({
      loanId: loan.id,
      itemId: loan.item.id,
      lenderId: loan.lender,
      borrowerId: loan.borrower,
      transactionId: txId,
      returnBy: row.return_by.toISOString(),
    });
    expect(await h.outbox(pending.id, LendingEvents.LoanOverdue.type)).toHaveLength(0);
    expect((await h.getAs(`/api/v1/loans/${loan.id}`, loan.lender)).json().data.overdue).toBe(true);

    // Still overdue after the borrower reports the return: no second event.
    await t.svc.runtime.deliver(txEvent(loan, txId, 'HANDED_OVER', 'RETURN_REPORTED'));
    await runJob('notifyOverdue');
    expect(await h.outbox(loan.id, LendingEvents.LoanOverdue.type)).toHaveLength(1);

    // Returned late: the lender's on-time rate reflects it.
    await t.svc.runtime.deliver(txEvent(loan, txId, 'RETURN_REPORTED', 'RETURNED'));
    const item = await h.app().inject({ url: `/api/v1/lend-items/${loan.item.id}` });
    expect(item.json().data.lenderStats).toEqual({ completedLoans: 1, onTimeReturnRate: 0 });
  });
});

// ---------------------------------------------------------------- lists

describe('lists', () => {
  it('lists my loans by role and status, newest first, with cursors', async () => {
    const lender = randomUUID();
    const item = await h.item({}, lender);
    const borrowers = [randomUUID(), randomUUID(), randomUUID()];
    const ids: string[] = [];
    for (const [i, b] of borrowers.entries()) {
      const r = await h.request(item.id, b, h.window(1 + i * 10, 2));
      ids.push(r.json().data.id);
    }
    await cmd(ids[0]!, 'approve', lender);

    const list = async (actor: string, qs = '', roles?: Parameters<typeof h.getAs>[2]) =>
      h.getAs(`/api/v1/me/loans${qs}`, actor, roles);

    expect(
      (await list(lender, '?role=lender')).json().data.map((l: { id: string }) => l.id),
    ).toEqual([...ids].reverse());
    expect((await list(lender, '?role=borrower')).json().data).toEqual([]);
    expect(
      (await list(lender, '?status=APPROVED')).json().data.map((l: { id: string }) => l.id),
    ).toEqual([ids[0]]);
    expect((await list(borrowers[1]!)).json().data.map((l: { id: string }) => l.id)).toEqual([
      ids[1],
    ]);

    const p1 = await list(lender, '?role=lender&limit=2');
    expect(p1.json().data).toHaveLength(2);
    const p2 = await list(lender, `?role=lender&limit=2&cursor=${p1.json().page.nextCursor}`);
    expect(p2.json().data.map((l: { id: string }) => l.id)).toEqual([ids[0]]);
    expect((await list(lender, '?role=friend')).statusCode).toBe(400);
  });

  it('lets support list all loans; members cannot', async () => {
    const loan = await approved();
    const admin = randomUUID();
    expect((await h.getAs('/api/v1/admin/loans', admin)).statusCode).toBe(403);
    const res = await h.getAs('/api/v1/admin/loans?status=APPROVED&limit=100', admin, ['SUPPORT']);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((l: { id: string }) => l.id)).toContain(loan.id);
    expect(res.json().data.every((l: { status: string }) => l.status === 'APPROVED')).toBe(true);
  });
});
