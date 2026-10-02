import type { AccountStatus, ActivityEvents, EventEnvelope } from '@dorkar/contracts';
import { decodeCursor, Errors, paginate, type RequestContext } from '@dorkar/kernel';
import type { z } from 'zod';
import {
  EXPORT_COLUMNS,
  EXPORT_MAX_ROWS,
  normalizeTargetType,
  type ActivityEntry,
  type ActivityFilter,
  type MyActivityScope,
} from '../domain/activity';
import { csvRow } from '../domain/csv';
import { labelFor } from '../domain/labels';
import type { ActivityStore, ActivityUnitOfWork, Facets } from './ports';

type ActivityRecorded = z.output<(typeof ActivityEvents)['ActivityRecorded']['schema']>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const EXPORT_PAGE = 1_000;
const keyOf = (e: ActivityEntry) => ({ k: e.occurredAt.toISOString(), id: e.id });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Activity cursors are (ISO time, uuid); anything else is a client error, not a DB error. */
function cursorOf(raw: string | undefined) {
  const c = decodeCursor(raw);
  if (c && (typeof c.k !== 'string' || Number.isNaN(Date.parse(c.k)) || !UUID.test(c.id))) {
    throw Errors.validation('Invalid cursor.');
  }
  return c;
}

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** The cross-service activity log: ingestion, admin queries, export, and the member's own view. */
export class ActivityService {
  constructor(
    private readonly uow: ActivityUnitOfWork,
    private readonly opts: { retentionDays: number; now: () => Date },
  ) {}

  async list(filter: ActivityFilter, cursor: string | undefined, limit: number) {
    const rows = await this.uow.store.list(this.normalize(filter), cursorOf(cursor), limit + 1);
    return paginate(rows, limit, keyOf);
  }

  async get(id: string): Promise<ActivityEntry> {
    const e = await this.uow.store.get(id);
    if (!e) throw Errors.notFound('Activity');
    return e;
  }

  async facets(days: number): Promise<Facets & { since: Date }> {
    const since = new Date(this.opts.now().getTime() - days * 24 * 60 * 60 * 1000);
    return { since, ...(await this.uow.store.facets(since, 500)) };
  }

  /**
   * CSV export, at most 10,000 rows, read in keyset pages so memory stays flat. The export is
   * audited (with its filters) before the first byte is produced.
   */
  async export(filter: ActivityFilter, ctx: RequestContext): Promise<AsyncIterable<string>> {
    requireActor(ctx);
    const f = this.normalize(filter);
    await this.uow.transaction((s) =>
      s.audit(ctx, {
        action: 'activity.exported',
        actorType: 'ADMIN',
        targetType: 'ACTIVITY_LOG',
        metadata: { filters: describeFilter(f), maxRows: EXPORT_MAX_ROWS },
      }),
    );
    const store = this.uow.store;
    return (async function* () {
      yield csvRow(EXPORT_COLUMNS);
      let cursor = null as ReturnType<typeof decodeCursor>;
      let sent = 0;
      while (sent < EXPORT_MAX_ROWS) {
        const rows = await store.list(f, cursor, Math.min(EXPORT_PAGE, EXPORT_MAX_ROWS - sent));
        for (const e of rows) {
          yield csvRow([
            e.occurredAt,
            e.service,
            e.action,
            labelFor(e.action),
            e.actorType,
            e.actorId,
            e.actorName,
            e.targetType,
            e.targetId,
            e.requestId,
            e.ipHash,
            e.metadata,
          ]);
        }
        sent += rows.length;
        const last = rows.at(-1);
        if (!last || rows.length < EXPORT_PAGE) break;
        cursor = keyOf(last);
      }
    })();
  }

  /** `mine`: what I did. `about-me`: what staff did to my account (staff stay anonymous). */
  async mine(
    scope: MyActivityScope,
    cursor: string | undefined,
    limit: number,
    ctx: RequestContext,
  ): Promise<Page<ActivityEntry>> {
    const actor = requireActor(ctx);
    const c = cursorOf(cursor);
    const rows =
      scope === 'mine'
        ? await this.uow.store.list({ actorId: actor.id }, c, limit + 1)
        : await this.uow.store.listAboutAccount(actor.id, c, limit + 1);
    return paginate(rows, limit, keyOf);
  }

  /** Deletes expired rows in batches until none are left (or `maxBatches` is reached). */
  async purgeExpired(store: ActivityStore, batchSize = 5_000, maxBatches = 50): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const n = await store.purgeBatch(this.opts.retentionDays, batchSize);
      total += n;
      if (n < batchSize) break;
    }
    return total;
  }

  // ---- event handlers (inside the inbox transaction) ----

  async onActivityRecorded(
    s: ActivityStore,
    p: ActivityRecorded,
    e: Pick<EventEnvelope, 'producer'>,
  ): Promise<void> {
    await s.record({
      id: p.auditId,
      service: e.producer,
      occurredAt: new Date(p.occurredAt),
      actorId: p.actorId,
      actorType: p.actorType,
      action: p.action,
      targetType: normalizeTargetType(p.targetType),
      targetId: p.targetId,
      requestId: p.requestId,
      ipHash: p.ipHash,
      metadata: p.metadata,
    });
  }

  async onProfileUpdated(
    s: ActivityStore,
    p: { accountId: string; displayName: string },
    e: Pick<EventEnvelope, 'occurredAt'>,
  ): Promise<void> {
    await s.setActorName(p.accountId, p.displayName, new Date(e.occurredAt));
  }

  /** Deleted accounts lose their name in the log (privacy: pseudonymised, ids kept). */
  async onAccountStatusChanged(
    s: ActivityStore,
    p: { accountId: string; to: AccountStatus },
  ): Promise<void> {
    if (p.to === 'DELETED') await s.forgetActorName(p.accountId);
  }

  private normalize(f: ActivityFilter): ActivityFilter {
    if (f.from && f.to && f.from > f.to) {
      throw Errors.validation('`from` must be before `to`.');
    }
    return { ...f, targetType: normalizeTargetType(f.targetType) ?? undefined };
  }
}

const describeFilter = (f: ActivityFilter): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === null) continue;
    out[k] = v instanceof Date ? v.toISOString() : String(v);
  }
  return out;
};
