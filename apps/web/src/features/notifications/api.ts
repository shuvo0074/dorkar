import { api, query, type Page } from '../../lib/http';
import type { Money } from '../../lib/money';

export const NotificationTypes = [
  'NEED_MATCHED',
  'OFFER_RECEIVED',
  'OFFER_COUNTERED',
  'OFFER_ACCEPTED',
  'OFFER_REJECTED',
  'OFFER_CLOSED',
  'TRANSACTION_CREATED',
  'TRANSACTION_UPDATED',
  'NEED_EXPIRED',
  'NEED_FULFILLING',
  'REVIEW_RECEIVED',
  'VERIFICATION_UPDATED',
  'BID_PLACED',
  'BID_OUTBID',
  'AUCTION_CLOSED',
  'AUCTION_WON',
  'AUCTION_LOST',
  'AUCTION_CANCELLED',
  'BOOKING_REQUESTED',
  'BOOKING_CONFIRMED',
  'BOOKING_DECLINED',
  'BOOKING_EXPIRED',
  'BOOKING_CANCELLED',
  'BOOKING_OVERDUE',
  'LOAN_REQUESTED',
  'LOAN_APPROVED',
  'LOAN_DECLINED',
  'LOAN_EXPIRED',
  'LOAN_OVERDUE',
  'DISPUTE_OPENED',
  'DISPUTE_UPDATED',
  'DISPUTE_RESOLVED',
  'DISPUTE_WITHDRAWN',
  'NEW_MESSAGE',
] as const;
export type NotificationType = (typeof NotificationTypes)[number];

export type PayloadValue = string | number | boolean | null | Money;

export interface Notification {
  id: string;
  type: NotificationType;
  payload: Record<string, PayloadValue>;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface Preference {
  type: NotificationType;
  inApp: boolean;
  sms: boolean;
  push: boolean;
}

const enc = encodeURIComponent;

export const notificationsApi = {
  list: (unreadOnly: boolean, cursor?: string) =>
    api<Page<Notification>>(
      `/api/v1/me/notifications${query({ unreadOnly: unreadOnly ? 'true' : undefined, cursor, limit: 30 })}`,
    ),
  unreadCount: () =>
    api<{ data: { count: number } }>('/api/v1/me/notifications/unread-count').then(
      (r) => r.data.count,
    ),
  read: (id: string) =>
    api<{ data: Notification }>(`/api/v1/me/notifications/${enc(id)}/read`, { method: 'POST' }),
  readAll: () =>
    api<{ data: { updated: number } }>('/api/v1/me/notifications/read-all', { method: 'POST' }),
  preferences: () =>
    api<{ data: Preference[] }>('/api/v1/me/notifications/preferences').then((r) => r.data),
  savePreferences: (items: Preference[]) =>
    api<{ data: Preference[] }>('/api/v1/me/notifications/preferences', {
      method: 'PUT',
      body: { items },
    }).then((r) => r.data),
};
