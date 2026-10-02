import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, login, randomPhone, type Harness } from './harness';

const TOKEN = 'internal-token-for-tests-0123456789abcdef';
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ INTERNAL_API_TOKEN: TOKEN });
});
afterAll(() => h.close());

const contact = (id: string, headers: Record<string, string> = {}, purpose = 'NOTIFICATION') =>
  h.inject({ url: `/internal/v1/accounts/${id}/contact?purpose=${purpose}`, headers });

describe('internal contact lookup', () => {
  it('returns the phone only to services holding the internal token, and audits the access', async () => {
    const phone = randomPhone();
    const s = await login(h, phone);
    expect((await contact(s.accountId)).statusCode).toBe(403);
    expect((await contact(s.accountId, { 'x-internal-token': 'wrong' })).statusCode).toBe(403);

    const res = await contact(s.accountId, { 'x-internal-token': TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ accountId: s.accountId, phoneE164: `+880${phone.slice(1)}` });

    const audit = await h.svc.database.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'contact.read')
      .where('target_id', '=', s.accountId)
      .executeTakeFirstOrThrow();
    expect(audit.metadata).toEqual({ purpose: 'NOTIFICATION' });
  });

  it('requires a stated purpose and refuses unknown or inactive accounts', async () => {
    const s = await login(h);
    expect(
      (await contact(s.accountId, { 'x-internal-token': TOKEN }, 'MARKETING')).statusCode,
    ).toBe(400);
    expect(
      (await contact('0192f0c4-0000-7000-8000-000000000000', { 'x-internal-token': TOKEN }))
        .statusCode,
    ).toBe(404);
  });

  it('is not registered when no internal token is configured', async () => {
    const plain = await createHarness();
    try {
      const s = await login(plain);
      const res = await plain.inject({
        url: `/internal/v1/accounts/${s.accountId}/contact?purpose=NOTIFICATION`,
        headers: { 'x-internal-token': TOKEN },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await plain.close();
    }
  });
});
