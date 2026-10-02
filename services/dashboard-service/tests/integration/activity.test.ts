import { randomUUID } from 'node:crypto';
import { IdentityEvents, ProfileEvents } from '@dorkar/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgActivityStore } from '../../src/infrastructure/pg-activity-store';
import { activity, ev, letters, start, type T } from '../helpers';

let t: T;
const app = () => t.svc.runtime.app;
const deliver = (e: Parameters<T['svc']['runtime']['deliver']>[0]) => t.svc.runtime.deliver(e);

beforeAll(async () => {
  t = await start();
});
afterAll(() => t.close());

const admin = () => t.auth.as(randomUUID(), ['ADMIN']);
const get = async (url: string, headers?: Record<string, string>) =>
  app().inject({ url, headers: headers ?? (await admin()) });

describe('ingestion', () => {
  it('stores one row per audit id from several producers, deduplicating redeliveries', async () => {
    const actorId = randomUUID();
    const fromIdentity = activity({
      producer: 'identity',
      actorId,
      action: 'auth.login_succeeded',
      targetType: 'account',
      targetId: actorId,
    });
    const fromOffer = activity({ producer: 'offer', actorId, action: 'offer.submit' });
    const fromTx = activity({ producer: 'transaction', actorId, action: 'transaction.confirm' });

    for (const e of [fromIdentity, fromOffer, fromTx]) expect(await deliver(e)).toBe(true);
    // Same envelope again: the inbox skips it.
    expect(await deliver(fromOffer)).toBe(false);
    // A replay in a new envelope (same audit id): the primary key keeps one row.
    expect(await deliver({ ...fromOffer, id: randomUUID() })).toBe(true);

    const res = await get(`/api/v1/admin/activity?actorId=${actorId}`);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data;
    expect(rows).toHaveLength(3);
    expect(rows.map((r: { service: string }) => r.service).sort()).toEqual([
      'identity',
      'offer',
      'transaction',
    ]);
    const login = rows.find((r: { action: string }) => r.action === 'auth.login_succeeded');
    expect(login).toMatchObject({
      id: fromIdentity.aggregateId,
      service: 'identity',
      label: 'Signed in',
      actor: { id: actorId, type: 'USER', displayName: null },
      target: { type: 'ACCOUNT', id: actorId }, // normalised to upper case
      ipHash: 'iphash-abc',
      metadata: {},
    });
    expect(login.requestId).toMatch(/^req-/);
  });

  it('shows actor display names from ProfileUpdated, latest wins, never a phone', async () => {
    const actorId = randomUUID();
    await deliver(activity({ actorId }));
    const t0 = Date.now();
    const profile = (name: string, ms: number) =>
      ev(
        ProfileEvents.ProfileUpdated,
        { accountId: actorId, displayName: name, userType: 'INDIVIDUAL', district: null },
        new Date(t0 + ms),
      );
    await deliver(profile('Rahim Traders', 2000));
    await deliver(profile('Old Name', 1000)); // arrives late: ignored
    const res = await get(`/api/v1/admin/activity?actorId=${actorId}`);
    expect(res.json().data[0].actor.displayName).toBe('Rahim Traders');

    // Deleted accounts lose their name.
    await deliver(
      ev(IdentityEvents.AccountStatusChanged, {
        accountId: actorId,
        from: 'ACTIVE',
        to: 'DELETED',
        reason: 'user request',
      }),
    );
    const after = await get(`/api/v1/admin/activity?actorId=${actorId}`);
    expect(after.json().data[0].actor.displayName).toBeNull();
  });

  it('gets one entry by id, 404 for unknown', async () => {
    const e = activity({ action: 'review.create', targetType: 'REVIEW' });
    await deliver(e);
    const res = await get(`/api/v1/admin/activity/${e.aggregateId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ action: 'review.create', label: 'Wrote a review' });
    expect((await get(`/api/v1/admin/activity/${randomUUID()}`)).statusCode).toBe(404);
    expect((await get(`/api/v1/admin/activity/not-a-uuid`)).statusCode).toBe(400);
  });
});

describe('filters and keyset pagination', () => {
  // A private slice of the log: one unique service name, timestamps a second apart.
  const service = letters(12);
  const actorA = randomUUID();
  const actorB = randomUUID();
  const target = randomUUID();
  const base = Math.floor((Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000) * 1000;
  const rows = [
    { actorId: actorA, action: 'transaction.confirm', targetType: 'transaction' },
    { actorId: actorA, action: 'transaction.cancel', targetType: 'transaction', targetId: target },
    { actorId: actorB, action: 'offer.accept', targetType: 'OFFER', targetId: target },
    { actorId: actorB, action: 'transactions.weird', targetType: 'OFFER' },
    { actorId: null, action: 'auth.otp_requested', targetType: 'phone' },
    {
      actorId: actorA,
      action: 'admin.role_granted',
      actorType: 'ADMIN' as const,
      targetType: null,
      targetId: null,
    },
    { actorId: actorB, action: 'transaction.dispute', targetType: 'transaction' },
  ];
  const ids: string[] = [];

  beforeAll(async () => {
    for (const [i, r] of rows.entries()) {
      const e = activity({ ...r, producer: service, occurredAt: new Date(base + i * 1000) });
      ids.push(e.aggregateId);
      await deliver(e);
    }
  });

  const list = async (q: string) => {
    const res = await get(`/api/v1/admin/activity?service=${service}&${q}`);
    expect(res.statusCode).toBe(200);
    return res.json<{ data: Array<{ id: string }>; page: { nextCursor: string | null } }>();
  };
  const idsOf = (r: { data: Array<{ id: string }> }) => r.data.map((d) => d.id);
  // Newest first.
  const expected = (...idx: number[]) => idx.sort((a, b) => b - a).map((i) => ids[i]);

  it('by service (newest first)', async () => {
    expect(idsOf(await list(''))).toEqual(expected(0, 1, 2, 3, 4, 5, 6));
  });

  it('by actor', async () => {
    expect(idsOf(await list(`actorId=${actorA}`))).toEqual(expected(0, 1, 5));
  });

  it('by action prefix, without matching look-alikes', async () => {
    expect(idsOf(await list('action=transaction.'))).toEqual(expected(0, 1, 6));
    expect(idsOf(await list('action=transaction'))).toEqual(expected(0, 1, 3, 6));
    expect(idsOf(await list('action=transaction.cancel'))).toEqual(expected(1));
  });

  it('by target type (case-insensitive) and target id', async () => {
    expect(idsOf(await list('targetType=TRANSACTION'))).toEqual(expected(0, 1, 6));
    expect(idsOf(await list('targetType=offer'))).toEqual(expected(2, 3));
    expect(idsOf(await list(`targetId=${target}`))).toEqual(expected(1, 2));
    expect(idsOf(await list(`targetType=offer&targetId=${target}`))).toEqual(expected(2));
  });

  it('by actor type', async () => {
    expect(idsOf(await list('actorType=ADMIN'))).toEqual(expected(5));
    expect(idsOf(await list('actorType=ANONYMOUS'))).toEqual(expected(4));
  });

  it('by time range (inclusive)', async () => {
    const from = new Date(base + 2000).toISOString();
    const to = new Date(base + 4000).toISOString();
    expect(idsOf(await list(`from=${from}&to=${to}`))).toEqual(expected(2, 3, 4));
    const bad = await get(`/api/v1/admin/activity?from=${to}&to=${from}`);
    expect(bad.statusCode).toBe(400);
  });

  it('pages with a keyset cursor without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await list(`limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...idsOf(page));
      cursor = page.page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected(0, 1, 2, 3, 4, 5, 6));

    // Inserting a newer row mid-pagination does not shift later pages.
    const first = await list('limit=2');
    await deliver(activity({ producer: service, occurredAt: new Date(base + 60_000) }));
    const second = await list(`limit=2&cursor=${first.page.nextCursor}`);
    expect(idsOf(second)).toEqual(expected(4, 3));
  });

  it('rejects malformed cursors and unknown parameters', async () => {
    expect((await get(`/api/v1/admin/activity?cursor=nope`)).statusCode).toBe(400);
    const forged = Buffer.from(JSON.stringify(['2026-01-01T00:00:00Z', "x'); drop"])).toString(
      'base64url',
    );
    expect((await get(`/api/v1/admin/activity?cursor=${forged}`)).statusCode).toBe(400);
    expect((await get(`/api/v1/admin/activity?sort=asc`)).statusCode).toBe(400);
    expect((await get(`/api/v1/admin/activity?limit=500`)).statusCode).toBe(400);
  });

  it('facets: services and actions with counts', async () => {
    const res = await get('/api/v1/admin/activity/facets?days=30');
    expect(res.statusCode).toBe(200);
    const f = res.json().data;
    expect(f.services).toContainEqual({ service, count: 8 });
    const confirm = f.actions.find((a: { action: string }) => a.action === 'transaction.confirm');
    expect(confirm.count).toBeGreaterThanOrEqual(1);
    expect(confirm.label).toBe('Confirmed a deal');

    // The window excludes older rows.
    const recent = await get('/api/v1/admin/activity/facets?days=1');
    expect(
      recent.json().data.services.find((s: { service: string }) => s.service === service),
    ).toBeUndefined();
  });
});

describe('CSV export', () => {
  it('escapes cells, neutralises formulas, and audits the export', async () => {
    const service = letters(12);
    const actorId = randomUUID();
    await deliver(
      ev(ProfileEvents.ProfileUpdated, {
        accountId: actorId,
        displayName: '@evil, "quoted"',
        userType: 'INDIVIDUAL',
        district: null,
      }),
    );
    await deliver(
      activity({
        producer: service,
        actorId,
        action: 'offer.counter',
        targetId: '=HYPERLINK("http://x","y")',
        metadata: { note: 'line1\nline2', n: -1 },
        occurredAt: '2026-02-01T00:00:00.000Z',
      }),
    );
    const adminId = randomUUID();
    const res = await get(
      `/api/v1/admin/activity/export?service=${service}`,
      await t.auth.as(adminId, ['ADMIN']),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="dorkar-activity-/);
    const body = res.body.replace(/^\uFEFF/, '');
    const lines = body.split('\r\n');
    expect(lines[0]).toBe(
      'occurredAt,service,action,label,actorType,actorId,actorName,targetType,targetId,requestId,ipHash,metadata',
    );
    const row = lines.slice(1).join('\r\n');
    expect(row).toContain(
      `2026-02-01T00:00:00.000Z,${service},offer.counter,Countered an offer,USER,${actorId},`,
    );
    expect(row).toContain(`"'@evil, ""quoted"""`);
    expect(row).toContain(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(row).toContain(`"{""n"":-1,""note"":""line1\\nline2""}"`);
    expect(lines.at(-1)).toBe('');

    const audit = await t.svc.runtime.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'activity.exported')
      .where('actor_id', '=', adminId)
      .executeTakeFirstOrThrow();
    expect(audit.actor_type).toBe('ADMIN');
    expect(audit.metadata).toMatchObject({ filters: { service }, maxRows: 10_000 });
    // …and queued for the activity log like every audit record.
    const queued = await t.svc.runtime.db
      .selectFrom('outbox')
      .select('type')
      .where('aggregate_id', '=', audit.id)
      .executeTakeFirstOrThrow();
    expect(queued.type).toBe('audit.ActivityRecorded');
  });

  it('streams across keyset pages', async () => {
    const service = letters(12);
    const n = 1_205;
    const base = Date.parse('2025-12-01T00:00:00.000Z');
    await t.svc.runtime.db
      .insertInto('activity_log')
      .values(
        Array.from({ length: n }, (_, i) => ({
          id: randomUUID(),
          service,
          occurred_at: new Date(base + Math.floor(i / 2) * 1000), // ties on time, broken by id
          actor_id: null,
          actor_type: 'SYSTEM' as const,
          action: 'transaction.auto-complete',
          target_type: 'TRANSACTION',
          target_id: randomUUID(),
          request_id: null,
          ip_hash: null,
          metadata: '{}',
        })),
      )
      .execute();
    const res = await get(`/api/v1/admin/activity/export?service=${service}`);
    const lines = res.body.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(n + 1);
    const ids = new Set(lines.slice(1).map((l) => l.split(',')[8]));
    expect(ids.size).toBe(n);
  });
});

describe('my activity', () => {
  it('mine: my own actions without ip, request id or metadata', async () => {
    const me = randomUUID();
    await deliver(
      activity({
        actorId: me,
        action: 'offer.submit',
        metadata: { price: 100 },
        producer: 'offer',
      }),
    );
    await deliver(activity({ actorId: randomUUID(), action: 'offer.submit' })); // someone else
    const res = await app().inject({ url: '/api/v1/me/activity', headers: await t.auth.as(me) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      service: 'offer',
      action: 'offer.submit',
      label: 'Submitted an offer',
      actor: null,
    });
    expect(Object.keys(data[0]).sort()).toEqual(
      ['action', 'actor', 'id', 'label', 'occurredAt', 'service', 'target'].sort(),
    );
    expect(res.body).not.toMatch(/iphash|req-|price/);
  });

  it('about-me: staff actions on my account, staff shown only as "Dorkar team"', async () => {
    const me = randomUUID();
    const staff = randomUUID();
    await deliver(
      activity({
        producer: 'identity',
        actorId: staff,
        actorType: 'ADMIN',
        action: 'admin.account_status_changed',
        targetType: 'account',
        targetId: me,
        metadata: { from: 'ACTIVE', to: 'SUSPENDED' },
      }),
    );
    // Not staff, or not about my account: excluded.
    await deliver(activity({ actorId: randomUUID(), targetType: 'ACCOUNT', targetId: me }));
    await deliver(
      activity({ actorId: staff, actorType: 'ADMIN', targetType: 'OFFER', targetId: me }),
    );
    // My own action on my account is "mine", not "about me".
    await deliver(
      activity({ actorId: me, action: 'auth.logout_all', targetType: 'account', targetId: me }),
    );

    const res = await app().inject({
      url: '/api/v1/me/activity?scope=about-me',
      headers: await t.auth.as(me),
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      action: 'admin.account_status_changed',
      label: 'Changed an account status',
      actor: { displayName: 'Dorkar team' },
      target: { type: 'ACCOUNT', id: me },
    });
    expect(res.body).not.toContain(staff);
    expect(res.body).not.toMatch(/SUSPENDED|iphash|req-/);
  });

  it('requires authentication and validates the scope', async () => {
    expect((await app().inject({ url: '/api/v1/me/activity' })).statusCode).toBe(401);
    const res = await app().inject({
      url: '/api/v1/me/activity?scope=everyone',
      headers: await t.auth.as(randomUUID()),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('authorization', () => {
  const adminRoutes = [
    '/api/v1/admin/activity',
    '/api/v1/admin/activity/facets',
    '/api/v1/admin/activity/export',
    `/api/v1/admin/activity/${randomUUID()}`,
  ];
  const dashboardRoutes = [
    '/api/v1/admin/dashboard/summary',
    '/api/v1/admin/dashboard/timeseries?metric=signups',
    '/api/v1/admin/dashboard/funnel',
  ];

  it('members get 403 on every admin route; anonymous get 401', async () => {
    const member = await t.auth.as(randomUUID(), ['MEMBER']);
    for (const url of [...adminRoutes, ...dashboardRoutes]) {
      expect((await app().inject({ url, headers: member })).statusCode, url).toBe(403);
      expect((await app().inject({ url })).statusCode, url).toBe(401);
    }
  });

  it('support reads the dashboard but not the activity log', async () => {
    const support = await t.auth.as(randomUUID(), ['SUPPORT']);
    for (const url of dashboardRoutes) {
      expect((await app().inject({ url, headers: support })).statusCode, url).toBe(200);
    }
    for (const url of adminRoutes) {
      expect((await app().inject({ url, headers: support })).statusCode, url).toBe(403);
    }
  });

  it('moderators have neither', async () => {
    const mod = await t.auth.as(randomUUID(), ['MODERATOR']);
    for (const url of [adminRoutes[0]!, dashboardRoutes[0]!]) {
      expect((await app().inject({ url, headers: mod })).statusCode, url).toBe(403);
    }
  });
});

describe('retention', () => {
  it('deletes rows older than ACTIVITY_RETENTION_DAYS in batches, keeps the rest', async () => {
    const service = letters(12);
    const day = 24 * 60 * 60 * 1000;
    const old = Array.from({ length: 5 }, (_, i) =>
      activity({ producer: service, occurredAt: new Date(Date.now() - (366 + i) * day) }),
    );
    const recent = activity({ producer: service, occurredAt: new Date(Date.now() - 364 * day) });
    for (const e of [...old, recent]) await deliver(e);

    const purged = await t.svc.activity.purgeExpired(pgActivityStore(t.svc.runtime.db), 2);
    expect(purged).toBeGreaterThanOrEqual(5); // 3 batches of ≤ 2

    const left = await t.svc.runtime.db
      .selectFrom('activity_log')
      .select('id')
      .where('service', '=', service)
      .execute();
    expect(left.map((r) => r.id)).toEqual([recent.aggregateId]);
    expect(t.svc.config.ACTIVITY_RETENTION_DAYS).toBe(365);

    // Nothing left to purge.
    expect(await t.svc.activity.purgeExpired(pgActivityStore(t.svc.runtime.db), 2)).toBe(0);
  });

  it('has an index for every filter', async () => {
    const idx = await sql<{
      indexname: string;
    }>`select indexname from pg_indexes where schemaname = ${t.schema} and tablename = 'activity_log'`.execute(
      t.svc.runtime.database.root,
    );
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual(
      [
        'activity_log_action_prefix_idx',
        'activity_log_actor_idx',
        'activity_log_actor_type_idx',
        'activity_log_pkey',
        'activity_log_service_idx',
        'activity_log_target_idx',
        'activity_log_target_type_idx',
        'activity_log_time_idx',
      ].sort(),
    );
  });
});
