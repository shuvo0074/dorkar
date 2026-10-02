import type { EventEnvelope } from '@dorkar/contracts';
import { decodeCursor, Errors, paginate, uuidv7, type RequestContext } from '@dorkar/kernel';
import {
  channelsFor,
  effectivePreferences,
  isDefaultPreference,
  preferenceFor,
  type ChannelPreference,
  type EffectivePreference,
  type Notification,
  type NotificationIntent,
  type NotificationType,
} from '../domain/notification';
import type { NewNotification, NotificationStore, NotificationUnitOfWork } from './ports';

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Notification use cases: event fan-in, the user's inbox, and their channel preferences. */
export class NotificationService {
  constructor(private readonly uow: NotificationUnitOfWork) {}

  // ---- event handling (inside the inbox transaction) ----

  /**
   * Applies preferences and records the notifications an event produced, queueing out-of-band
   * deliveries. Idempotent per (event, recipient, type) even outside the inbox guarantee.
   */
  async onEvent(
    s: NotificationStore,
    event: Pick<EventEnvelope, 'id'>,
    intents: readonly NotificationIntent[],
  ): Promise<number> {
    if (intents.length === 0) return 0;
    const prefs = await s.preferences([...new Set(intents.map((i) => i.recipientId))]);
    const planned: { row: NewNotification; pref: ChannelPreference }[] = [];
    for (const i of intents) {
      const pref = preferenceFor(i.type, prefs.get(i.recipientId));
      if (!pref.inApp && channelsFor(pref).length === 0) continue; // opted out everywhere
      planned.push({
        pref,
        row: {
          id: uuidv7(),
          recipientId: i.recipientId,
          type: i.type,
          payload: i.payload,
          sourceEventId: event.id,
          inApp: pref.inApp,
        },
      });
    }
    if (planned.length === 0) return 0;
    const inserted = await s.insertNotifications(planned.map((p) => p.row));
    await s.queueDeliveries(
      planned
        .filter((p) => inserted.has(p.row.id))
        .flatMap((p) =>
          channelsFor(p.pref).map((channel) => ({ notificationId: p.row.id, channel })),
        ),
    );
    return inserted.size;
  }

  // ---- inbox ----

  async listMine(
    q: { unreadOnly: boolean; cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<{ items: Notification[]; nextCursor: string | null }> {
    const actor = requireActor(ctx);
    const cursor = decodeCursor(q.cursor);
    if (cursor && (typeof cursor.k !== 'string' || Number.isNaN(Date.parse(cursor.k)))) {
      throw Errors.validation('Invalid cursor.');
    }
    const rows = await this.uow.store.list(actor.id, {
      unreadOnly: q.unreadOnly,
      cursor,
      take: q.limit + 1,
    });
    return paginate(rows, q.limit, (n) => ({ k: n.createdAt.toISOString(), id: n.id }));
  }

  unreadCount(ctx: RequestContext): Promise<number> {
    return this.uow.store.unreadCount(requireActor(ctx).id);
  }

  async markRead(id: string, ctx: RequestContext): Promise<Notification> {
    const n = await this.uow.store.markRead(id, requireActor(ctx).id);
    if (!n) throw Errors.notFound('Notification'); // others' ids look exactly like missing ones
    return n;
  }

  markAllRead(ctx: RequestContext): Promise<number> {
    return this.uow.store.markAllRead(requireActor(ctx).id);
  }

  // ---- preferences ----

  async preferences(ctx: RequestContext): Promise<EffectivePreference[]> {
    const actor = requireActor(ctx);
    const stored = await this.uow.store.preferences([actor.id]);
    return effectivePreferences(stored.get(actor.id) ?? new Map());
  }

  async setPreferences(
    items: readonly (ChannelPreference & { type: NotificationType })[],
    ctx: RequestContext,
  ): Promise<EffectivePreference[]> {
    const actor = requireActor(ctx);
    if (new Set(items.map((i) => i.type)).size !== items.length) {
      throw Errors.validation('Each notification type may appear only once.');
    }
    // Store only what differs from the defaults, so changing a default later reaches everyone
    // who never touched that setting.
    const upsert = items.filter((i) => !isDefaultPreference(i.type, i));
    const remove = items.filter((i) => isDefaultPreference(i.type, i)).map((i) => i.type);
    await this.uow.transaction((s) => s.savePreferences(actor.id, upsert, remove));
    return this.preferences(ctx);
  }

  // ---- maintenance ----

  purge(s: NotificationStore, retentionDays: number): Promise<number> {
    return s.purgeOlderThan(retentionDays);
  }
}
