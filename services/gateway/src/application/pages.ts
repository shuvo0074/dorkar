import { Districts, type District, type NeedMode } from '@dorkar/contracts';
import type { Upstream } from '../route-table';

/**
 * Public pages, prerendered for search engines and link previews. The web app is a client-rendered
 * SPA, so without this every URL answers with the same empty shell: the same title, no
 * description of the need or listing, nothing for a crawler to read. Here the gateway reads the
 * public API (as an anonymous visitor would) and fills in the shell's head (title, description,
 * canonical, Open Graph, JSON-LD) and a plain HTML snapshot of the content inside `#root`, which
 * the app replaces as soon as it mounts. Everyone gets the same HTML: no user-agent sniffing.
 */

/** Reads a public API resource from its service: null when it is not there (or not public). */
export interface PublicReader {
  get<T>(upstream: Upstream, path: string): Promise<T | null>;
}

export interface Page {
  status: 200 | 404;
  /** Null keeps the shell's own title and description (the home page's). */
  title: string | null;
  description: string | null;
  /** Canonical path (no query). */
  path: string;
  index: boolean;
  type: 'website' | 'article' | 'product' | 'profile';
  jsonLd?: Record<string, unknown> | undefined;
  /** HTML for inside `#root`; already escaped. */
  body: string;
}

// ------------------------------------------------------------------ public API shapes (subset)

interface Money {
  amount: number;
  currency: string;
}
interface Need {
  id: string;
  mode: NeedMode;
  title: string;
  description: string | null;
  quantity: number;
  budget: { min: Money | null; max: Money | null };
  location: { district: string; area: string | null };
  status: string;
  offerCount: number;
  expiresAt: string | null;
  publishedAt: string | null;
}
interface Listing {
  id: string;
  sellerId: string;
  kind: string;
  condition: string | null;
  title: string;
  description: string;
  price: Money;
  priceUnit: string;
  quantityAvailable: number;
  district: string;
  area: string | null;
  status: string;
  updatedAt: string;
}
interface Auction {
  id: string;
  kind: 'FORWARD' | 'REVERSE';
  title: string;
  district: string;
  mode: NeedMode;
  quantity: number;
  startPrice: Money;
  leadingAmount: Money | null;
  bidCount: number;
  startsAt: string;
  endsAt: string;
  status: string;
  hidden: boolean;
}
interface LendItem {
  id: string;
  title: string;
  description: string;
  condition: string;
  district: string;
  deposit: Money | null;
  maxLoanDays: number;
  active: boolean;
  hidden?: boolean;
  updatedAt: string;
}
interface Profile {
  id: string;
  displayName: string;
  userType: 'INDIVIDUAL' | 'BUSINESS';
  bio: string | null;
  district: string | null;
  memberSince: string;
  reputation: { ratingAverage: number | null; ratingCount: number; completedCount: number } | null;
}
interface One<T> {
  data: T;
}
export interface PageOf<T> {
  data: T[];
  page: { nextCursor: string | null };
}

// ------------------------------------------------------------------ text helpers

const SITE = 'Dorkar';

export const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** At most `max` characters, cut at a word where possible. */
export function clip(s: string, max = 160): string {
  const t = squash(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

const takaFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const taka = (m: Money) => `৳${takaFmt.format(m.amount / 100)}`;
const decimal = (m: Money) => (m.amount / 100).toFixed(2);

const district = (d: string | null | undefined) =>
  d ? (Districts[d as District]?.en ?? d) : 'Bangladesh';
const place = (area: string | null, d: string) => [area, district(d)].filter(Boolean).join(', ');

const MODE_PHRASE: Record<NeedMode, string> = {
  BUY: 'Wanted to buy',
  RENT: 'Wanted to rent',
  BORROW: 'Wanted to borrow',
  HIRE: 'Looking to hire',
  SOURCE: 'Looking to source',
};
const PRICE_UNIT: Record<string, string> = {
  TOTAL: '',
  PER_UNIT: ' each',
  PER_HOUR: ' an hour',
  PER_DAY: ' a day',
};
const CONDITION: Record<string, string> = {
  NEW: 'New',
  USED: 'Used',
  REFURBISHED: 'Refurbished',
};
const SCHEMA_CONDITION: Record<string, string> = {
  NEW: 'https://schema.org/NewCondition',
  USED: 'https://schema.org/UsedCondition',
  REFURBISHED: 'https://schema.org/RefurbishedCondition',
};

function budgetText(b: Need['budget']): string | null {
  if (b.min && b.max) return `${taka(b.min)} to ${taka(b.max)}`;
  if (b.max) return `up to ${taka(b.max)}`;
  if (b.min) return `from ${taka(b.min)}`;
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Paragraphs for a free-text field, escaped. */
const paragraphs = (s: string | null) =>
  (s ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

const SITE_NAV =
  '<nav aria-label="Dorkar"><ul>' +
  '<li><a href="/needs">Needs</a></li>' +
  '<li><a href="/listings">Listings</a></li>' +
  '<li><a href="/auctions">Auctions</a></li>' +
  '<li><a href="/lend">Lending</a></li>' +
  '</ul></nav>';

const main = (inner: string) => `<main>${inner}</main>${SITE_NAV}`;

const linkList = <T extends { id: string; title: string }>(
  base: string,
  items: T[],
  extra: (x: T) => string,
) =>
  items.length
    ? `<ul>${items
        .map(
          (x) =>
            `<li><a href="${base}/${encodeURIComponent(x.id)}">${escapeHtml(x.title)}</a> ${escapeHtml(extra(x))}</li>`,
        )
        .join('')}</ul>`
    : '<p>Nothing here yet.</p>';

const notFound = (path: string): Page => ({
  status: 404,
  title: `Not found | ${SITE}`,
  description: null,
  path,
  index: false,
  type: 'website',
  body: '',
});

// ------------------------------------------------------------------ pages

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPEN_AUCTION = new Set(['SCHEDULED', 'OPEN', 'CLOSING']);

const needLine = (n: Need) =>
  `· ${MODE_PHRASE[n.mode] ?? n.mode}, ${district(n.location.district)}` +
  (budgetText(n.budget) ? `, ${budgetText(n.budget)}` : '');
const listingLine = (l: Listing) =>
  `· ${taka(l.price)}${PRICE_UNIT[l.priceUnit] ?? ''}, ${district(l.district)}`;
const auctionLine = (a: Auction) =>
  `· ${a.kind === 'FORWARD' ? 'Selling' : 'Buying'}, ${district(a.district)}, ends ${a.endsAt.slice(0, 10)}`;
const lendLine = (i: LendItem) =>
  `· ${district(i.district)}, up to ${plural(i.maxLoanDays, 'day')}`;

async function home(read: PublicReader): Promise<Page> {
  const needs = await read.get<PageOf<Need>>('demand', '/api/v1/needs?limit=12');
  return {
    status: 200,
    title: null,
    description: null,
    path: '/',
    index: true,
    type: 'website',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE,
      alternateName: 'দরকার',
    },
    body: main(
      '<h1>What do you need?</h1>' +
        '<p>Post what you need, and sellers, shops and service providers across Bangladesh come to you with offers. Buy, rent, borrow, hire or source.</p>' +
        '<h2>Recently posted needs</h2>' +
        linkList('/needs', needs?.data ?? [], needLine) +
        '<p><a href="/needs">All needs</a></p>',
    ),
  };
}

const listPage = async <T extends { id: string; title: string }>(
  read: PublicReader,
  o: {
    upstream: Upstream;
    api: string;
    path: string;
    title: string;
    heading: string;
    description: string;
    line: (x: T) => string;
  },
): Promise<Page> => {
  const page = await read.get<PageOf<T>>(o.upstream, `${o.api}?limit=24`);
  return {
    status: 200,
    title: `${o.title} | ${SITE}`,
    description: o.description,
    path: o.path,
    index: true,
    type: 'website',
    body: main(
      `<h1>${escapeHtml(o.heading)}</h1><p>${escapeHtml(o.description)}</p>` +
        linkList(o.path, page?.data ?? [], o.line),
    ),
  };
};

async function need(read: PublicReader, id: string, path: string): Promise<Page> {
  const n = (await read.get<One<Need>>('demand', `/api/v1/needs/${id}`))?.data;
  if (!n) return notFound(path);
  const phrase = MODE_PHRASE[n.mode] ?? n.mode;
  const where = place(n.location.area, n.location.district);
  const budget = budgetText(n.budget);
  const facts = [
    `${phrase} in ${where}.`,
    n.quantity > 1 ? `Quantity ${n.quantity}.` : '',
    budget ? `Budget ${budget}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    status: 200,
    title: `${clip(n.title, 70)} · ${phrase} in ${district(n.location.district)} | ${SITE}`,
    description: clip(`${facts} ${n.description ?? ''}`),
    path,
    index: n.status === 'OPEN',
    type: 'article',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Demand',
      name: n.title,
      ...(n.description ? { description: clip(n.description, 500) } : {}),
      areaServed: { '@type': 'AdministrativeArea', name: district(n.location.district) },
      eligibleQuantity: { '@type': 'QuantitativeValue', value: n.quantity },
      ...(n.budget.min || n.budget.max
        ? {
            priceSpecification: {
              '@type': 'PriceSpecification',
              priceCurrency: 'BDT',
              ...(n.budget.min ? { minPrice: decimal(n.budget.min) } : {}),
              ...(n.budget.max ? { maxPrice: decimal(n.budget.max) } : {}),
            },
          }
        : {}),
      ...(n.publishedAt ? { availabilityStarts: n.publishedAt } : {}),
      ...(n.expiresAt ? { availabilityEnds: n.expiresAt } : {}),
    },
    body: main(
      '<article><p><a href="/needs">Needs</a></p>' +
        `<h1>${escapeHtml(n.title)}</h1>` +
        `<p>${escapeHtml(facts)}</p>` +
        paragraphs(n.description) +
        `<p>${escapeHtml(plural(n.offerCount, 'offer'))} so far.</p></article>`,
    ),
  };
}

async function listing(read: PublicReader, id: string, path: string): Promise<Page> {
  const l = (await read.get<One<Listing>>('catalog', `/api/v1/listings/${id}`))?.data;
  if (!l) return notFound(path);
  const price = `${taka(l.price)}${PRICE_UNIT[l.priceUnit] ?? ''}`;
  const where = place(l.area, l.district);
  const condition = l.condition ? CONDITION[l.condition] : undefined;
  const facts = [price, condition, where].filter(Boolean).join(' · ');
  const inStock = l.status === 'PUBLISHED' && l.quantityAvailable > 0;
  return {
    status: 200,
    title: `${clip(l.title, 70)} · ${price} in ${district(l.district)} | ${SITE}`,
    description: clip(`${facts}. ${l.description}`),
    path,
    index: l.status === 'PUBLISHED' || l.status === 'SOLD_OUT',
    type: 'product',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: l.title,
      description: clip(l.description, 500),
      offers: {
        '@type': 'Offer',
        price: decimal(l.price),
        priceCurrency: 'BDT',
        availability: inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        ...(l.condition && SCHEMA_CONDITION[l.condition]
          ? { itemCondition: SCHEMA_CONDITION[l.condition] }
          : {}),
        areaServed: { '@type': 'AdministrativeArea', name: district(l.district) },
      },
    },
    body: main(
      '<article><p><a href="/listings">Listings</a></p>' +
        `<h1>${escapeHtml(l.title)}</h1>` +
        `<p>${escapeHtml(facts)}</p>` +
        paragraphs(l.description) +
        `<p><a href="/users/${encodeURIComponent(l.sellerId)}">The seller</a></p></article>`,
    ),
  };
}

async function auction(read: PublicReader, id: string, path: string): Promise<Page> {
  const a = (await read.get<One<Auction>>('bidding', `/api/v1/auctions/${id}`))?.data;
  if (!a || a.hidden) return notFound(path);
  const what = a.kind === 'FORWARD' ? 'Auction' : 'Reverse auction';
  const price = a.leadingAmount
    ? `Leading bid ${taka(a.leadingAmount)} (${plural(a.bidCount, 'bid')})`
    : `Starts at ${taka(a.startPrice)}`;
  const facts = `${what} in ${district(a.district)}. ${price}. Ends ${a.endsAt.slice(0, 10)}.`;
  return {
    status: 200,
    title: `${clip(a.title, 70)} · ${what} | ${SITE}`,
    description: clip(facts),
    path,
    index: OPEN_AUCTION.has(a.status),
    type: 'article',
    body: main(
      '<article><p><a href="/auctions">Auctions</a></p>' +
        `<h1>${escapeHtml(a.title)}</h1><p>${escapeHtml(facts)}</p></article>`,
    ),
  };
}

async function lendItem(read: PublicReader, id: string, path: string): Promise<Page> {
  const i = (await read.get<One<LendItem>>('lending', `/api/v1/lend-items/${id}`))?.data;
  if (!i || i.hidden) return notFound(path);
  const facts = [
    `To borrow in ${district(i.district)}`,
    CONDITION[i.condition],
    `up to ${plural(i.maxLoanDays, 'day')}`,
    i.deposit ? `deposit ${taka(i.deposit)}` : 'no deposit',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    status: 200,
    title: `${clip(i.title, 70)} · To borrow in ${district(i.district)} | ${SITE}`,
    description: clip(`${facts}. ${i.description}`),
    path,
    index: i.active,
    type: 'article',
    body: main(
      '<article><p><a href="/lend">Lending</a></p>' +
        `<h1>${escapeHtml(i.title)}</h1><p>${escapeHtml(facts)}</p>` +
        paragraphs(i.description) +
        '</article>',
    ),
  };
}

async function profile(read: PublicReader, id: string, path: string): Promise<Page> {
  const p = (await read.get<One<Profile>>('profile', `/api/v1/users/${id}`))?.data;
  if (!p) return notFound(path);
  const business = p.userType === 'BUSINESS';
  const r = p.reputation;
  const facts = [
    business ? 'Business' : 'Member',
    p.district ? district(p.district) : null,
    `on Dorkar since ${p.memberSince.slice(0, 4)}`,
    r?.completedCount ? plural(r.completedCount, 'completed deal') : null,
    r && r.ratingAverage !== null && r.ratingCount
      ? `rated ${r.ratingAverage.toFixed(1)} from ${plural(r.ratingCount, 'review')}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    status: 200,
    title: `${clip(p.displayName, 60)} | ${SITE}`,
    description: clip(`${facts}. ${p.bio ?? ''}`),
    path,
    // Businesses want to be found; a private person's name and district stay out of search.
    index: business,
    type: 'profile',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      dateCreated: p.memberSince,
      mainEntity: {
        '@type': business ? 'Organization' : 'Person',
        name: p.displayName,
        ...(p.bio ? { description: clip(p.bio, 500) } : {}),
      },
    },
    body: main(
      `<article><h1>${escapeHtml(p.displayName)}</h1><p>${escapeHtml(facts)}</p>` +
        paragraphs(p.bio) +
        '</article>',
    ),
  };
}

/**
 * The page for a path, or null for anything that is not a public page (sign-in, account, the
 * desk, forms, unknown paths): those get the plain shell, kept out of search.
 */
export async function resolvePage(read: PublicReader, pathname: string): Promise<Page | null> {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return home(read);
  if (path === '/needs')
    return listPage<Need>(read, {
      upstream: 'demand',
      api: '/api/v1/needs',
      path,
      title: 'Needs',
      heading: 'What people need',
      description:
        'Open needs posted across Bangladesh: things to buy, rent or borrow and people to hire. Make an offer.',
      line: needLine,
    });
  if (path === '/listings')
    return listPage<Listing>(read, {
      upstream: 'catalog',
      api: '/api/v1/listings',
      path,
      title: 'Listings',
      heading: 'Listings',
      description:
        'Products, rentals and services listed by sellers, shops and providers across Bangladesh.',
      line: listingLine,
    });
  if (path === '/auctions')
    return listPage<Auction>(read, {
      upstream: 'bidding',
      api: '/api/v1/auctions',
      path,
      title: 'Auctions',
      heading: 'Auctions',
      description:
        'Open auctions on Dorkar: bid on what sellers offer, or offer on what buyers need.',
      line: auctionLine,
    });
  if (path === '/lend')
    return listPage<LendItem>(read, {
      upstream: 'lending',
      api: '/api/v1/lend-items',
      path,
      title: 'Borrow from neighbours',
      heading: 'Things to borrow',
      description: 'Tools, gear and household things neighbours across Bangladesh lend.',
      line: lendLine,
    });

  const m = /^\/(needs|listings|auctions|lend|users)\/([^/]+)$/.exec(path);
  if (!m || !UUID.test(m[2]!)) return null;
  const id = m[2]!.toLowerCase();
  const canonical = `/${m[1]}/${id}`;
  switch (m[1]) {
    case 'needs':
      return need(read, id, canonical);
    case 'listings':
      return listing(read, id, canonical);
    case 'auctions':
      return auction(read, id, canonical);
    case 'lend':
      return lendItem(read, id, canonical);
    default:
      return profile(read, id, canonical);
  }
}

// ------------------------------------------------------------------ rendering

/** JSON for inside a <script> element: nothing in it can close the element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const meta = (attr: 'name' | 'property', key: string, content: string) =>
  `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`;

const SHELL_TITLE = /<title>([\s\S]*?)<\/title>/;
const SHELL_DESCRIPTION = /<meta\s+name="description"\s+content="([\s\S]*?)"\s*\/?>/;

/**
 * The web app's index.html with the page's head and snapshot filled in. `page` null is the plain
 * shell for a page that is not public: unchanged, except that search engines are told to skip it.
 */
export function renderPage(shell: string, page: Page | null, origin: string): string {
  if (!page) {
    return shell.replace('</head>', `    ${meta('name', 'robots', 'noindex')}\n  </head>`);
  }
  const shellTitle = SHELL_TITLE.exec(shell)?.[1]?.trim() ?? SITE;
  const shellDescription = SHELL_DESCRIPTION.exec(shell)?.[1]?.trim() ?? '';
  const title = page.title ?? shellTitle;
  const description = page.description ?? squash(shellDescription);
  const url = `${origin}${page.path}`;

  const head = [
    `<link rel="canonical" href="${escapeHtml(url)}" />`,
    page.index ? null : meta('name', 'robots', 'noindex'),
    meta('property', 'og:site_name', SITE),
    meta('property', 'og:type', page.type),
    meta('property', 'og:title', title),
    meta('property', 'og:description', description),
    meta('property', 'og:url', url),
    meta('name', 'twitter:card', 'summary'),
    page.jsonLd ? `<script type="application/ld+json">${scriptJson(page.jsonLd)}</script>` : null,
  ]
    .filter(Boolean)
    .map((l) => `    ${l}`)
    .join('\n');

  let html = shell;
  if (page.title !== null)
    html = html.replace(SHELL_TITLE, () => `<title>${escapeHtml(page.title!)}</title>`);
  if (page.description !== null) {
    html = html.replace(
      SHELL_DESCRIPTION,
      () => `<meta name="description" content="${escapeHtml(page.description!)}" />`,
    );
  }
  html = html.replace('</head>', () => `${head}\n  </head>`);
  return html.replace('<div id="root"></div>', () => `<div id="root">${page.body}</div>`);
}

// ------------------------------------------------------------------ robots and sitemap

/** Paths that are never useful in search: personal pages, staff tools and forms. */
const PRIVATE = [
  '/account',
  '/dashboard',
  '/desk',
  '/my/',
  '/sign-in',
  '/deals',
  '/offers',
  '/inbox',
  '/messages',
  '/disputes',
  '/bookings',
  '/loans',
  '/*/new',
  '/*/edit',
];

export const robotsTxt = (origin: string) =>
  [
    'User-agent: *',
    ...PRIVATE.map((p) => `Disallow: ${p}`),
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');

const SITEMAP_SOURCES: Array<{ upstream: Upstream; api: string; base: string; lastmod: string }> = [
  { upstream: 'demand', api: '/api/v1/needs', base: '/needs', lastmod: 'publishedAt' },
  { upstream: 'catalog', api: '/api/v1/listings', base: '/listings', lastmod: 'updatedAt' },
  { upstream: 'bidding', api: '/api/v1/auctions', base: '/auctions', lastmod: 'startsAt' },
  { upstream: 'lending', api: '/api/v1/lend-items', base: '/lend', lastmod: 'updatedAt' },
];

/**
 * A sitemap of the public pages and the newest open items of each kind (each feed lists only
 * what is open: open needs, published listings, open auctions, active lend items).
 */
export async function sitemapXml(
  read: PublicReader,
  origin: string,
  perKind = 1_000,
): Promise<string> {
  const urls: Array<{ loc: string; lastmod?: unknown }> = [
    { loc: '/' },
    { loc: '/needs' },
    { loc: '/listings' },
    { loc: '/auctions' },
    { loc: '/lend' },
  ];
  const lists = await Promise.all(
    SITEMAP_SOURCES.map(async (s) => {
      const out: typeof urls = [];
      let cursor: string | null = null;
      do {
        const q: string = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page: PageOf<Record<string, unknown> & { id: string }> | null = await read.get(
          s.upstream,
          `${s.api}${q}`,
        );
        for (const x of page?.data ?? []) {
          out.push({ loc: `${s.base}/${encodeURIComponent(x.id)}`, lastmod: x[s.lastmod] });
        }
        cursor = page?.page.nextCursor ?? null;
      } while (cursor && out.length < perKind);
      return out.slice(0, perKind);
    }),
  );
  const entries = [...urls, ...lists.flat()]
    .map(
      (u) =>
        `  <url><loc>${escapeHtml(origin + u.loc)}</loc>${
          typeof u.lastmod === 'string'
            ? `<lastmod>${escapeHtml(u.lastmod.slice(0, 10))}</lastmod>`
            : ''
        }</url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}
