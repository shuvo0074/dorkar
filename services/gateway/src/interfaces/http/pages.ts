import { stat, readFile } from 'node:fs/promises';
import type { App } from '@dorkar/kernel';
import {
  renderPage,
  resolvePage,
  robotsTxt,
  sitemapXml,
  type PublicReader,
} from '../../application/pages';

export interface PagesOptions {
  /** The built web app's index.html. Re-read when it changes, so a web deploy needs no restart. */
  shellPath: string;
  /** The site's public origin, for canonical URLs and the sitemap (no trailing slash). */
  origin: string;
  reader: PublicReader;
  pageTtlMs?: number;
  sitemapTtlMs?: number;
  maxEntries?: number;
}

/** Paths the gateway answers itself or that are files; never the app shell. */
const NOT_A_PAGE = /^\/(api|\.well-known|health|metrics|docs)(\/|$)|\/[^/]*\.[a-z0-9]+$/i;

interface Rendered {
  status: number;
  html: string;
  public: boolean;
}

/**
 * Serves the web app's HTML for page navigations: public pages prerendered (see
 * application/pages), everything else the plain shell. The reverse proxy serves the app's static
 * files itself and sends every other non-API GET here.
 */
export async function registerPages(app: App, opts: PagesOptions): Promise<void> {
  const origin = opts.origin.replace(/\/+$/, '');
  const pageTtl = opts.pageTtlMs ?? 60_000;
  const sitemapTtl = opts.sitemapTtlMs ?? 10 * 60_000;
  const maxEntries = opts.maxEntries ?? 1_000;

  // The shell, checked for changes at most every few seconds.
  let shell = { html: await readFile(opts.shellPath, 'utf8'), mtimeMs: 0, checkedAt: 0 };
  shell.mtimeMs = (await stat(opts.shellPath)).mtimeMs;
  const cache = new Map<string, { at: number; value: Promise<Rendered> }>();
  const currentShell = async () => {
    if (Date.now() - shell.checkedAt < 5_000) return shell.html;
    shell.checkedAt = Date.now();
    try {
      const { mtimeMs } = await stat(opts.shellPath);
      if (mtimeMs !== shell.mtimeMs) {
        shell = { html: await readFile(opts.shellPath, 'utf8'), mtimeMs, checkedAt: Date.now() };
        cache.clear();
      }
    } catch (err) {
      app.log.warn({ err }, 'web shell unreadable; serving the last good copy');
    }
    return shell.html;
  };

  /** Same-key requests share one render; failures are not kept. */
  const cached = (key: string, ttl: number, make: () => Promise<Rendered>) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = make();
    value.catch(() => cache.delete(key));
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), value });
    return value;
  };

  app.get('/robots.txt', { schema: { hide: true } }, async (_req, reply) =>
    reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(robotsTxt(origin)),
  );

  app.get('/sitemap.xml', { schema: { hide: true } }, async (_req, reply) => {
    const r = await cached('sitemap', sitemapTtl, async () => ({
      status: 200,
      html: await sitemapXml(opts.reader, origin),
      public: true,
    }));
    return reply
      .header('content-type', 'application/xml; charset=utf-8')
      .header('cache-control', 'public, max-age=600')
      .send(r.html);
  });

  app.get('/*', { schema: { hide: true } }, async (req, reply) => {
    const { pathname } = new URL(req.url, 'http://gateway');
    if (NOT_A_PAGE.test(pathname)) return reply.callNotFound();
    const html = await currentShell();
    let r: Rendered;
    try {
      r = await cached(`page:${pathname}`, pageTtl, async () => {
        const page = await resolvePage(opts.reader, pathname);
        return {
          status: page?.status ?? 200,
          html: renderPage(html, page, origin),
          public: page !== null,
        };
      });
    } catch (err) {
      // The app still works without the snapshot: serve the shell rather than an error page.
      req.log.warn({ err, pathname }, 'prerender failed; serving the plain shell');
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(html);
    }
    return reply
      .code(r.status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', r.public ? 'public, max-age=60' : 'no-cache')
      .send(r.html);
  });
}
