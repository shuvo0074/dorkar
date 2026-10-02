import { uuidv7 } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type {
  ClaimedDelivery,
  DeliveryStore,
  NotificationStore,
  NotificationUnitOfWork,
} from '../application/ports';
import type { ChannelPreference, Notification, NotificationType } from '../domain/notification';
import type { NotificationDB } from './db-schema';

type Executor = Kysely<NotificationDB> | Transaction<NotificationDB>;

const COLUMNS = ['id', 'recipient_id', 'type', 'payload', 'read_at', 'created_at'] as const;

const toNotification = (
  r: Pick<Selectable<NotificationDB['notifications']>, (typeof COLUMNS)[number]>,
): Notification => ({
  id: r.id,
  recipientId: r.recipient_id,
  type: r.type,
  payload: r.payload,
  readAt: r.read_at,
  createdAt: r.created_at,
});

export function pgNotificationStore(db: Executor): NotificationStore {
  return {
    async insertNotifications(rows) {
      if (rows.length === 0) return new Set();
      const inserted = await db
        .insertInto('notifications')
        .values(
          rows.map((r) => ({
            id: r.id,
            recipient_id: r.recipientId,
            type: r.type,
            payload: JSON.stringify(r.payload),
            source_event_id: r.sourceEventId,
            in_app: r.inApp,
          })),
        )
        .onConflict((oc) => oc.columns(['source_event_id', 'recipient_id', 'type']).doNothing())
        .returning('id')
        .execute();
      return new Set(inserted.map((r) => r.id));
    },

    async queueDeliveries(rows) {
      if (rows.length === 0) return;
      await db
        .insertInto('deliveries')
        .values(
          rows.map((r) => ({
            id: uuidv7(),
            notification_id: r.notificationId,
            channel: r.channel,
            last_error: null,
            sent_at: null,
          })),
        )
        .onConflict((oc) => oc.columns(['notification_id', 'channel']).doNothing())
        .execute();
    },

    async preferences(accountIds) {
      const out = new Map<string, Map<NotificationType, ChannelPreference>>();
      if (accountIds.length === 0) return out;
      const rows = await db
        .selectFrom('notification_preferences')
        .select(['account_id', 'type', 'in_app', 'sms'])
        .where('account_id', 'in', accountIds)
        .execute();
      for (const r of rows) {
        const m = out.get(r.account_id) ?? new Map<NotificationType, ChannelPreference>();
        m.set(r.type, { inApp: r.in_app, sms: r.sms });
        out.set(r.account_id, m);
      }
      return out;
    },

    async savePreferences(accountId, upsert, remove) {
      if (remove.length) {
        await db
          .deleteFrom('notification_preferences')
          .where('account_id', '=', accountId)
          .where('type', 'in', remove)
          .execute();
      }
      if (upsert.length) {
        await db
          .insertInto('notification_preferences')
          .values(
            upsert.map((p) => ({
              account_id: accountId,
              type: p.type,
              in_app: p.inApp,
              sms: p.sms,
            })),
          )
          .onConflict((oc) =>
            oc.columns(['account_id', 'type']).doUpdateSet((eb) => ({
              in_app: eb.ref('excluded.in_app'),
              sms: eb.ref('excluded.sms'),
              updated_at: sql<Date>`now()`,
            })),
          )
          .execute();
      }
    },

    async list(recipientId, q) {
      let query = db
        .selectFrom('notifications')
        .select(COLUMNS)
        .where('recipient_id', '=', recipientId)
        .where('in_app', '=', true);
      if (q.unreadOnly) query = query.where('read_at', 'is', null);
      if (q.cursor) {
        query = query.where(
          sql<boolean>`(created_at, id) < (${new Date(String(q.cursor.k))}, ${q.cursor.id}::uuid)`,
        );
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(q.take)
        .execute();
      return rows.map(toNotification);
    },

    async unreadCount(recipientId) {
      const r = await db
        .selectFrom('notifications')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('recipient_id', '=', recipientId)
        .where('in_app', '=', true)
        .where('read_at', 'is', null)
        .executeTakeFirstOrThrow();
      return Number(r.n);
    },

    async markRead(id, recipientId) {
      const r = await db
        .updateTable('notifications')
        .set({ read_at: sql<Date>`coalesce(read_at, now())` })
        .where('id', '=', id)
        .where('recipient_id', '=', recipientId)
        .where('in_app', '=', true)
        .returning(COLUMNS)
        .executeTakeFirst();
      return r ? toNotification(r) : null;
    },

    async markAllRead(recipientId) {
      const r = await db
        .updateTable('notifications')
        .set({ read_at: sql<Date>`now()` })
        .where('recipient_id', '=', recipientId)
        .where('in_app', '=', true)
        .where('read_at', 'is', null)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },

    async purgeOlderThan(days) {
      const r = await db
        .deleteFrom('notifications')
        .where('created_at', '<', sql<Date>`now() - make_interval(days => ${days})`)
        .where((eb) => eb.or([eb('read_at', 'is not', null), eb('in_app', '=', false)]))
        .executeTakeFirst();
      return Number(r.numDeletedRows);
    },
  };
}

export function pgNotificationUnitOfWork(db: Kysely<NotificationDB>): NotificationUnitOfWork {
  return {
    store: pgNotificationStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgNotificationStore(trx))),
  };
}

const ms = (n: number) => sql<Date>`now() + make_interval(secs => ${n / 1000})`;

export function pgDeliveryStore(db: Kysely<NotificationDB>): DeliveryStore {
  /** Guarded so a worker whose lease expired cannot overwrite a newer attempt's outcome. */
  const settle = (id: string, attempt: number) =>
    db
      .updateTable('deliveries')
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .where('attempts', '=', attempt);

  return {
    async claimDue(channel, limit, leaseMs) {
      const claimed = await db
        .updateTable('deliveries')
        .set((eb) => ({
          attempts: eb('attempts', '+', 1),
          next_attempt_at: ms(leaseMs),
          updated_at: sql<Date>`now()`,
        }))
        .where('id', 'in', (eb) =>
          eb
            .selectFrom('deliveries')
            .select('id')
            .where('channel', '=', channel)
            .where('status', '=', 'PENDING')
            .where('next_attempt_at', '<=', sql<Date>`now()`)
            .orderBy('next_attempt_at')
            .limit(limit)
            .forUpdate()
            .skipLocked(),
        )
        .returning(['id', 'channel', 'attempts', 'notification_id'])
        .execute();
      if (claimed.length === 0) return [];
      const notifications = await db
        .selectFrom('notifications')
        .select(COLUMNS)
        .where(
          'id',
          'in',
          claimed.map((c) => c.notification_id),
        )
        .execute();
      const byId = new Map(notifications.map((n) => [n.id, toNotification(n)]));
      return claimed.flatMap((c): ClaimedDelivery[] => {
        const notification = byId.get(c.notification_id);
        return notification
          ? [{ id: c.id, channel: c.channel, attempt: c.attempts, notification }]
          : [];
      });
    },
    async markSent(id, attempt) {
      await settle(id, attempt)
        .set({
          status: 'SENT',
          sent_at: sql<Date>`now()`,
          last_error: null,
          updated_at: sql<Date>`now()`,
        })
        .execute();
    },
    async retryLater(id, attempt, delayMs, error) {
      await settle(id, attempt)
        .set({
          next_attempt_at: ms(delayMs),
          last_error: error.slice(0, 200),
          updated_at: sql<Date>`now()`,
        })
        .execute();
    },
    async finish(id, attempt, status, error) {
      await settle(id, attempt)
        .set({ status, last_error: error.slice(0, 200), updated_at: sql<Date>`now()` })
        .execute();
    },
  };
}
