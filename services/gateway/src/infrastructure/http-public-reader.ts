import type { PublicReader } from '../application/pages';
import type { Upstream } from '../route-table';

const ABSENT = new Set([400, 403, 404, 410]);

/**
 * Reads public API resources straight from the services, anonymously (no credentials are ever
 * forwarded, so a page shows only what any visitor may see). Absent or not-public resources
 * (400, 403, 404, 410) read as null; an unconfigured upstream too. Anything else throws, so a
 * rate-limited or failing upstream never turns a real page into a 404.
 */
export class HttpPublicReader implements PublicReader {
  constructor(
    private readonly upstreams: Record<Upstream, string | undefined>,
    private readonly timeoutMs: number,
  ) {}

  async get<T>(upstream: Upstream, path: string): Promise<T | null> {
    const base = this.upstreams[upstream];
    if (!base) return null;
    const res = await fetch(new URL(path, base), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (ABSENT.has(res.status)) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${upstream} answered ${res.status} for ${path}`);
    }
    return (await res.json()) as T;
  }
}
