import { randomUUID } from 'node:crypto';
import { IdentityEvents } from '@dorkar/contracts';
import {
  envelope,
  startTestService,
  TEST_INTERNAL_TOKEN,
  type TestService,
} from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_ID } from '../../migrations/0001_verification';
import { migrations } from '../../migrations';
import { buildVerificationService } from '../../src/app';
import { pgVerificationStore } from '../../src/infrastructure/pg-verification-store';

let t: TestService<Awaited<ReturnType<typeof buildVerificationService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'verification',
    migrations,
    build: (env, logger, verifier) => buildVerificationService(env, logger, { verifier }),
  });
});
afterAll(() => t.close());

// Every test gets its own NID so duplicate checks never collide across tests.
let nidSeq = 0;
const freshNid = () => `98${String(Date.now()).slice(-7)}${String(++nidSeq).padStart(4, '0')}`; // 13 digits
const person = (nidNumber = freshNid()) => ({
  nidNumber,
  dateOfBirth: '1991-03-14',
  fullName: 'Karim Hossain',
});

const submit = async (accountId: string, body: Record<string, unknown>) =>
  app().inject({
    method: 'POST',
    url: '/api/v1/me/verifications/nid',
    headers: await t.auth.as(accountId),
    payload: body,
  });

const superAdmin = () => t.auth.as(randomUUID(), ['SUPER_ADMIN']);

const recordOf = (accountId: string, kind: 'PHONE' | 'NID' | 'BUSINESS' = 'NID') =>
  db()
    .selectFrom('verifications')
    .selectAll()
    .where('account_id', '=', accountId)
    .where('kind', '=', kind)
    .executeTakeFirstOrThrow();

const decide = async (
  id: string,
  decision: 'VERIFIED' | 'REJECTED',
  headers?: Record<string, string>,
) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/admin/verifications/${id}/decision`,
    headers: headers ?? (await superAdmin()),
    payload: { decision, note: decision === 'VERIFIED' ? 'Matched EC record' : 'Photo unreadable' },
  });

const events = async (accountId: string) =>
  db()
    .selectFrom('outbox')
    .select(['type', 'payload'])
    .where('aggregate_id', '=', accountId)
    .orderBy('occurred_at')
    .orderBy('id')
    .execute();

const statuses = async (accountId: string) =>
  (await events(accountId)).map((e) => {
    const p = e.payload as { kind: string; status: string };
    return `${p.kind}:${p.status}`;
  });

describe('phone verification from sign-up', () => {
  it('marks the phone VERIFIED on AccountCreated and publishes the change once', async () => {
    const id = randomUUID();
    const e = envelope(IdentityEvents.AccountCreated, { accountId: id });
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false);
    // A replay with a new event id must not duplicate the record or the event.
    await t.svc.runtime.deliver(envelope(IdentityEvents.AccountCreated, { accountId: id }));

    const res = await app().inject({
      url: '/api/v1/me/verifications',
      headers: await t.auth.as(id),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { kind: 'PHONE', status: 'VERIFIED', verifiedAt: expect.any(String), nidLast4: null },
    ]);
    const out = await events(id);
    expect(out).toEqual([
      {
        type: 'verification.VerificationStatusChanged',
        payload: { accountId: id, kind: 'PHONE', status: 'VERIFIED' },
      },
    ]);
    const history = await db()
      .selectFrom('verification_history')
      .selectAll()
      .where('verification_id', '=', (await recordOf(id, 'PHONE')).id)
      .execute();
    expect(history).toMatchObject([{ from_status: null, to_status: 'VERIFIED', actor_id: null }]);
  });

  it('requires authentication', async () => {
    expect((await app().inject({ url: '/api/v1/me/verifications' })).statusCode).toBe(401);
  });
});

describe('NID submission', () => {
  it('accepts a valid submission as PENDING, keeps only last4, publishes and audits', async () => {
    const id = randomUUID();
    const nid = freshNid();
    const res = await submit(id, person(nid));
    expect(res.statusCode).toBe(202);
    expect(res.json().data).toEqual({ kind: 'NID', status: 'PENDING' });

    const row = await recordOf(id);
    expect(row).toMatchObject({
      status: 'PENDING',
      provider: 'manual',
      nid_last4: nid.slice(-4),
      verified_at: null,
    });
    expect(row.nid_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await statuses(id)).toEqual(['NID:PENDING']);

    const audit = await db()
      .selectFrom('audit_log')
      .selectAll()
      .where('target_id', '=', row.id)
      .execute();
    expect(audit).toMatchObject([
      {
        action: 'verification.nid.submitted',
        actor_id: id,
        metadata: { kind: 'NID', status: 'PENDING', provider: 'manual' },
      },
    ]);

    const mine = await app().inject({
      url: '/api/v1/me/verifications',
      headers: await t.auth.as(id),
    });
    expect(mine.json().data).toEqual([
      { kind: 'NID', status: 'PENDING', verifiedAt: null, nidLast4: nid.slice(-4) },
    ]);
  });

  it('normalizes Bengali digits and separators before hashing', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const nid = '1357924680';
    const bengali = '১৩৫৭ ৯২৪-৬৮০';
    expect((await submit(a, person(nid))).statusCode).toBe(202);
    expect((await submit(b, person(bengali))).statusCode).toBe(202);
    const [ra, rb] = [await recordOf(a), await recordOf(b)];
    expect(rb.nid_last4).toBe('4680');
    expect(rb.nid_fingerprint).toBe(ra.nid_fingerprint);
  });

  it.each([
    [{ nidNumber: '12345' }, 400, 'nidNumber'],
    [{ nidNumber: '123456789012' }, 400, 'nidNumber'],
    [{ nidNumber: 'ABCDEFGHIJ' }, 400, 'nidNumber'],
    [{ dateOfBirth: '14/03/1991' }, 400, 'dateOfBirth'],
    [{ dateOfBirth: '1991-02-30' }, 400, 'dateOfBirth'],
    [{ fullName: 'K' }, 400, 'fullName'],
    [{ fullName: 'y'.repeat(81) }, 400, 'fullName'],
  ])('rejects %o', async (patch, status, field) => {
    const id = randomUUID();
    const res = await submit(id, { ...person(), ...patch });
    expect(res.statusCode).toBe(status);
    expect(res.json().error.details).toEqual({ field });
    for (const v of Object.values(patch)) expect(res.body).not.toContain(v);
    expect(
      await db().selectFrom('verifications').where('account_id', '=', id).select('id').execute(),
    ).toEqual([]);
  });

  it('rejects minors and unknown fields', async () => {
    const minor = await submit(randomUUID(), { ...person(), dateOfBirth: '2010-01-01' });
    expect(minor.statusCode).toBe(422);
    expect(minor.json().error.details.rule).toBe('UNDERAGE');
    const extra = await submit(randomUUID(), { ...person(), fatherName: 'X' });
    expect(extra.statusCode).toBe(400);
  });

  it('allows resubmission only when nothing is pending or verified', async () => {
    const id = randomUUID();
    expect((await submit(id, person())).statusCode).toBe(202);

    const again = await submit(id, person());
    expect(again.statusCode).toBe(422);
    expect(again.json().error.details.rule).toBe('NID_PENDING');

    const first = await recordOf(id);
    expect((await decide(first.id, 'REJECTED')).statusCode).toBe(200);

    const nid = freshNid();
    const retry = await submit(id, person(nid));
    expect(retry.statusCode).toBe(202);
    const second = await recordOf(id);
    expect(second).toMatchObject({
      id: first.id,
      status: 'PENDING',
      nid_last4: nid.slice(-4),
      reviewed_by: null,
      review_note: null,
    });

    expect((await decide(second.id, 'VERIFIED')).statusCode).toBe(200);
    const done = await submit(id, person());
    expect(done.statusCode).toBe(422);
    expect(done.json().error.details.rule).toBe('NID_ALREADY_VERIFIED');

    expect(await statuses(id)).toEqual([
      'NID:PENDING',
      'NID:REJECTED',
      'NID:PENDING',
      'NID:VERIFIED',
    ]);
    const history = await db()
      .selectFrom('verification_history')
      .select(['from_status', 'to_status'])
      .where('verification_id', '=', first.id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    expect(history.map((h) => `${h.from_status}→${h.to_status}`)).toEqual([
      'null→PENDING',
      'PENDING→REJECTED',
      'REJECTED→PENDING',
      'PENDING→VERIFIED',
    ]);
  });

  it('lets only one of two concurrent submissions through', async () => {
    const id = randomUUID();
    const results = await Promise.all([submit(id, person()), submit(id, person())]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 422]);
    expect(results.find((r) => r.statusCode === 422)!.json().error.details.rule).toBe(
      'NID_PENDING',
    );
    expect(await statuses(id)).toEqual(['NID:PENDING']);
  });

  it('refuses an NID already verified on another account', async () => {
    const owner = randomUUID();
    const nid = freshNid();
    await submit(owner, person(nid));
    await decide((await recordOf(owner)).id, 'VERIFIED');

    const other = randomUUID();
    const res = await submit(other, person(nid));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('NID_ALREADY_USED');
    expect(res.body).not.toContain(nid);
  });

  it('refuses to verify a second account with an NID verified meanwhile', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const nid = freshNid();
    await submit(a, person(nid));
    await submit(b, person(nid));
    expect((await decide((await recordOf(a)).id, 'VERIFIED')).statusCode).toBe(200);
    const res = await decide((await recordOf(b)).id, 'VERIFIED');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('NID_ALREADY_USED');
    expect((await recordOf(b)).status).toBe('PENDING');
  });

  it('rate-limits submissions per account', async () => {
    const id = randomUUID();
    for (let i = 0; i < 5; i++) {
      expect((await submit(id, { ...person(), nidNumber: '1' })).statusCode).toBe(400);
    }
    const res = await submit(id, person());
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('admin review', () => {
  it('requires verification:nid:decide for the queue and decisions', async () => {
    const id = randomUUID();
    await submit(id, person());
    const v = await recordOf(id);
    for (const roles of [['MEMBER'], ['MODERATOR'], ['SUPPORT']] as const) {
      const headers = await t.auth.as(randomUUID(), [...roles]);
      expect((await app().inject({ url: '/api/v1/admin/verifications', headers })).statusCode).toBe(
        403,
      );
      expect((await decide(v.id, 'VERIFIED', headers)).statusCode).toBe(403);
    }
    expect((await app().inject({ url: '/api/v1/admin/verifications' })).statusCode).toBe(401);
    expect((await recordOf(id)).status).toBe('PENDING');
  });

  it('decides once, records reviewer and note, publishes and audits', async () => {
    const id = randomUUID();
    await submit(id, person());
    const v = await recordOf(id);
    const reviewer = randomUUID();
    const headers = await t.auth.as(reviewer, ['SUPER_ADMIN']);

    const res = await decide(v.id, 'VERIFIED', headers);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      id: v.id,
      accountId: id,
      kind: 'NID',
      status: 'VERIFIED',
      reviewedBy: reviewer,
      reviewNote: 'Matched EC record',
      verifiedAt: expect.any(String),
    });
    expect(res.json().data).not.toHaveProperty('nidFingerprint');
    expect(await statuses(id)).toEqual(['NID:PENDING', 'NID:VERIFIED']);

    const audit = await db()
      .selectFrom('audit_log')
      .selectAll()
      .where('target_id', '=', v.id)
      .where('action', '=', 'verification.decided')
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      actor_id: reviewer,
      actor_type: 'ADMIN',
      metadata: { kind: 'NID', from: 'PENDING', to: 'VERIFIED' },
    });

    const twice = await decide(v.id, 'REJECTED', headers);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('forbids reviewing your own verification, 404s unknown ids, validates the body', async () => {
    const admin = randomUUID();
    await submit(admin, person());
    const own = await recordOf(admin);
    const headers = await t.auth.as(admin, ['SUPER_ADMIN']);
    expect((await decide(own.id, 'VERIFIED', headers)).statusCode).toBe(403);
    expect((await decide(randomUUID(), 'VERIFIED')).statusCode).toBe(404);
    const noNote = await app().inject({
      method: 'POST',
      url: `/api/v1/admin/verifications/${own.id}/decision`,
      headers: await superAdmin(),
      payload: { decision: 'REVOKED', note: '' },
    });
    expect(noNote.statusCode).toBe(400);
  });

  it('pages the pending queue oldest first with a keyset cursor', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await submit(id, person());
    const headers = await superAdmin();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/admin/verifications?status=PENDING&kind=NID&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await app().inject({ url, headers });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: Array<{ accountId: string; status: string }>;
        page: { nextCursor: string | null };
      }>();
      expect(body.data.length).toBeLessThanOrEqual(2);
      for (const d of body.data) {
        expect(d.status).toBe('PENDING');
        seen.push(d.accountId);
      }
      cursor = body.page.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    expect(new Set(seen).size).toBe(seen.length);
    const positions = ids.map((id) => seen.indexOf(id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);

    const bad = await app().inject({ url: '/api/v1/admin/verifications?cursor=nope', headers });
    expect(bad.statusCode).toBe(400);
  });
});

describe('retention', () => {
  it('clears fingerprints of NID records rejected more than 30 days ago', async () => {
    const [old, recent] = [randomUUID(), randomUUID()];
    for (const id of [old, recent]) {
      await submit(id, person());
      await decide((await recordOf(id)).id, 'REJECTED');
    }
    await db()
      .updateTable('verifications')
      .set({ updated_at: sql<Date>`now() - interval '31 days'` })
      .where('account_id', '=', old)
      .execute();

    const purged = await t.svc.verifications.purgeRejectedFingerprints(pgVerificationStore(db()));
    expect(purged).toBeGreaterThanOrEqual(1);
    expect((await recordOf(old)).nid_fingerprint).toBeNull();
    expect((await recordOf(old)).nid_last4).not.toBeNull();
    expect((await recordOf(recent)).nid_fingerprint).not.toBeNull();
  });
});

describe('verification policies', () => {
  const evaluateUrl = (q: Record<string, string>) =>
    `/internal/v1/verification/evaluate?${new URLSearchParams(q).toString()}`;
  const evaluate = async (q: Record<string, string>) => {
    const res = await app().inject({
      url: evaluateUrl(q),
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data as { satisfied: boolean; required: string[]; missing: string[] };
  };

  it('lists the seeded default to policy:read, hides it from members', async () => {
    const member = await app().inject({
      url: '/api/v1/admin/verification-policies',
      headers: await t.auth.as(randomUUID()),
    });
    expect(member.statusCode).toBe(403);
    const res = await app().inject({
      url: '/api/v1/admin/verification-policies?limit=100',
      headers: await t.auth.as(randomUUID(), ['ADMIN']),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: DEFAULT_POLICY_ID,
          action: 'ANY',
          scope: 'GLOBAL',
          requirement: 'NONE',
          kinds: [],
          active: true,
        }),
      ]),
    );
  });

  it('creates, evaluates, updates and deactivates a CATEGORY-required NID policy', async () => {
    const category = randomUUID();
    const seller = randomUUID();
    const editor = randomUUID();
    const headers = await t.auth.as(editor, ['SUPER_ADMIN']);
    const q = { accountId: seller, action: 'LISTING_PUBLISH', categoryId: category };

    // Default: nothing required.
    expect(await evaluate(q)).toMatchObject({ satisfied: true, required: [], missing: [] });

    // ADMIN may read but not write.
    const body = {
      name: 'NID for high-risk category',
      action: 'LISTING_PUBLISH',
      scope: 'CATEGORY',
      selector: { categoryId: category },
      requirement: 'REQUIRED',
      kinds: ['NID'],
      priority: 10,
    };
    const forbidden = await app().inject({
      method: 'POST',
      url: '/api/v1/admin/verification-policies',
      headers: await t.auth.as(randomUUID(), ['ADMIN']),
      payload: body,
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app().inject({
      method: 'POST',
      url: '/api/v1/admin/verification-policies',
      headers,
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const policy = created.json().data;
    expect(policy).toMatchObject({ ...body, active: true, version: 1, updatedBy: editor });

    expect(await evaluate(q)).toEqual({
      satisfied: false,
      required: ['NID'],
      missing: ['NID'],
      policyId: policy.id,
    });
    // Other categories and other actions are untouched.
    expect((await evaluate({ ...q, categoryId: randomUUID() })).satisfied).toBe(true);
    expect((await evaluate({ ...q, action: 'NEED_PUBLISH' })).satisfied).toBe(true);

    // Once the seller's NID is verified, the policy is satisfied.
    await submit(seller, person());
    await decide((await recordOf(seller)).id, 'VERIFIED');
    expect(await evaluate(q)).toMatchObject({ satisfied: true, missing: [] });
    const newcomer = { ...q, accountId: randomUUID() };
    expect((await evaluate(newcomer)).satisfied).toBe(false);

    // Optimistic concurrency on edits.
    const stale = await app().inject({
      method: 'PATCH',
      url: `/api/v1/admin/verification-policies/${policy.id}`,
      headers,
      payload: { requirement: 'OPTIONAL', version: 0 },
    });
    expect(stale.statusCode).toBe(409);
    const patched = await app().inject({
      method: 'PATCH',
      url: `/api/v1/admin/verification-policies/${policy.id}`,
      headers,
      payload: { requirement: 'OPTIONAL', version: 1 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data).toMatchObject({ requirement: 'OPTIONAL', version: 2 });
    expect((await evaluate(newcomer)).satisfied).toBe(true);

    // Back to REQUIRED, then deactivate.
    await app().inject({
      method: 'PATCH',
      url: `/api/v1/admin/verification-policies/${policy.id}`,
      headers,
      payload: { requirement: 'REQUIRED' },
    });
    expect((await evaluate(newcomer)).satisfied).toBe(false);
    const off = await app().inject({
      method: 'POST',
      url: `/api/v1/admin/verification-policies/${policy.id}/deactivate`,
      headers,
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().data).toMatchObject({ active: false, version: 4 });
    expect((await evaluate(newcomer)).satisfied).toBe(true);

    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'metadata', 'actor_id'])
      .where('target_id', '=', policy.id)
      .orderBy('occurred_at')
      .orderBy('id')
      .execute();
    expect(audit.map((a) => a.action)).toEqual([
      'verification.policy.created',
      'verification.policy.updated',
      'verification.policy.updated',
      'verification.policy.deactivated',
    ]);
    expect(audit[1]!.metadata).toMatchObject({
      before: { requirement: 'REQUIRED', version: 1 },
      after: { requirement: 'OPTIONAL', version: 2 },
    });
    expect(audit.every((a) => a.actor_id === editor)).toBe(true);
  });

  it('evaluates value thresholds and role policies through the endpoint', async () => {
    const headers = await superAdmin();
    for (const payload of [
      {
        name: 'NID for big transactions',
        action: 'TRANSACTION_CREATE',
        scope: 'VALUE_THRESHOLD',
        selector: { minAmount: 5_000_000 },
        requirement: 'REQUIRED',
        kinds: ['NID'],
      },
      {
        name: 'Business verification for bulk offers',
        action: 'OFFER_SUBMIT',
        scope: 'ROLE',
        selector: { role: 'BUSINESS' },
        requirement: 'REQUIRED',
        kinds: ['BUSINESS'],
      },
    ]) {
      const res = await app().inject({
        method: 'POST',
        url: '/api/v1/admin/verification-policies',
        headers,
        payload,
      });
      expect(res.statusCode).toBe(201);
    }
    const accountId = randomUUID();
    const tx = { accountId, action: 'TRANSACTION_CREATE' };
    expect((await evaluate({ ...tx, amount: '4999999' })).satisfied).toBe(true);
    expect((await evaluate({ ...tx, amount: '5000000' })).missing).toEqual(['NID']);
    expect((await evaluate(tx)).satisfied).toBe(true);
    const offer = { accountId, action: 'OFFER_SUBMIT' };
    expect((await evaluate({ ...offer, roles: 'MEMBER,BUSINESS' })).missing).toEqual(['BUSINESS']);
    expect((await evaluate({ ...offer, roles: 'MEMBER' })).satisfied).toBe(true);
  });

  it('validates policies', async () => {
    const headers = await superAdmin();
    const post = (payload: Record<string, unknown>) =>
      app().inject({
        method: 'POST',
        url: '/api/v1/admin/verification-policies',
        headers,
        payload,
      });
    const base = {
      name: 'Test',
      action: 'ANY',
      scope: 'CATEGORY',
      selector: { categoryId: randomUUID() },
      requirement: 'REQUIRED',
      kinds: ['NID'],
    };
    expect((await post({ ...base, selector: { categoryId: 'phones' } })).statusCode).toBe(400);
    expect((await post({ ...base, selector: { mode: 'BUY' } })).statusCode).toBe(400);
    expect((await post({ ...base, kinds: [] })).statusCode).toBe(400);
    expect((await post({ ...base, kinds: ['DNA'] })).statusCode).toBe(400);
    expect((await post({ ...base, unknown: 1 })).statusCode).toBe(400);
    // Changing scope requires a selector valid for the new scope.
    const created = await post(base);
    const res = await app().inject({
      method: 'PATCH',
      url: `/api/v1/admin/verification-policies/${created.json().data.id}`,
      headers,
      payload: { scope: 'MODE' },
    });
    expect(res.statusCode).toBe(400);
    expect(
      (
        await app().inject({
          method: 'PATCH',
          url: `/api/v1/admin/verification-policies/${randomUUID()}`,
          headers,
          payload: { priority: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('serves evaluate to internal callers only', async () => {
    const url = evaluateUrl({ accountId: randomUUID(), action: 'LISTING_PUBLISH' });
    expect((await app().inject({ url })).statusCode).toBe(403);
    expect(
      (
        await app().inject({
          url: evaluateUrl({ accountId: randomUUID(), action: 'ANY' }),
          headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('privacy', () => {
  it('never stores, audits, publishes or logs the raw NID, name or date of birth', async () => {
    const id = randomUUID();
    const body = {
      nidNumber: '৭৩৫১৯০৮৬৪২১৯৭', // 13 Bengali digits
      dateOfBirth: '1979-11-23',
      fullName: 'Shahnaz Parveen Chowdhury',
    };
    const normalized = '7351908642197';
    expect((await submit(id, body)).statusCode).toBe(202);
    await decide((await recordOf(id)).id, 'REJECTED');
    // A rejected duplicate attempt and a validation failure also must not leak.
    await submit(randomUUID(), { ...body, dateOfBirth: '1979-02-31' });

    const dump = JSON.stringify(
      await Promise.all([
        db().selectFrom('verifications').selectAll().execute(),
        db().selectFrom('verification_history').selectAll().execute(),
        db().selectFrom('audit_log').selectAll().execute(),
        db().selectFrom('outbox').selectAll().execute(),
      ]),
    );
    const logs = t.logLines.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      normalized,
      body.nidNumber,
      body.fullName,
      'Shahnaz',
      body.dateOfBirth,
      '1979-02-31',
    ]) {
      expect(dump, secret).not.toContain(secret);
      expect(logs, secret).not.toContain(secret);
    }
    expect((await recordOf(id)).nid_last4).toBe('2197');
  });
});
