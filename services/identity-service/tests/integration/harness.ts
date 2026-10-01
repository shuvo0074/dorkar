import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  captureLogger,
  dropSchema,
  ensureTestDatabase,
  TEST_DATABASE_URL,
  TEST_REDIS_URL,
  uniqueSchema,
} from '@dorkar/kernel/testing';
import { migrateUp } from '@dorkar/kernel';
import type { InjectOptions } from 'fastify';
import { migrations } from '../../migrations';
import { buildIdentityService, type IdentityOverrides, type IdentityService } from '../../src/app';
import { loadIdentityConfig, type IdentityConfig } from '../../src/config/env';
import { RecordingSmsSender } from '../../src/infrastructure/sms/sms-senders';

export const ORIGIN = 'https://app.dorkar.test';

export interface Harness {
  svc: IdentityService;
  config: IdentityConfig;
  sms: RecordingSmsSender;
  logLines: string[];
  inject: IdentityService['app']['inject'];
  close(): Promise<void>;
}

export async function createHarness(
  env: Record<string, string> = {},
  overrides: IdentityOverrides = {},
): Promise<Harness> {
  await ensureTestDatabase();
  const schema = uniqueSchema('identity');
  const { privateKey } = generateKeyPairSync('ed25519');
  const config = loadIdentityConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_SCHEMA: schema,
    REDIS_URL: TEST_REDIS_URL,
    JWT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    JWT_KEY_ID: 'test-key',
    OTP_PEPPER: randomBytes(32).toString('hex'),
    PII_HASH_KEY: randomBytes(32).toString('hex'), // fresh per harness → isolated Redis keys
    OTP_RESEND_COOLDOWN_SECONDS: '1',
    OTP_GLOBAL_PER_MINUTE: '100000',
    OTP_PER_IP_PER_HOUR: '100000',
    OTP_VERIFY_PER_IP_PER_HOUR: '100000',
    CORS_ORIGINS: ORIGIN,
    REFRESH_COOKIE_SECURE: 'true',
    OUTBOX_RELAY_ENABLED: 'false',
    JOBS_ENABLED: 'false',
    LOG_LEVEL: 'trace',
    ...env,
  });
  const { logger, lines } = captureLogger('trace');
  const sms = new RecordingSmsSender();
  const svc = await buildIdentityService(config, logger, { sms, ...overrides });
  await migrateUp({ db: svc.database.root, schema, migrations });
  await svc.app.ready();
  return {
    svc,
    config,
    sms,
    logLines: lines,
    inject: svc.app.inject.bind(svc.app),
    async close() {
      await svc.app.close();
      await dropSchema(svc.database.root, schema);
      await svc.close();
    },
  };
}

let phoneCounter = 0;
/** Unique, valid BD mobile number per call. */
export function randomPhone(): string {
  const n = (Date.now() % 1e6) * 100 + (phoneCounter++ % 100);
  return `017${String(n).padStart(8, '0').slice(-8)}`;
}

export const randomDeviceKey = () => randomBytes(32).toString('base64url');

export async function requestOtp(h: Harness, phone: string, extra: Partial<InjectOptions> = {}) {
  return h.inject({
    method: 'POST',
    url: '/api/v1/auth/request-otp',
    payload: { phone },
    ...extra,
  });
}

export interface LoggedIn {
  accountId: string;
  accessToken: string;
  refreshCookie: string;
  deviceKey: string;
  body: Record<string, any>;
}

/** Full happy-path login; returns tokens. */
export async function login(
  h: Harness,
  phone = randomPhone(),
  deviceKey = randomDeviceKey(),
  headers: Record<string, string> = {},
): Promise<LoggedIn> {
  const req = await requestOtp(h, phone);
  if (req.statusCode !== 202) throw new Error(`request-otp failed: ${req.body}`);
  const { challengeId } = req.json().data;
  const code = h.sms.lastCodeFor(`+880${phone.slice(1)}`)!;
  const res = await h.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-otp',
    headers,
    payload: {
      challengeId,
      code,
      device: { key: deviceKey, platform: 'web', label: 'Test browser' },
    },
  });
  if (res.statusCode !== 200) throw new Error(`verify-otp failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'dorkar_rt');
  const body = res.json().data;
  return {
    accountId: body.account.id,
    accessToken: body.accessToken,
    refreshCookie: cookie?.value ?? '',
    deviceKey,
    body,
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const refreshHeaders = (cookie: string) => ({
  cookie: `dorkar_rt=${cookie}`,
  'x-requested-with': 'dorkar',
  origin: ORIGIN,
});
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
