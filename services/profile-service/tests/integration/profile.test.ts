import { randomUUID } from 'node:crypto';
import { IdentityEvents, ReputationEvents, VerificationEvents } from '@dorkar/contracts';
import {
  envelope,
  startTestService,
  TEST_INTERNAL_TOKEN,
  type TestService,
} from '@dorkar/kernel/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildProfileService } from '../../src/app';

let t: TestService<Awaited<ReturnType<typeof buildProfileService>>>;
const app = () => t.svc.runtime.app;

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'profile',
    migrations,
    build: (env, logger, verifier) => buildProfileService(env, logger, { verifier }),
  });
});
afterAll(() => t.close());

const outboxTypes = async (accountId: string) =>
  (
    await t.svc.runtime.db
      .selectFrom('outbox')
      .select('type')
      .where('aggregate_id', '=', accountId)
      .execute()
  ).map((r) => r.type);

describe('my profile', () => {
  it('creates a neutral default profile on first read (event may not have arrived yet)', async () => {
    const id = randomUUID();
    const res = await app().inject({ url: '/api/v1/me/profile', headers: await t.auth.as(id) });
    expect(res.statusCode).toBe(200);
    const p = res.json().data;
    expect(p).toMatchObject({
      id,
      userType: 'INDIVIDUAL',
      locale: 'en',
      capabilities: null,
      badges: [],
    });
    expect(p.displayName).toMatch(/^Member [0-9A-F]{4}$/);
    expect(JSON.stringify(p)).not.toMatch(/phone/i);
  });

  it('updates fields, publishes ProfileUpdated, and rejects unknown fields', async () => {
    const id = randomUUID();
    const headers = await t.auth.as(id);
    const res = await app().inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers,
      payload: {
        displayName: 'Rahim Traders',
        userType: 'BUSINESS',
        district: 'chattogram',
        bio: 'Phones and accessories',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      displayName: 'Rahim Traders',
      userType: 'BUSINESS',
      district: 'chattogram',
    });
    expect(await outboxTypes(id)).toContain('profile.ProfileUpdated');

    const sneaky = await app().inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers,
      payload: { displayName: 'X Y', hidden: true },
    });
    expect(sneaky.statusCode).toBe(400);
  });

  it('refuses contact details in public text', async () => {
    const res = await app().inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers: await t.auth.as(randomUUID()),
      payload: { bio: 'Call ০১৭১২-৩৪৫৬৭৮ for deals' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toMatchObject({ rule: 'NO_CONTACT_INFO', field: 'bio' });
  });

  it('requires authentication', async () => {
    expect((await app().inject({ url: '/api/v1/me/profile' })).statusCode).toBe(401);
  });
});

describe('seller capabilities', () => {
  const body = {
    roles: ['SELLER', 'SELLER'],
    categoryIds: [randomUUID()],
    serviceDistricts: ['dhaka', 'gazipur'],
    deliveryModes: ['SELLER_DELIVERY'],
    active: true,
  };

  it('stores de-duplicated capabilities and publishes SellerCapabilitiesChanged', async () => {
    const id = randomUUID();
    const res = await app().inject({
      method: 'PUT',
      url: '/api/v1/me/seller-capabilities',
      headers: await t.auth.as(id),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.roles).toEqual(['SELLER']);
    expect(await outboxTypes(id)).toContain('profile.SellerCapabilitiesChanged');
  });

  it('rejects an active seller with no category', async () => {
    const res = await app().inject({
      method: 'PUT',
      url: '/api/v1/me/seller-capabilities',
      headers: await t.auth.as(randomUUID()),
      payload: { ...body, categoryIds: [] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.rule).toBe('CAPABILITIES_INCOMPLETE');
  });

  it('rejects districts that do not exist', async () => {
    const res = await app().inject({
      method: 'PUT',
      url: '/api/v1/me/seller-capabilities',
      headers: await t.auth.as(randomUUID()),
      payload: { ...body, serviceDistricts: ['atlantis'] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('public profile and projections', () => {
  it('shows badges, reputation and active seller info; never private fields', async () => {
    const id = randomUUID();
    await t.svc.runtime.deliver(envelope(IdentityEvents.AccountCreated, { accountId: id }));
    await t.svc.runtime.deliver(
      envelope(VerificationEvents.VerificationStatusChanged, {
        accountId: id,
        kind: 'PHONE',
        status: 'VERIFIED',
      }),
    );
    await t.svc.runtime.deliver(
      envelope(ReputationEvents.ReputationUpdated, {
        accountId: id,
        ratingAverage: 4.5,
        ratingCount: 2,
        completedCount: 3,
        cancelledCount: 0,
        disputedCount: 0,
      }),
    );
    await app().inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      headers: await t.auth.as(id),
      payload: { area: 'Mirpur 10', locale: 'bn' },
    });

    const res = await app().inject({ url: `/api/v1/users/${id}` });
    expect(res.statusCode).toBe(200);
    const p = res.json().data;
    expect(p.badges).toEqual(['PHONE_VERIFIED']);
    expect(p.reputation).toMatchObject({ ratingAverage: 4.5, completedCount: 3 });
    expect(p).not.toHaveProperty('area');
    expect(p).not.toHaveProperty('locale');
    expect(p.seller).toBeNull();
  });

  it('hides banned accounts and restores them when reactivated', async () => {
    const id = randomUUID();
    await t.svc.runtime.deliver(envelope(IdentityEvents.AccountCreated, { accountId: id }));
    await t.svc.runtime.deliver(
      envelope(IdentityEvents.AccountStatusChanged, {
        accountId: id,
        from: 'ACTIVE',
        to: 'BANNED',
        reason: 'fraud',
      }),
    );
    expect((await app().inject({ url: `/api/v1/users/${id}` })).statusCode).toBe(404);
    await t.svc.runtime.deliver(
      envelope(IdentityEvents.AccountStatusChanged, {
        accountId: id,
        from: 'BANNED',
        to: 'ACTIVE',
        reason: 'appeal',
      }),
    );
    expect((await app().inject({ url: `/api/v1/users/${id}` })).statusCode).toBe(200);
  });

  it('is idempotent under event redelivery', async () => {
    const id = randomUUID();
    const e = envelope(IdentityEvents.AccountCreated, { accountId: id });
    expect(await t.svc.runtime.deliver(e)).toBe(true);
    expect(await t.svc.runtime.deliver(e)).toBe(false);
  });

  it('serves batch cards to other services only', async () => {
    const a = randomUUID();
    const b = randomUUID();
    for (const id of [a, b])
      await t.svc.runtime.deliver(envelope(IdentityEvents.AccountCreated, { accountId: id }));
    const url = `/internal/v1/profiles?ids=${a},${b},not-a-uuid`;
    expect((await app().inject({ url })).statusCode).toBe(403);
    const res = await app().inject({ url, headers: { 'x-internal-token': TEST_INTERNAL_TOKEN } });
    expect(
      res
        .json()
        .data.map((c: { accountId: string }) => c.accountId)
        .sort(),
    ).toEqual([a, b].sort());
  });

  it('404s unknown profiles', async () => {
    expect((await app().inject({ url: `/api/v1/users/${randomUUID()}` })).statusCode).toBe(404);
  });
});
