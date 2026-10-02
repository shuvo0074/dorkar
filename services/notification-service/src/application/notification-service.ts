import type { EventEnvelope } from '@dorkar/contracts';
import { decodeCursor, Errors, paginate, uuidv7, type RequestContext } from '@dorkar/kernel';
import {
  channelsFor,
  effectivePreferences,
  isDefaultPreference,
  preferenceFor,
  type ChannelPreference,
  type DeliveryChannel,
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
  constructor(
    private readonly uow: NotificationUnitOfWork,
    /** False when no push provider is configured: PUSH deliveries are never queued. */
    private readonly opts: { pushEnabled: boolean } = { pushEnabled: false },
  ) {}

  // ---- event handling (inside the inbox transaction) ----

  /**
   * Applies preferences and records the notifications an event produced, queueing out-of-band
   * deliveries. Idempotent per (event, recipient, type), and so per channel, even outside the
   * inbox guarantee. Coalescing intents merge into the recipient's unread notification instead.
   */
  async onEvent(
    s: NotificationStore,
    event: Pick<EventEnvelope, 'id'>,
    intents: readonly NotificationIntent[],
  ): Promise<number> {
    if (intents.length === 0) return 0;
    const recipients = [...new Set(intents.map((i) => i.recipientId))];
    const prefs = await s.preferences(recipients);
    const reachable = this.opts.pushEnabled ? await s.pushReachable(recipients) : new Set<string>();

    const planned: { row: NewNotification; channels: DeliveryChannel[] }[] = [];
    for (const i of intents) {
      const pref = preferenceFor(i.type, prefs.get(i.recipientId));
      // Push only to people with a device: no rows that could never be sent.
      const channels = channelsFor(pref).filter(
        (c) => c !== 'PUSH' || reachable.has(i.recipientId),
      );
      if (!pref.inApp && channels.length === 0) continue; // opted out everywhere
      planned.push({
        channels,
        row: {
          id: uuidv7(),
          recipientId: i.recipientId,
          type: i.type,
          payload: i.payload,
          sourceEventId: event.id,
          inApp: pref.inApp,
          // Only visible notifications coalesce; a hidden one is a one-off delivery carrier.
          coalesceKey: pref.inApp ? (i.coalesceKey ?? null) : null,
        },
      });
    }
    if (planned.length === 0) return 0;

    let merged = 0;
    const fresh: typeof planned = [];
    for (const p of planned) {
      const key = p.row.coalesceKey;
      if (key === null) {
        fresh.push(p);
        continue;
      }
      const m = await s.mergeIntoUnread({ ...p.row, coalesceKey: key });
      if (m.outcome === 'NONE') fresh.push(p);
      else if (m.outcome === 'MERGED') {
        merged++;
        // Only push follows a merge (throttled per conversation at send time); an SMS per
        // chat message would cost too much, so SMS stays with the first message.
        await s.requeueDeliveries(
          p.channels
            .filter((channel) => channel === 'PUSH')
            .map((channel) => ({ notificationId: m.notificationId, channel })),
        );
      }
    }

    const inserted = await s.insertNotifications(fresh.map((p) => p.row));
    await s.queueDeliveries(
      fresh
        .filter((p) => inserted.has(p.row.id))
        .flatMap((p) => p.channels.map((channel) => ({ notificationId: p.row.id, channel }))),
    );
    return inserted.size + merged;
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

  /**
   * Replaces the listed types' settings. `push` may be omitted (clients that predate push):
   * the current effective value is kept.
   */
  async setPreferences(
    items: readonly (Omit<ChannelPreference, 'push'> & {
      type: NotificationType;
      push?: boolean | undefined;
    })[],
    ctx: RequestContext,
  ): Promise<EffectivePreference[]> {
    const actor = requireActor(ctx);
    if (new Set(items.map((i) => i.type)).size !== items.length) {
      throw Errors.validation('Each notification type may appear only once.');
    }
    await this.uow.transaction(async (s) => {
      const stored = (await s.preferences([actor.id])).get(actor.id);
      const full = items.map((i) => ({
        type: i.type,
        inApp: i.inApp,
        sms: i.sms,
        push: i.push ?? preferenceFor(i.type, stored).push,
      }));
      // Store only what differs from the defaults, so changing a default later reaches everyone
      // who never touched that setting.
      const upsert = full.filter((i) => !isDefaultPreference(i.type, i));
      const remove = full.filter((i) => isDefaultPreference(i.type, i)).map((i) => i.type);
      await s.savePreferences(actor.id, upsert, remove);
    });
    return this.preferences(ctx);
  }

  // ---- maintenance ----

  purge(s: NotificationStore, retentionDays: number): Promise<number> {
    return s.purgeOlderThan(retentionDays);
  }
}
