import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGateway, startUpstream, type Harness, type Upstream } from './harness';

const ORIGIN = 'https://dorkar.example';
const SHELL = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="description"
      content="Dorkar (দরকার): tell us what you need."
    />
    <title>Dorkar — Tell us what you need</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const NEED = randomUUID();
const CLOSED_NEED = randomUUID();
const LISTING = randomUUID();
const PERSON = randomUUID();
const SHOP = randomUUID();

const need = (over: Record<string, unknown> = {}) => ({
  id: NEED,
  mode: 'BUY',
  title: 'Used iPhone 13 <128GB>',
  description: 'Good battery, box preferred.\n\nCan pick up in Dhanmondi.',
  quantity: 1,
  budget: {
    min: { amount: 5_000_000, currency: 'BDT' },
    max: { amount: 6_500_000, currency: 'BDT' },
  },
  location: { district: 'dhaka', area: 'Dhanmondi' },
  status: 'OPEN',
  offerCount: 2,
  expiresAt: '2026-11-20T00:00:00.000Z',
  publishedAt: '2026-10-20T08:00:00.000Z',
  ...over,
});
const listing = {
  id: LISTING,
  sellerId: SHOP,
  kind: 'PRODUCT',
  condition: 'USED',
  title: 'Walton fridge "frost free"',
  description: 'Two years old. Works perfectly.',
  price: { amount: 2_500_000, currency: 'BDT' },
  priceUnit: 'TOTAL',
  quantityAvailable: 1,
  district: 'chattogram',
  area: null,
  status: 'PUBLISHED',
  updatedAt: '2026-10-18T08:00:00.000Z',
};
const profile = (id: string, userType: string) => ({
  id,
  displayName: userType === 'BUSINESS' ? 'Rahim Electronics' : 'Karim',
  userType,
  bio: null,
  district: 'dhaka',
  memberSince: '2025-03-01T00:00:00.000Z',
  reputation: { ratingAverage: 4.5, ratingCount: 8, completedCount: 10 },
});

/** One fake service answering the public API the prerender reads. */
async function fakeServices() {
  const app: FastifyInstance = Fastify();
  let failNeeds = false;
  let reads = 0;
  app.addHook('onRequest', async (req) => {
    reads++;
    // No credentials are ever forwarded.
    if (req.headers.authorization || req.headers.cookie) throw new Error('credentials forwarded');
  });
  app.get('/api/v1/needs', async (req) => {
    const cursor = (req.query as { cursor?: string }).cursor;
    return cursor
      ? { data: [need({ id: CLOSED_NEED })], page: { nextCursor: null } }
      : { data: [need()], page: { nextCursor: 'next' } };
  });
  app.get('/api/v1/needs/:id', async (req, reply) => {
    if (failNeeds) return reply.code(503).send({});
    const { id } = req.params as { id: string };
    if (id === NEED) return { data: need() };
    if (id === CLOSED_NEED) return { data: need({ id, status: 'CLOSED' }) };
    return reply.code(404).send({});
  });
  app.get('/api/v1/listings', async () => ({ data: [listing], page: { nextCursor: null } }));
  app.get('/api/v1/listings/:id', async (req, reply) =>
    (req.params as { id: string }).id === LISTING ? { data: listing } : reply.code(404).send({}),
  );
  app.get('/api/v1/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === PERSON) return { data: profile(PERSON, 'INDIVIDUAL') };
    if (id === SHOP) return { data: profile(SHOP, 'BUSINESS') };
    return reply.code(404).send({});
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    app,
    url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
    failNeeds: (v: boolean) => void (failNeeds = v),
    reads: () => reads,
  };
}

let identity: Upstream;
let services: Awaited<ReturnType<typeof fakeServices>>;
let dir: string;
let shellPath: string;
let h: Harness;

beforeAll(async () => {
  [identity, services] = await Promise.all([startUpstream(), fakeServices()]);
  dir = await mkdtemp(join(tmpdir(), 'dorkar-web-'));
  shellPath = join(dir, 'index.html');
  await writeFile(shellPath, SHELL);
  h = await createGateway(identity.url, {
    UPSTREAM_DEMAND_URL: services.url,
    UPSTREAM_CATALOG_URL: services.url,
    UPSTREAM_PROFILE_URL: services.url,
    WEB_INDEX_HTML: shellPath,
    PUBLIC_WEB_ORIGIN: `${ORIGIN}/`,
  });
});
afterAll(async () => {
  await h.close();
  await Promise.all([identity.app.close(), services.app.close()]);
  await rm(dir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  h.gw.app.inject({ url, headers });

describe('prerendered public pages', () => {
  it('fills in a need: title, description, canonical, Open Graph, JSON-LD and a snapshot', async () => {
    const res = await get(`/needs/${NEED.toUpperCase()}?ref=share`, {
      authorization: `Bearer ${await identity.sign()}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const html = res.body;
    expect(html).toContain(
      '<title>Used iPhone 13 &lt;128GB&gt; · Wanted to buy in Dhaka | Dorkar</title>',
    );
    expect(html).not.toContain('Tell us what you need</title>');
    expect(html).toContain(
      '<meta name="description" content="Wanted to buy in Dhanmondi, Dhaka. Budget ৳50,000 to ৳65,000. Good battery, box preferred. Can pick up in Dhanmondi." />',
    );
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/needs/${NEED}" />`);
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).not.toContain('noindex');
    // The app's own scripts are untouched.
    expect(html).toContain('<script type="module" crossorigin src="/assets/index-abc.js">');

    const ld = JSON.parse(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]!,
    );
    expect(ld).toMatchObject({
      '@type': 'Demand',
      name: 'Used iPhone 13 <128GB>',
      priceSpecification: { minPrice: '50000.00', maxPrice: '65000.00', priceCurrency: 'BDT' },
    });
    expect(html).not.toMatch(/ld\+json">[^<]*<128GB/); // `<` escaped inside the script

    const root = /<div id="root">([\s\S]*)<\/div>\s*<\/body>/.exec(html)![1]!;
    expect(root).toContain('<h1>Used iPhone 13 &lt;128GB&gt;</h1>');
    expect(root).toContain('<p>Good battery, box preferred.</p><p>Can pick up in Dhanmondi.</p>');
    expect(root).toContain('2 offers so far.');
  });

  it('keeps closed needs and private people out of search, but indexes businesses', async () => {
    expect((await get(`/needs/${CLOSED_NEED}`)).body).toContain(
      '<meta name="robots" content="noindex" />',
    );
    const person = await get(`/users/${PERSON}`);
    expect(person.body).toContain('<meta name="robots" content="noindex" />');
    const shop = await get(`/users/${SHOP}`);
    expect(shop.body).not.toContain('noindex');
    expect(shop.body).toContain('"@type":"Organization"');
    expect(shop.body).toContain('rated 4.5 from 8 reviews');
  });

  it('describes a listing as a product with its price', async () => {
    const res = await get(`/listings/${LISTING}`);
    expect(res.body).toContain(
      '<title>Walton fridge &quot;frost free&quot; · ৳25,000 in Chattogram | Dorkar</title>',
    );
    expect(res.body).toContain('"@type":"Product"');
    expect(res.body).toContain('"price":"25000.00"');
    expect(res.body).toContain('https://schema.org/UsedCondition');
    expect(res.body).toContain(`<a href="/users/${SHOP}">The seller</a>`);
  });

  it('lists recent items on the feed pages and keeps the home title', async () => {
    const needs = await get('/needs');
    expect(needs.body).toContain('<title>Needs | Dorkar</title>');
    expect(needs.body).toContain(`<a href="/needs/${NEED}">Used iPhone 13 &lt;128GB&gt;</a>`);

    const home = await get('/');
    expect(home.body).toContain('<title>Dorkar — Tell us what you need</title>');
    expect(home.body).toContain(`<link rel="canonical" href="${ORIGIN}/" />`);
    expect(home.body).toContain(
      '<meta property="og:description" content="Dorkar (দরকার): tell us what you need." />',
    );
    expect(home.body).toContain('"@type":"WebSite"');
  });

  it('answers 404 for a missing need, and the plain noindex shell for private pages', async () => {
    const missing = await get(`/needs/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('noindex');
    expect(missing.body).toContain('<div id="root"></div>');

    for (const path of ['/needs/new', `/needs/${NEED}/edit`, '/dashboard', '/desk/categories']) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.body).toContain('<meta name="robots" content="noindex" />');
      expect(res.body).toContain('<title>Dorkar — Tell us what you need</title>');
    }
  });

  it('leaves the API, files and health checks alone', async () => {
    expect((await get('/api/v1/nothing-here')).json().error.code).toBe('NOT_FOUND');
    expect((await get('/assets/missing.js')).statusCode).toBe(404);
    expect((await get('/favicon.svg')).headers['content-type']).toContain('application/json');
    expect((await get('/health/live')).statusCode).toBe(200);
  });

  it('serves the shell, not an error, when a service fails; and does not cache the failure', async () => {
    const other = randomUUID();
    services.failNeeds(true);
    const res = await get(`/needs/${other}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toBe(SHELL);
    services.failNeeds(false);
    expect((await get(`/needs/${other}`)).statusCode).toBe(404);
  });

  it('caches renders briefly, and picks up a new web build without a restart', async () => {
    await get(`/listings/${LISTING}`);
    const before = services.reads();
    await get(`/listings/${LISTING}`);
    expect(services.reads()).toBe(before);

    await writeFile(shellPath, SHELL.replace('index-abc.js', 'index-def.js'));
    const later = new Date(Date.now() + 60_000);
    await utimes(shellPath, later, later);
    const now = Date.now;
    Date.now = () => now() + 6_000; // past the shell re-check interval
    try {
      const res = await get(`/listings/${LISTING}`);
      expect(res.body).toContain('/assets/index-def.js');
    } finally {
      Date.now = now;
      await writeFile(shellPath, SHELL);
    }
  });

  it('serves robots.txt and a sitemap of the open items', async () => {
    const robots = await get('/robots.txt');
    expect(robots.body).toContain('Disallow: /desk');
    expect(robots.body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);

    const sitemap = await get('/sitemap.xml');
    expect(sitemap.headers['content-type']).toBe('application/xml; charset=utf-8');
    expect(sitemap.body).toContain(`<url><loc>${ORIGIN}/</loc></url>`);
    expect(sitemap.body).toContain(
      `<url><loc>${ORIGIN}/needs/${NEED}</loc><lastmod>2026-10-20</lastmod></url>`,
    );
    expect(sitemap.body).toContain(`${ORIGIN}/needs/${CLOSED_NEED}`); // the second page
    expect(sitemap.body).toContain(`${ORIGIN}/listings/${LISTING}`);
  });
});

describe('configuration', () => {
  it('requires the public origin with the web shell', async () => {
    await expect(createGateway(identity.url, { WEB_INDEX_HTML: shellPath })).rejects.toThrow(
      /PUBLIC_WEB_ORIGIN/,
    );
  });
});
