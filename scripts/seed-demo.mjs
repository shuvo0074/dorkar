// Demo data for local development: sellers with published products, rentals and services (with
// real photos), and buyers with open needs, created through the gateway like a real client
// (`pnpm dev:backend` must be running). The data is in scripts/seed-demo/listings.mjs and
// scripts/seed-demo/needs.mjs, the photos in scripts/seed-demo/photos.
//
//   pnpm seed:demo
//
// Idempotent: demo users sign in with fixed numbers, listings and needs whose title already exists
// are skipped, and demo listings and needs that are no longer in the data are withdrawn or closed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from './backend-services.mjs';
import {
  api,
  eventually,
  expectStatus,
  fail,
  log,
  note,
  requireGateway,
  signIn,
  sleep,
} from './e2e-lib.mjs';
import { LISTINGS, SELLERS } from './seed-demo/listings.mjs';
import { BUYERS, NEEDS } from './seed-demo/needs.mjs';

const PHOTOS = resolve(ROOT, 'scripts/seed-demo/photos');
const SESSIONS = resolve(ROOT, 'var/seed-demo-sessions.json');
const LIVE = new Set(['DRAFT', 'PUBLISHED', 'PAUSED']);
const LIVE_NEEDS = new Set(['DRAFT', 'OPEN', 'PAUSED']);

/**
 * Signs a demo user in, reusing the refresh token from the last run: the fixed numbers would
 * otherwise hit the per-phone OTP limit when the seed runs a few times in an hour.
 */
async function session(s, sessions) {
  const saved = sessions[s.phone];
  if (saved) {
    const r = await api('POST', '/api/v1/auth/refresh', {
      headers: { 'x-client': 'mobile' },
      body: { refreshToken: saved },
    });
    if (r.status === 200) {
      sessions[s.phone] = r.body.data.refreshToken;
      return { token: r.body.data.accessToken, label: s.displayName };
    }
  }
  const user = await signIn(s.displayName, s.phone, { native: true });
  sessions[s.phone] = user.refreshToken;
  return user;
}

function loadSessions() {
  try {
    return JSON.parse(readFileSync(SESSIONS, 'utf8'));
  } catch {
    return {};
  }
}

/** Upload → signed PUT → complete; returns the READY media id. */
async function uploadPhoto(user, name) {
  const bytes = readFileSync(resolve(PHOTOS, `${name}.jpg`));
  const started = await expectStatus(
    api('POST', '/api/v1/media/uploads', {
      token: user.token,
      body: { purpose: 'LISTING', contentType: 'image/jpeg', sizeBytes: bytes.length },
    }),
    201,
    `${user.label} start upload`,
  );
  const { mediaId, upload } = started.data;
  let put;
  for (let attempt = 0; attempt < 5; attempt++) {
    put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: bytes });
    // The upload goes through the gateway too: wait out a short rate limit like `api` does.
    const retryAfter = Number(put.headers.get('retry-after'));
    if (put.status !== 429 || !(retryAfter > 0 && retryAfter <= 30)) break;
    await sleep(retryAfter * 1000);
  }
  if (!put.ok) fail(`${user.label} photo upload: ${put.status}`, await put.text());
  const done = await expectStatus(
    api('POST', `/api/v1/media/${mediaId}/complete`, { token: user.token }),
    200,
    `${user.label} complete upload`,
  );
  if (done.data.status !== 'READY') fail(`${user.label} photo ${name} not ready`, done.data);
  return mediaId;
}

async function setUpSeller(user, s) {
  await expectStatus(
    api('PATCH', '/api/v1/me/profile', {
      token: user.token,
      body: { displayName: s.displayName, userType: 'BUSINESS', district: s.district },
    }),
    200,
    `${user.label} profile`,
  );
  await expectStatus(
    api('PUT', '/api/v1/me/seller-capabilities', {
      token: user.token,
      body: {
        roles: s.roles,
        categoryIds: s.categoryIds,
        serviceDistricts: [s.district],
        deliveryModes: ['BUYER_PICKUP', 'SELLER_DELIVERY', 'ON_SITE'],
        active: true,
      },
    }),
    200,
    `${user.label} seller capabilities`,
  );
}

async function myListings(user) {
  const all = [];
  let cursor;
  do {
    const q = `limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await expectStatus(
      api('GET', `/api/v1/me/listings?${q}`, { token: user.token }),
      200,
      `${user.label} my listings`,
    );
    all.push(...page.data);
    cursor = page.page.nextCursor;
  } while (cursor);
  return all.filter((l) => LIVE.has(l.status));
}

const deliveryModes = (kind) =>
  kind === 'SERVICE' ? ['ON_SITE'] : ['BUYER_PICKUP', 'SELLER_DELIVERY'];

async function createListing(user, s, l) {
  const kind = l.kind ?? 'PRODUCT';
  const mediaIds = [];
  for (const photo of l.photos) mediaIds.push(await uploadPhoto(user, photo));
  const listing = await expectStatus(
    api('POST', '/api/v1/listings', {
      token: user.token,
      body: {
        categoryId: l.categoryId,
        kind,
        condition: kind === 'SERVICE' ? null : l.condition,
        title: l.title,
        description: l.description,
        price: { amount: l.price * 100, currency: 'BDT' },
        priceUnit: l.unit ?? 'TOTAL',
        quantityAvailable: kind === 'PRODUCT' && l.condition === 'NEW' ? 5 : 1,
        attributes: l.attributes,
        district: s.district,
        area: s.area,
        deliveryModes: deliveryModes(kind),
        mediaIds,
      },
    }),
    201,
    `create "${l.title}"`,
  );
  const id = listing.data.id;
  await expectStatus(
    api('POST', `/api/v1/listings/${id}/publish`, { token: user.token }),
    200,
    `publish "${l.title}"`,
  );
  if (l.rental) {
    const r = l.rental;
    // The rental service learns about the listing from an event, so it may take a moment.
    await eventually(`rental terms for "${l.title}"`, async () => {
      const res = await api('PUT', `/api/v1/listings/${id}/rental-terms`, {
        token: user.token,
        body: {
          instantBook: r.instantBook ?? false,
          minDurationHours: r.minHours,
          maxDurationDays: r.maxDays,
          deposit: r.depositTaka === null ? null : { amount: r.depositTaka * 100, currency: 'BDT' },
          advanceNoticeHours: 24,
          bufferHours: 2,
          cancellationNote: 'Free cancellation up to 48 hours before the start.',
        },
      });
      if (res.status === 200) return true;
      if (res.status !== 404) fail(`rental terms for "${l.title}"`, res.body);
      return false;
    });
  }
  return kind;
}

const DAY = 86_400_000;
/** `{ inDays, hour }` → a Dhaka date-time; `{ inDays }` → a date. */
function when({ inDays, hour }) {
  const day = new Date(Date.now() + inDays * DAY).toISOString().slice(0, 10);
  return hour === undefined ? day : `${day}T${String(hour).padStart(2, '0')}:00:00+06:00`;
}

const resolveDates = (terms) =>
  Object.fromEntries(
    Object.entries(terms).map(([k, v]) => [
      k,
      v && typeof v === 'object' && 'inDays' in v ? when(v) : v,
    ]),
  );

const taka = (n) => (n === undefined ? null : { amount: n * 100, currency: 'BDT' });

async function myNeeds(user) {
  const all = [];
  let cursor;
  do {
    const q = `limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await expectStatus(
      api('GET', `/api/v1/me/needs?${q}`, { token: user.token }),
      200,
      `${user.label} my needs`,
    );
    all.push(...page.data);
    cursor = page.page.nextCursor;
  } while (cursor);
  return all.filter((n) => LIVE_NEEDS.has(n.status));
}

async function postNeed(user, b, n) {
  await expectStatus(
    api('POST', '/api/v1/needs', {
      token: user.token,
      body: {
        mode: n.mode,
        categoryId: n.categoryId,
        title: n.title,
        description: n.description,
        quantity: n.quantity ?? 1,
        ...(n.budget && {
          budget: {
            min: taka(n.budget.min),
            max: taka(n.budget.max),
            flexible: n.budget.flexible,
          },
        }),
        ...(n.condition && { condition: n.condition }),
        attributes: n.attributes,
        modeTerms: resolveDates(n.modeTerms),
        location: { district: b.district, area: n.area },
        deliveryPreference: n.delivery ?? 'EITHER',
        publish: true,
      },
    }),
    201,
    `post need "${n.title}"`,
  );
}

// ------------------------------------------------------------------------------------------------

await requireGateway();

const made = { PRODUCT: 0, RENTAL: 0, SERVICE: 0 };
let skipped = 0;
let withdrawn = 0;
const sessions = loadSessions();
for (const [key, s] of Object.entries(SELLERS)) {
  const user = await session(s, sessions);
  mkdirSync(dirname(SESSIONS), { recursive: true });
  writeFileSync(SESSIONS, JSON.stringify(sessions, null, 2));
  await setUpSeller(user, s);
  const mine = LISTINGS.filter((l) => l.seller === key);
  const wanted = new Set(mine.map((l) => l.title));
  const existing = await myListings(user);
  log(`${s.displayName} (${s.phone}) signed in, ${s.district}`);

  for (const l of existing.filter((x) => !wanted.has(x.title))) {
    const r = await api('POST', `/api/v1/listings/${l.id}/withdraw`, { token: user.token });
    if (r.status === 200) withdrawn++;
    else note(`could not withdraw old listing "${l.title}" (${r.status})`);
  }

  const have = new Set(existing.map((x) => x.title));
  for (const l of mine) {
    if (have.has(l.title)) {
      skipped++;
      continue;
    }
    const kind = await createListing(user, s, l);
    made[kind]++;
    log(`${kind.toLowerCase()}: ${l.title} — ৳${l.price.toLocaleString('en-US')}`);
  }
}

let needsPosted = 0;
let needsClosed = 0;
for (const [key, b] of Object.entries(BUYERS)) {
  const user = await session(b, sessions);
  writeFileSync(SESSIONS, JSON.stringify(sessions, null, 2));
  await expectStatus(
    api('PATCH', '/api/v1/me/profile', {
      token: user.token,
      body: { displayName: b.displayName, userType: 'INDIVIDUAL', district: b.district },
    }),
    200,
    `${b.displayName} profile`,
  );
  const mine = NEEDS.filter((n) => n.buyer === key);
  const wanted = new Set(mine.map((n) => n.title));
  const existing = await myNeeds(user);
  log(`${b.displayName} (${b.phone}) signed in, ${b.district}`);

  for (const n of existing.filter((x) => !wanted.has(x.title))) {
    const r = await api('POST', `/api/v1/needs/${n.id}/close`, { token: user.token });
    if (r.status === 200) needsClosed++;
    else note(`could not close old need "${n.title}" (${r.status})`);
  }

  const have = new Set(existing.map((x) => x.title));
  for (const n of mine) {
    if (have.has(n.title)) {
      skipped++;
      continue;
    }
    await postNeed(user, b, n);
    needsPosted++;
    log(`need (${n.mode.toLowerCase()}): ${n.title}`);
  }
}

if (withdrawn) note(`withdrew ${withdrawn} old demo listing(s) that are no longer in the data`);
if (needsClosed) note(`closed ${needsClosed} old demo need(s) that are no longer in the data`);
if (skipped) note(`${skipped} listing(s) or need(s) already existed and were skipped`);
console.log(
  `\nCreated ${made.PRODUCT} product(s), ${made.RENTAL} rental(s), ${made.SERVICE} service(s) ` +
    `and ${needsPosted} need(s); the data has ${LISTINGS.length} listings and ${NEEDS.length} needs.`,
);
