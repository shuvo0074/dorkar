// Single source of truth for local orchestration: every backend service, its port, schema and
// the env it needs. Used by dev-setup.mjs, dev-backend.mjs and e2e-backend.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
export const DEV_ENV_FILE = resolve(ROOT, '.env.dev');

/** name → { dir, port, schema } (schema is also the DB role suffix: svc_<schema>). */
export const SERVICES = {
  identity: { dir: 'services/identity-service', port: 4001, schema: 'identity' },
  profile: { dir: 'services/profile-service', port: 4002, schema: 'profile' },
  verification: { dir: 'services/verification-service', port: 4003, schema: 'verification' },
  catalog: { dir: 'services/catalog-service', port: 4004, schema: 'catalog' },
  demand: { dir: 'services/demand-service', port: 4005, schema: 'demand' },
  media: { dir: 'services/media-service', port: 4006, schema: 'media' },
  matching: { dir: 'services/matching-service', port: 4007, schema: 'matching' },
  offer: { dir: 'services/offer-service', port: 4008, schema: 'offer' },
  transaction: { dir: 'services/transaction-service', port: 4009, schema: 'txn' },
  reputation: { dir: 'services/reputation-service', port: 4010, schema: 'reputation' },
  moderation: { dir: 'services/moderation-service', port: 4011, schema: 'moderation' },
  notification: { dir: 'services/notification-service', port: 4012, schema: 'notification' },
  bidding: { dir: 'services/bidding-service', port: 4013, schema: 'bidding' },
  rental: { dir: 'services/rental-service', port: 4014, schema: 'rental' },
  lending: { dir: 'services/lending-service', port: 4015, schema: 'lending' },
  dispute: { dir: 'services/dispute-service', port: 4016, schema: 'dispute' },
  messaging: { dir: 'services/messaging-service', port: 4017, schema: 'messaging' },
  dashboard: { dir: 'services/dashboard-service', port: 4018, schema: 'dashboard' },
};
export const GATEWAY_PORT = 4000;

export function readDevEnv() {
  if (!existsSync(DEV_ENV_FILE)) {
    throw new Error('Missing .env.dev — run `pnpm dev:setup` first.');
  }
  const env = {};
  for (const line of readFileSync(DEV_ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const url = (port) => `http://127.0.0.1:${port}`;

/** Environment for one service process, derived from the shared dev secrets. */
export function serviceEnv(name, dev) {
  const s = SERVICES[name];
  const db = new URL(dev.DATABASE_URL);
  db.username = `svc_${s.schema}`;
  db.password = `dev_${s.schema}_pw`;
  const common = {
    NODE_ENV: 'development',
    SERVICE_NAME: `${name}-service`,
    PORT: String(s.port),
    HOST: '127.0.0.1',
    LOG_LEVEL: dev.LOG_LEVEL ?? 'info',
    DATABASE_URL: db.toString(),
    DATABASE_SCHEMA: s.schema,
    DATABASE_SSL: 'disable',
    REDIS_URL: dev.REDIS_URL,
    TRUST_PROXY: '1',
    PII_HASH_KEY: dev.PII_HASH_KEY,
    INTERNAL_API_TOKEN: dev.INTERNAL_API_TOKEN,
    JWKS_URL: `${url(SERVICES.identity.port)}/.well-known/jwks.json`,
    VERIFICATION_URL: url(SERVICES.verification.port),
    PROFILE_URL: url(SERVICES.profile.port),
    IDENTITY_URL: url(SERVICES.identity.port),
  };
  switch (name) {
    case 'identity':
      return {
        ...common,
        CORS_ORIGINS: 'http://localhost:5173',
        JWT_KEY_ID: dev.JWT_KEY_ID,
        JWT_PRIVATE_KEY: dev.JWT_PRIVATE_KEY,
        OTP_PEPPER: dev.OTP_PEPPER,
        SMS_PROVIDER: 'file',
        SMS_FILE_PATH: resolve(ROOT, 'var/dev-sms.log'),
        REFRESH_COOKIE_SECURE: 'false',
      };
    case 'media':
      return {
        ...common,
        MEDIA_STORAGE: 'local',
        MEDIA_LOCAL_DIR: resolve(ROOT, 'var/media'),
        MEDIA_SIGNING_KEY: dev.MEDIA_SIGNING_KEY,
        MEDIA_PUBLIC_BASE_URL: url(GATEWAY_PORT),
      };
    case 'notification':
      return {
        ...common,
        SMS_PROVIDER: 'file',
        SMS_FILE_PATH: resolve(ROOT, 'var/notification-sms.log'),
      };
    default:
      return common;
  }
}

export function gatewayEnv(dev) {
  const upstreams = Object.fromEntries(
    Object.entries(SERVICES).map(([name, s]) => [
      `UPSTREAM_${name.toUpperCase()}_URL`,
      url(s.port),
    ]),
  );
  return {
    NODE_ENV: 'development',
    PORT: String(GATEWAY_PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: dev.LOG_LEVEL ?? 'info',
    REDIS_URL: dev.REDIS_URL,
    PII_HASH_KEY: dev.PII_HASH_KEY,
    CORS_ORIGINS: 'http://localhost:5173',
    TRUST_PROXY: 'false',
    ...upstreams,
  };
}
