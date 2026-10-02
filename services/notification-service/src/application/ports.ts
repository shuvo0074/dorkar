import type { Cursor } from '@dorkar/kernel';
import type {
  ChannelPreference,
  DeliveryChannel,
  Notification,
  NotificationPayload,
  NotificationType,
} from '../domain/notification';

export interface NewNotification {
  id: string;
  recipientId: string;
  type: NotificationType;
  payload: NotificationPayload;
  sourceEventId: string;
  inApp: boolean;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface NotificationStore {
  /** Insert-if-absent on (source_event_id, recipient_id, type); returns the ids actually inserted. */
  insertNotifications(rows: readonly NewNotification[]): Promise<Set<string>>;
  queueDeliveries(
    rows: readonly { notificationId: string; channel: DeliveryChannel }[],
  ): Promise<void>;
  /** Stored overrides only, for many accounts at once. */
  preferences(
    accountIds: readonly string[],
  ): Promise<Map<string, Map<NotificationType, ChannelPreference>>>;
  /** Upserts overrides; `remove` drops overrides that equal the default. */
  savePreferences(
    accountId: string,
    upsert: readonly (ChannelPreference & { type: NotificationType })[],
    remove: readonly NotificationType[],
  ): Promise<void>;
  list(
    recipientId: string,
    q: { unreadOnly: boolean; cursor: Cursor | null; take: number },
  ): Promise<Notification[]>;
  unreadCount(recipientId: string): Promise<number>;
  /** Marks read (keeps the first read time); null when it is not the recipient's notification. */
  markRead(id: string, recipientId: string): Promise<Notification | null>;
  markAllRead(recipientId: string): Promise<number>;
  /** Deletes read (and never-listed) notifications older than `days`, with their deliveries. */
  purgeOlderThan(days: number): Promise<number>;
}

export interface NotificationUnitOfWork {
  readonly store: NotificationStore;
  transaction<T>(fn: (store: NotificationStore) => Promise<T>): Promise<T>;
}

/** A delivery claimed by the dispatcher, with what it needs to render and route. */
export interface ClaimedDelivery {
  id: string;
  channel: DeliveryChannel;
  /** Attempt number this claim represents (1-based); guards stale writes. */
  attempt: number;
  notification: Notification;
}

export interface DeliveryStore {
  /**
   * Claims up to `limit` due PENDING deliveries on `channel` (FOR UPDATE SKIP LOCKED), counting the
   * attempt and leasing them for `leaseMs` so a crashed worker's claims are retried later.
   */
  claimDue(channel: DeliveryChannel, limit: number, leaseMs: number): Promise<ClaimedDelivery[]>;
  markSent(id: string, attempt: number): Promise<void>;
  retryLater(id: string, attempt: number, delayMs: number, error: string): Promise<void>;
  finish(id: string, attempt: number, status: 'FAILED' | 'SKIPPED', error: string): Promise<void>;
}

/** Looks up how to reach a person at send time; phone numbers are never stored here. */
export interface ContactDirectory {
  /** E.164 phone, or null when the account is unknown or not active (not contactable). */
  phoneOf(accountId: string): Promise<string | null>;
}

export interface SmsChannel {
  send(toE164: string, text: string): Promise<void>;
}
