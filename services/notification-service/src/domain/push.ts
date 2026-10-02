import { copyFor, deepLinkFor } from './copy';
import type { Notification, NotificationType } from './notification';

export const PushPlatforms = ['ANDROID', 'IOS', 'WEB'] as const;
export type PushPlatform = (typeof PushPlatforms)[number];

/** Active devices per account; registering an 11th deactivates the least recently registered. */
export const MAX_ACTIVE_PUSH_DEVICES = 10;

export interface PushDevice {
  id: string;
  accountId: string;
  platform: PushPlatform;
  createdAt: Date;
  lastRegisteredAt: Date;
}

/** A device as the sender sees it: with the provider token. Never leaves the service. */
export interface PushTarget {
  id: string;
  platform: PushPlatform;
  token: string;
}

/** What a push carries: title, short body, type and a deep link. Nothing else. */
export interface PushMessage {
  notificationId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Relative in-app path, e.g. `/auctions/<id>`. */
  path: string;
}

export function renderPush(n: Pick<Notification, 'id' | 'type' | 'payload'>): PushMessage {
  const { title, body } = copyFor(n);
  return { notificationId: n.id, type: n.type, title, body, path: deepLinkFor(n) };
}

/** At most one push per conversation per recipient in this window (message bursts). */
export const PUSH_THROTTLE_MS = 5 * 60_000;

/**
 * Throttle key for types that arrive in bursts (null = never throttled). Scoped by recipient and
 * the coalescing subject so one chatty conversation cannot silence another.
 */
export function pushThrottleKey(
  n: Pick<Notification, 'recipientId' | 'type' | 'payload'>,
): string | null {
  if (n.type !== 'NEW_MESSAGE') return null;
  const c = n.payload['conversationId'];
  return typeof c === 'string' ? `push-throttle:${n.recipientId}:${c}` : null;
}
