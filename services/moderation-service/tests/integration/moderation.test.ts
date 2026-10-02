import { randomUUID } from 'node:crypto';
import { ModerationEvents, type Role } from '@dorkar/contracts';
import { startTestService, type TestService } from '@dorkar/kernel/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildModerationService } from '../../src/app';

const REPORT_LIMIT = 5;

let t: TestService<Awaited<ReturnType<typeof buildModerationService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'moderation',
    migrations,
    env: { REPORTS_PER_REPORTER_PER_DAY: String(REPORT_LIMIT) },
    build: (env, logger, verifier) => buildModerationService(env, logger, { verifier }),
  });
});
afterAll(() => t.close());

type Target = 'LISTING' | 'NEED' | 'OFFER' | 'REVIEW' | 'USER';

const report = async (
  reporterId: string,
  body: { targetType: Target; targetId: string; reason: string; details?: string },
) =>
  app().inject({
    method: 'POST',
    url: '/api/v1/reports',
    headers: await t.auth.as(reporterId),
    payload: body,
  });

const mod = (id = randomUUID(), roles: Role[] = ['MODERATOR']) => ({ id, roles });

const getCase = async (caseId: string, m = mod()) =>
  app().inject({
    url: `/api/v1/admin/moderation/cases/${caseId}`,
    headers: await t.auth.as(m.id, m.roles),
  });

const act = async (caseId: string, action: string, reason: string, m = mod()) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/admin/moderation/cases/${caseId}/actions`,
    headers: await t.auth.as(m.id, m.roles),
    payload: { action, reason },
  });

/** Opens a case on a fresh listing and returns its ids. */
const openCase = async (targetType: Target = 'LISTING', reason = 'SCAM') => {
  const targetId = randomUUID();
  const res = await report(randomUUID(), { targetType, targetId, reason });
  expect(res.statusCode).toBe(201);
  return { targetId, caseId: res.json().data.caseId as string };
};

const outboxFor = async (targetId: string) =>
  (
    await db()
      .selectFrom('outbox')
      .select(['type', 'payload'])
      .where('aggregate_id', '=', targetId)
      .execute()
  ).map((r) => ({
    type: r.type,
    payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as unknown,
  }));

describe('reporting', () => {
  it('opens a case on the first report; a second reporter joins it and bumps priority', async () => {
    const targetId = randomUUID();
    const first = await report(randomUUID(), {
      targetType: 'LISTING',
      targetId,
      reason: 'SPAM',
      details: 'Same ad posted 30 times',
    });
    expect(first.statusCode).toBe(201);
    const { caseId, reportId } = first.json().data;
    expect(reportId).toEqual(expect.any(String));

    const before = (await getCase(caseId)).json().data;
    expect(before).toMatchObject({
      status: 'OPEN',
      targetType: 'LISTING',
      targetId,
      reportCount: 1,
      topReason: 'SPAM',
      targetHidden: false,
    });

    const second = await report(randomUUID(), { targetType: 'LISTING', targetId, reason: 'SCAM' });
    expect(second.statusCode).toBe(201);
    expect(second.json().data.caseId).toBe(caseId);

    const after = (await getCase(caseId)).json().data;
    expect(after.reportCount).toBe(2);
    expect(after.topReason).toBe('SCAM');
    expect(after.priority).toBeGreaterThan(before.priority);
    expect(after.reports).toHaveLength(2);
    expect(after.reports[0].reporterId).toEqual(expect.any(String));
  });

  it('rejects a duplicate open report by the same reporter (409)', async () => {
    const reporter = randomUUID();
    const body = { targetType: 'NEED' as const, targetId: randomUUID(), reason: 'FAKE' };
    expect((await report(reporter, body)).statusCode).toBe(201);
    const dup = await report(reporter, { ...body, reason: 'SPAM' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('CONFLICT');
  });

  it('forbids reporting yourself (422)', async () => {
    const me = randomUUID();
    const res = await report(me, { targetType: 'USER', targetId: me, reason: 'OTHER' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('CANNOT_REPORT_SELF');
  });

  it('validates input: unknown fields, bad reason, details over 1000 chars', async () => {
    const r = randomUUID();
    const base = { targetType: 'LISTING' as const, targetId: randomUUID(), reason: 'SPAM' };
    expect((await report(r, { ...base, reason: 'BORING' })).statusCode).toBe(400);
    expect((await report(r, { ...base, details: 'x'.repeat(1001) })).statusCode).toBe(400);
    const extra = await app().inject({
      method: 'POST',
      url: '/api/v1/reports',
      headers: await t.auth.as(r),
      payload: { ...base, caseId: randomUUID() },
    });
    expect(extra.statusCode).toBe(400);
    expect(
      (await app().inject({ method: 'POST', url: '/api/v1/reports', payload: base })).statusCode,
    ).toBe(401);
  });

  it('rate-limits reports per reporter per day (429 with retry-after)', async () => {
    const reporter = randomUUID();
    for (let i = 0; i < REPORT_LIMIT; i++) {
      const res = await report(reporter, {
        targetType: 'OFFER',
        targetId: randomUUID(),
        reason: 'SPAM',
      });
      expect(res.statusCode).toBe(201);
    }
    const res = await report(reporter, {
      targetType: 'OFFER',
      targetId: randomUUID(),
      reason: 'SPAM',
    });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // Others are unaffected.
    expect(
      (await report(randomUUID(), { targetType: 'OFFER', targetId: randomUUID(), reason: 'SPAM' }))
        .statusCode,
    ).toBe(201);
  });

  it('reporting a target after its case closed opens a new case', async () => {
    const { targetId, caseId } = await openCase('LISTING', 'SPAM');
    expect((await act(caseId, 'DISMISS', 'Not spam, just popular')).statusCode).toBe(200);
    const again = await report(randomUUID(), { targetType: 'LISTING', targetId, reason: 'SCAM' });
    expect(again.statusCode).toBe(201);
    const newCaseId = again.json().data.caseId;
    expect(newCaseId).not.toBe(caseId);
    expect((await getCase(newCaseId)).json().data).toMatchObject({
      status: 'OPEN',
      reportCount: 1,
    });
  });

  it('a reporter may report again once their previous report on the target was closed', async () => {
    const reporter = randomUUID();
    const targetId = randomUUID();
    const first = await report(reporter, { targetType: 'NEED', targetId, reason: 'SPAM' });
    await act(first.json().data.caseId, 'DISMISS', 'Looks fine');
    expect(
      (await report(reporter, { targetType: 'NEED', targetId, reason: 'SPAM' })).statusCode,
    ).toBe(201);
  });

  it('reports/mine shows only the caller’s reports, with status, paginated', async () => {
    const me = randomUUID();
    const someoneElse = randomUUID();
    const targets = [randomUUID(), randomUUID(), randomUUID()];
    for (const targetId of targets) {
      await report(me, { targetType: 'LISTING', targetId, reason: 'SPAM' });
    }
    await report(someoneElse, { targetType: 'LISTING', targetId: targets[0]!, reason: 'SCAM' });

    const headers = await t.auth.as(me);
    const p1 = await app().inject({ url: '/api/v1/reports/mine?limit=2', headers });
    expect(p1.statusCode).toBe(200);
    const body1 = p1.json();
    expect(body1.data).toHaveLength(2);
    expect(body1.page.nextCursor).toEqual(expect.any(String));
    const p2 = await app().inject({
      url: `/api/v1/reports/mine?limit=2&cursor=${body1.page.nextCursor}`,
      headers,
    });
    const body2 = p2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.page.nextCursor).toBeNull();

    const all = [...body1.data, ...body2.data];
    expect(all.map((r: { targetId: string }) => r.targetId).sort()).toEqual([...targets].sort());
    expect(all.every((r: { status: string; reason: string }) => r.status === 'OPEN')).toBe(true);
    expect(JSON.stringify(all)).not.toContain(someoneElse);
    expect(all[0]).not.toHaveProperty('reporterId');
  });
});

describe('moderator queue', () => {
  it('members and support cannot read cases (403); anonymous 401', async () => {
    const { caseId } = await openCase();
    const member = await t.auth.as(randomUUID());
    expect(
      (await app().inject({ url: '/api/v1/admin/moderation/cases', headers: member })).statusCode,
    ).toBe(403);
    expect(
      (await app().inject({ url: `/api/v1/admin/moderation/cases/${caseId}`, headers: member }))
        .statusCode,
    ).toBe(403);
    expect(
      (await act(caseId, 'HIDE', 'scam listing', mod(randomUUID(), ['MEMBER']))).statusCode,
    ).toBe(403);
    expect(
      (await act(caseId, 'HIDE', 'scam listing', mod(randomUUID(), ['SUPPORT']))).statusCode,
    ).toBe(403);
    expect((await app().inject({ url: '/api/v1/admin/moderation/cases' })).statusCode).toBe(401);
  });

  it('orders by priority desc, then oldest, with keyset pagination', async () => {
    // REVIEW targets are used only in this test, so the filter isolates its cases.
    const a = await openCase('REVIEW', 'SPAM');
    const b = await openCase('REVIEW', 'SCAM');
    const c = await openCase('REVIEW', 'SPAM');

    const m = mod();
    const headers = await t.auth.as(m.id, m.roles);
    const url = '/api/v1/admin/moderation/cases?status=OPEN&targetType=REVIEW&limit=2';
    const p1 = await app().inject({ url, headers });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().data.map((x: { id: string }) => x.id)).toEqual([b.caseId, a.caseId]);
    const cursor = p1.json().page.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const p2 = await app().inject({ url: `${url}&cursor=${cursor}`, headers });
    expect(p2.json().data.map((x: { id: string }) => x.id)).toEqual([c.caseId]);
    expect(p2.json().page.nextCursor).toBeNull();

    expect((await app().inject({ url: `${url}&cursor=garbage`, headers })).statusCode).toBe(400);

    const audit = await db()
      .selectFrom('audit_log')
      .select(['actor_type'])
      .where('action', '=', 'moderation.cases.listed')
      .where('actor_id', '=', m.id)
      .execute();
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.every((r) => r.actor_type === 'ADMIN')).toBe(true);
  });

  it('assigns the case to the caller and records it', async () => {
    const { caseId } = await openCase();
    const m = mod();
    const res = await app().inject({
      method: 'POST',
      url: `/api/v1/admin/moderation/cases/${caseId}/assign`,
      headers: await t.auth.as(m.id, m.roles),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.assignedTo).toBe(m.id);
    const detail = (await getCase(caseId)).json().data;
    expect(detail.actions).toEqual([
      expect.objectContaining({ action: 'ASSIGN', moderatorId: m.id }),
    ]);
  });

  it('404s unknown cases', async () => {
    expect((await getCase(randomUUID())).statusCode).toBe(404);
  });
});

describe('moderator decisions', () => {
  it('HIDE emits ContentModerated, resolves reports, and audits as ADMIN', async () => {
    const { caseId, targetId } = await openCase('LISTING', 'PROHIBITED_ITEM');
    const m = mod();
    const res = await act(caseId, 'HIDE', 'Selling prohibited medicine', m);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'ACTIONED', targetHidden: true });
    expect(res.json().data.closedAt).toEqual(expect.any(String));

    const events = await outboxFor(targetId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe(ModerationEvents.ContentModerated.type);
    expect(ModerationEvents.ContentModerated.schema.parse(events[0]!.payload)).toEqual({
      caseId,
      targetType: 'LISTING',
      targetId,
      action: 'HIDE',
      reason: 'Selling prohibited medicine',
      moderatorId: m.id,
    });

    const audit = await db()
      .selectFrom('audit_log')
      .selectAll()
      .where('target_id', '=', caseId)
      .where('action', '=', 'moderation.case.hide')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_type: 'ADMIN', actor_id: m.id });
    expect(JSON.stringify(audit.metadata)).not.toContain('medicine');

    const detail = (await getCase(caseId)).json().data;
    expect(detail.reports.every((r: { status: string }) => r.status === 'RESOLVED')).toBe(true);
    expect(detail.actions.at(-1)).toMatchObject({ action: 'HIDE', moderatorId: m.id });
  });

  it('RESTORE un-hides a hidden target and emits ContentModerated RESTORE', async () => {
    const { caseId, targetId } = await openCase('NEED', 'OFFENSIVE');
    expect((await act(caseId, 'HIDE', 'Offensive wording')).statusCode).toBe(200);
    const res = await act(caseId, 'RESTORE', 'Wording edited after appeal');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'ACTIONED', targetHidden: false });

    const actions = (await outboxFor(targetId)).map(
      (e) => ModerationEvents.ContentModerated.schema.parse(e.payload).action,
    );
    expect(actions).toEqual(['HIDE', 'RESTORE']);
    expect((await act(caseId, 'RESTORE', 'again please')).statusCode).toBe(409);
  });

  it('DISMISS closes the case and its reports without an event', async () => {
    const { caseId, targetId } = await openCase('OFFER', 'SPAM');
    const res = await act(caseId, 'DISMISS', 'Legitimate offer');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DISMISSED');
    expect(await outboxFor(targetId)).toEqual([]);
    const detail = (await getCase(caseId)).json().data;
    expect(detail.reports.every((r: { status: string }) => r.status === 'DISMISSED')).toBe(true);
    expect((await act(caseId, 'HIDE', 'changed my mind')).statusCode).toBe(409);
  });

  it('requires a reason', async () => {
    const { caseId } = await openCase();
    const m = mod();
    const res = await app().inject({
      method: 'POST',
      url: `/api/v1/admin/moderation/cases/${caseId}/actions`,
      headers: await t.auth.as(m.id, m.roles),
      payload: { action: 'HIDE' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('USER targets: HIDE/RESTORE → 422 USE_ACCOUNT_ADMIN, DISMISS works', async () => {
    const { caseId, targetId } = await openCase('USER', 'HARASSMENT');
    const hide = await act(caseId, 'HIDE', 'Harassing buyers');
    expect(hide.statusCode).toBe(422);
    expect(hide.json().error.details.rule).toBe('USE_ACCOUNT_ADMIN');
    expect((await act(caseId, 'RESTORE', 'n/a reason')).statusCode).toBe(422);
    expect((await act(caseId, 'DISMISS', 'No evidence')).statusCode).toBe(200);
    expect(await outboxFor(targetId)).toEqual([]);
  });

  it('a moderator cannot act on a case about themselves (403)', async () => {
    const m = mod();
    const res = await report(randomUUID(), {
      targetType: 'USER',
      targetId: m.id,
      reason: 'HARASSMENT',
    });
    const caseId = res.json().data.caseId;
    expect((await act(caseId, 'DISMISS', 'Nothing to see', m)).statusCode).toBe(403);
    const assign = await app().inject({
      method: 'POST',
      url: `/api/v1/admin/moderation/cases/${caseId}/assign`,
      headers: await t.auth.as(m.id, m.roles),
    });
    expect(assign.statusCode).toBe(403);
    // Another moderator can.
    expect((await act(caseId, 'DISMISS', 'Reviewed by a peer')).statusCode).toBe(200);
  });

  it('concurrent HIDE and DISMISS: exactly one wins, the other gets 409', async () => {
    const { caseId, targetId } = await openCase('LISTING', 'SCAM');
    const [h, d] = await Promise.all([
      act(caseId, 'HIDE', 'Scam confirmed'),
      act(caseId, 'DISMISS', 'Looks legit'),
    ]);
    expect([h.statusCode, d.statusCode].sort()).toEqual([200, 409]);

    const detail = (await getCase(caseId)).json().data;
    const decisions = detail.actions.filter((a: { action: string }) => a.action !== 'ASSIGN');
    expect(decisions).toHaveLength(1);
    const events = await outboxFor(targetId);
    if (h.statusCode === 200) {
      expect(detail.status).toBe('ACTIONED');
      expect(events).toHaveLength(1);
    } else {
      expect(detail.status).toBe('DISMISSED');
      expect(events).toHaveLength(0);
    }
  });

  it('concurrent reports on a new target land in one case with an exact count', async () => {
    const targetId = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        report(randomUUID(), { targetType: 'LISTING', targetId, reason: 'SPAM' }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);
    const caseIds = new Set(results.map((r) => r.json().data.caseId));
    expect(caseIds.size).toBe(1);
    expect((await getCase([...caseIds][0])).json().data.reportCount).toBe(5);
  });
});
