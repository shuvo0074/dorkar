import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_TABLE, Upstreams } from '../../src/route-table';
import { createGateway, startUpstream, type Harness, type Upstream } from './harness';

/** Every service sees only its own paths, including nested resources owned by another service. */
let identity: Upstream;
let demand: Upstream;
let offer: Upstream;
let h: Harness;

beforeAll(async () => {
  [identity, demand, offer] = await Promise.all([
    startUpstream(),
    startUpstream(),
    startUpstream(),
  ]);
  h = await createGateway(identity.url, {
    UPSTREAM_DEMAND_URL: demand.url,
    UPSTREAM_OFFER_URL: offer.url,
  });
});
afterAll(async () => {
  await h.close();
  await Promise.all([identity, demand, offer].map((u) => u.app.close()));
});

const get = (url: string) => h.gw.app.inject({ url });
const lastUrl = (u: Upstream) => u.calls.at(-1)?.url;

describe('route table', () => {
  it('routes a need to demand, and its offers to offer, preserving the full path', async () => {
    const id = randomUUID();
    expect((await get(`/api/v1/needs/${id}?x=1`)).statusCode).toBe(200);
    expect(lastUrl(demand)).toBe(`/api/v1/needs/${id}?x=1`);

    expect((await get(`/api/v1/needs/${id}/offers`)).statusCode).toBe(200);
    expect(lastUrl(offer)).toBe(`/api/v1/needs/${id}/offers`);

    expect((await get(`/api/v1/needs/${id}/offers/abc`)).statusCode).toBe(200);
    expect(lastUrl(offer)).toBe(`/api/v1/needs/${id}/offers/abc`);

    expect((await get('/api/v1/needs')).statusCode).toBe(200);
    expect(lastUrl(demand)).toBe('/api/v1/needs');
  });

  it('keeps routes of unconfigured services disabled (404 at the edge)', async () => {
    const before = [identity, demand, offer].map((u) => u.calls.length);
    expect((await get('/api/v1/reports')).statusCode).toBe(404);
    expect((await get(`/api/v1/needs/${randomUUID()}/matches`)).statusCode).toBe(404);
    expect([identity, demand, offer].map((u) => u.calls.length)).toEqual(before);
  });
});

describe('every configured upstream is wired', () => {
  let all: Upstream;
  let full: Harness;
  beforeAll(async () => {
    all = await startUpstream();
    const env = Object.fromEntries(
      Upstreams.map((u) => [`UPSTREAM_${u.toUpperCase()}_URL`, all.url]),
    );
    full = await createGateway(all.url, env);
  });
  afterAll(async () => {
    await full.close();
    await all.app.close();
  });

  it('proxies every prefix in the route table (none answers 404 at the edge)', async () => {
    const unrouted: string[] = [];
    for (const { prefix } of ROUTE_TABLE) {
      if (!prefix.startsWith('/api/')) continue;
      // A sub-path: the fake upstream's bare /api/v1/me/sessions is deliberately slow.
      const url = `${prefix.replace(/:[A-Za-z]+/g, randomUUID())}/probe`;
      const res = await full.gw.app.inject({ url });
      if (res.statusCode !== 200 || all.calls.at(-1)?.url !== url) unrouted.push(prefix);
    }
    expect(unrouted).toEqual([]);
  });
});
