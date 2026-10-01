import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  createHarness,
  randomDeviceKey,
  randomPhone,
  requestOtp,
  sleep,
  type Harness,
} from './harness';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const e164 = (phone: string) => `+880${phone.slice(1)}`;
const verify = (challengeId: string, code: string, deviceKey = randomDeviceKey()) =>
  h.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-otp',
    payload: { challengeId, code, device: { key: deviceKey, platform: 'web' } },
  });

describe('POST /api/v1/auth/request-otp', () => {
  it('accepts common BD formats and sends one SMS', async () => {
    const phone = randomPhone();
    const res = await requestOtp(h, `+88 ${phone.slice(0, 5)}-${phone.slice(5)}`);
    expect(res.statusCode).toBe(202);
    const body = res.json().data;
    expect(body).toEqual({
      challengeId: expect.any(String),
      expiresAt: expect.any(String),
      resendAfterSeconds: 1,
    });
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(250_000);
    expect(h.sms.lastCodeFor(e164(phone))).toMatch(/^\d{6}$/);
  });

  it('rejects non-BD and malformed numbers', async () => {
    for (const phone of ['+14155550100', '01212345678', '123']) {
      const res = await requestOtp(h, phone);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_PHONE');
    }
  });

  it('enforces the resend cooldown with Retry-After', async () => {
    const phone = randomPhone();
    expect((await requestOtp(h, phone)).statusCode).toBe(202);
    const second = await requestOtp(h, phone);
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('RATE_LIMITED');
    expect(Number(second.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('responds identically for new and existing accounts (no enumeration)', async () => {
    const existing = randomPhone();
    const first = await requestOtp(h, existing);
    const { challengeId } = first.json().data;
    await verify(challengeId, h.sms.lastCodeFor(e164(existing))!);
    await sleep(1_050);

    const a = await requestOtp(h, existing);
    const b = await requestOtp(h, randomPhone());
    expect(a.statusCode).toBe(b.statusCode);
    expect(Object.keys(a.json().data).sort()).toEqual(Object.keys(b.json().data).sort());
  });

  it('returns 503 when the SMS provider fails', async () => {
    h.sms.failNext = true;
    const res = await requestOtp(h, randomPhone());
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('UNAVAILABLE');
  });

  it('rejects unknown fields', async () => {
    const res = await h.inject({
      method: 'POST',
      url: '/api/v1/auth/request-otp',
      payload: { phone: randomPhone(), role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /api/v1/auth/verify-otp', () => {
  it('rejects a wrong code with a generic error and locks the challenge after max attempts', async () => {
    const phone = randomPhone();
    const { challengeId } = (await requestOtp(h, phone)).json().data;
    const code = h.sms.lastCodeFor(e164(phone))!;
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < h.config.OTP_MAX_ATTEMPTS; i++) {
      const res = await verify(challengeId, wrong);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('OTP_INVALID');
    }
    const correctButExhausted = await verify(challengeId, code);
    expect(correctButExhausted.statusCode).toBe(400);
    expect(correctButExhausted.json().error.code).toBe('OTP_INVALID');
  });

  it('never exceeds max attempts under parallel guessing', async () => {
    const phone = randomPhone();
    const { challengeId } = (await requestOtp(h, phone)).json().data;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => verify(challengeId, String(100000 + i))),
    );
    expect(results.every((r) => r.statusCode === 400 || r.statusCode === 200)).toBe(true);
    const row = await h.svc.database.db
      .selectFrom('otp_challenges')
      .select(['attempts', 'max_attempts'])
      .where('id', '=', challengeId)
      .executeTakeFirstOrThrow();
    expect(row.attempts).toBe(row.max_attempts);
  });

  it('rejects an expired code', async () => {
    const phone = randomPhone();
    const { challengeId } = (await requestOtp(h, phone)).json().data;
    await h.svc.database.db
      .updateTable('otp_challenges')
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where('id', '=', challengeId)
      .execute();
    const res = await verify(challengeId, h.sms.lastCodeFor(e164(phone))!);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('OTP_INVALID');
  });

  it('is single-use even when the correct code is submitted concurrently', async () => {
    const phone = randomPhone();
    const { challengeId } = (await requestOtp(h, phone)).json().data;
    const code = h.sms.lastCodeFor(e164(phone))!;
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(challengeId, code)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 400)).toHaveLength(4);
    const sessions = await h.svc.database.db
      .selectFrom('sessions')
      .innerJoin('accounts', 'accounts.id', 'sessions.account_id')
      .select('sessions.id')
      .where('accounts.phone_e164', '=', e164(phone))
      .execute();
    expect(sessions).toHaveLength(1);
  });

  it('locks the phone out after repeated exhausted challenges', async () => {
    const phone = randomPhone();
    for (let i = 0; i < h.config.OTP_LOCKOUT_AFTER_EXHAUSTED; i++) {
      const res = await requestOtp(h, phone);
      expect(res.statusCode).toBe(202);
      const { challengeId } = res.json().data;
      const code = h.sms.lastCodeFor(e164(phone))!;
      const wrong = code === '000000' ? '111111' : '000000';
      for (let j = 0; j < h.config.OTP_MAX_ATTEMPTS; j++) await verify(challengeId, wrong);
      await sleep(1_050); // resend cooldown
    }
    const locked = await requestOtp(h, phone);
    expect(locked.statusCode).toBe(429);
  });
});

describe('secrets hygiene', () => {
  it('never writes OTPs or raw phone numbers to logs, audit or outbox', async () => {
    const phone = randomPhone();
    const { challengeId } = (await requestOtp(h, phone)).json().data;
    const code = h.sms.lastCodeFor(e164(phone))!;
    await verify(challengeId, code === '999999' ? '888888' : '999999');
    expect((await verify(challengeId, code)).statusCode).toBe(200);

    const logs = h.logLines.join('\n');
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(e164(phone));
    expect(logs).not.toContain(phone);

    const audit = await h.svc.database.db
      .selectFrom('audit_log')
      .select(['metadata', 'target_id'])
      .execute();
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(code);
    expect(auditText).not.toContain(phone.slice(1));

    const outbox = await h.svc.database.db.selectFrom('outbox').select('payload').execute();
    expect(JSON.stringify(outbox)).not.toContain(phone.slice(1));

    const stored = await h.svc.database.db
      .selectFrom('otp_challenges')
      .select('code_hash')
      .where('id', '=', challengeId)
      .executeTakeFirstOrThrow();
    expect(stored.code_hash.toString('utf8')).not.toContain(code);
  });
});
