// Shared helpers for the end-to-end scripts (e2e-backend.mjs, e2e-phase2.mjs). They talk to the
// gateway only, like a client would; sign-in reads the OTP from the dev SMS file.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { GATEWAY_PORT, readDevEnv, ROOT } from './backend-services.mjs';

export const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${GATEWAY_PORT}`;
export const SMS_LOG = resolve(ROOT, 'var/dev-sms.log');

/** Seeded category ids (services/catalog-service/migrations/0002_seed_categories.ts). */
export const CATEGORIES = {
  /** BUY, RENT, BORROW */
  MOBILE_PHONES: '0192ca7a-0000-7000-8000-000000000101',
  /** BUY, RENT, BORROW */
  LAPTOPS: '0192ca7a-0000-7000-8000-000000000102',
  /** SOURCE */
  BAGS_PACKAGING: '0192ca7a-0000-7000-8000-000000000701',
};

let step = 0;
export const log = (msg) => console.log(`\x1b[32m✔\x1b[0m ${String(++step).padStart(2)}. ${msg}`);
export const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`);
export const note = (msg) => console.log(`\x1b[33m  ⏱ ${msg}\x1b[0m`);
export const steps = () => step;
export const fail = (msg, extra) => {
  console.error(`\x1b[31m✘ ${msg}\x1b[0m`, extra ? JSON.stringify(extra, null, 2) : '');
  process.exit(1);
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let rateLimitedWaits = 0;
/** How often a short gateway 429 was waited out (Retry-After), for the summary line. */
export const rateLimitWaits = () => rateLimitedWaits;

/**
 * One request through the gateway. Like a well-behaved client, it waits out a short 429
 * (the gateway allows 300 requests per minute per IP; polling for events adds up).
 */
export async function api(
  method,
  path,
  { token, body, idem, accept = 'application/json', headers: extra } = {},
) {
  const headers = { accept, ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (idem) headers['idempotency-key'] = idem;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.status === 429 && retryAfter > 0 && retryAfter <= 30 && attempt < 5) {
      rateLimitedWaits++;
      await sleep(retryAfter * 1000);
      continue;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
}

export async function expectStatus(promise, status, what) {
  const r = await promise;
  if (r.status !== status) fail(`${what}: expected ${status}, got ${r.status}`, r.body);
  return r.body;
}

/** Polls until `fn` returns a truthy value (events are asynchronous). */
export async function eventually(what, fn, timeoutMs = 15_000, intervalMs = 250) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  fail(`timed out waiting for: ${what}`, last);
}

export const idem = () => randomBytes(12).toString('base64url');
export const phone = () =>
  `01${7 + Math.floor(Math.random() * 3)}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

export async function requireGateway() {
  const health = await fetch(`${BASE}/health/ready`).catch(() => null);
  if (!health?.ok) fail(`gateway not reachable at ${BASE} — start it with \`pnpm dev:backend\``);
}

/**
 * Dev-only: identity allows OTP_PER_IP_PER_HOUR (20) code requests per client IP, and every e2e
 * user signs in from 127.0.0.1. When a run hits that limit, clear the per-IP OTP buckets in Redis
 * (the per-phone limits are untouched; every user has a fresh number anyway).
 */
async function resetOtpIpLimits() {
  const Redis = createRequire(resolve(ROOT, 'packages/kernel/package.json'))('ioredis');
  const redis = new Redis(readDevEnv().REDIS_URL, { lazyConnect: true });
  await redis.connect();
  try {
    let n = 0;
    for (const pattern of ['identity:rl:otp:ip:*', 'identity:rl:otp:verify:ip:*']) {
      for await (const keys of redis.scanStream({ match: pattern, count: 100 })) {
        if (keys.length) n += await redis.del(...keys);
      }
    }
    note(
      `DEV-ONLY: cleared ${n} per-IP OTP rate-limit bucket(s) in Redis (e2e signs in many users)`,
    );
  } finally {
    redis.disconnect();
  }
}

/** Retries once after clearing the per-IP OTP limit when identity answers 429. */
async function otpCall(path, body, headers) {
  let r = await api('POST', path, { body, headers });
  if (r.status === 429 && r.body?.error?.code === 'RATE_LIMITED') {
    await resetOtpIpLimits();
    r = await api('POST', path, { body, headers });
  }
  return r;
}

/**
 * Phone + OTP sign-in. Pass `p` to sign in again as an existing number; `native` signs in as the
 * mobile app does, so the refresh token comes back in the body (`refreshToken`).
 */
export async function signIn(label, p = phone(), { native = false } = {}) {
  const headers = native ? { 'x-client': 'mobile' } : undefined;
  const e164 = `+880${p.slice(1)}`;
  const smsTo = () => {
    let text = '';
    try {
      text = readFileSync(SMS_LOG, 'utf8');
    } catch {
      // first run: the file appears with the first SMS
    }
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((m) => m.to === e164);
  };
  const before = smsTo().length; // signing in again: wait for a new code, not the old one
  const req = await expectStatus(
    otpCall('/api/v1/auth/request-otp', { phone: p }),
    202,
    `${label} request-otp`,
  );
  const code = await eventually(`${label} OTP SMS`, async () => {
    const sms = smsTo();
    return sms.length > before && /code is (\d{6})/.exec(sms.at(-1).text)?.[1];
  });
  const r = await expectStatus(
    otpCall(
      '/api/v1/auth/verify-otp',
      {
        challengeId: req.data.challengeId,
        code,
        device: {
          key: randomBytes(32).toString('base64url'),
          platform: 'web',
          label: `e2e ${label}`,
        },
      },
      headers,
    ),
    200,
    `${label} verify-otp`,
  );
  return {
    token: r.data.accessToken,
    refreshToken: r.data.refreshToken,
    id: r.data.account.id,
    phone: p,
    label,
  };
}

/** A business profile plus seller capabilities, as the MVP seller sets up. */
export async function setUpSeller(user, { displayName, categoryIds, roles = ['SELLER'] }) {
  await expectStatus(
    api('PATCH', '/api/v1/me/profile', {
      token: user.token,
      body: { displayName, userType: 'BUSINESS', district: 'dhaka' },
    }),
    200,
    `${user.label} profile`,
  );
  await expectStatus(
    api('PUT', '/api/v1/me/seller-capabilities', {
      token: user.token,
      body: {
        roles,
        categoryIds,
        serviceDistricts: ['dhaka'],
        deliveryModes: ['SELLER_DELIVERY'],
        active: true,
      },
    }),
    200,
    `${user.label} seller capabilities`,
  );
}

/** Values for every required attribute of a category (enums take their first value). */
export async function requiredAttributes(categoryId) {
  const category = await expectStatus(
    api('GET', `/api/v1/categories/${categoryId}`),
    200,
    'category',
  );
  const schema = category.data.attributeSchema;
  const attributes = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (!schema.required.includes(key)) continue;
    attributes[key] =
      spec.type === 'string'
        ? (spec.enum?.[0] ?? 'Sample')
        : spec.type === 'boolean'
          ? true
          : (spec.minimum ?? 1) + 255;
  }
  return { category: category.data, attributes };
}

/** Creates and publishes a listing; returns the created listing. */
export async function publishListing(user, fields) {
  const { attributes } = await requiredAttributes(fields.categoryId);
  const listing = await expectStatus(
    api('POST', '/api/v1/listings', {
      token: user.token,
      body: {
        condition: 'USED',
        description: 'Well kept, works perfectly.',
        quantityAvailable: 1,
        attributes,
        district: 'dhaka',
        deliveryModes: ['SELLER_DELIVERY'],
        ...fields,
      },
    }),
    201,
    `${user.label} create listing`,
  );
  await expectStatus(
    api('POST', `/api/v1/listings/${listing.data.id}/publish`, { token: user.token }),
    200,
    `${user.label} publish listing`,
  );
  return listing.data;
}

export const taka = (poisha) => `৳${(poisha / 100).toLocaleString('en-US')}`;
