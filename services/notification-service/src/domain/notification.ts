import type { Money } from '@dorkar/contracts';

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
  // Phase 2: bidding
  'BID_PLACED',
  'BID_OUTBID',
  'AUCTION_CLOSED',
  'AUCTION_WON',
  'AUCTION_LOST',
  'AUCTION_CANCELLED',
  // rental
  'BOOKING_REQUESTED',
  'BOOKING_CONFIRMED',
  'BOOKING_DECLINED',
  'BOOKING_EXPIRED',
  'BOOKING_CANCELLED',
  'BOOKING_OVERDUE',
  // lending
  'LOAN_REQUESTED',
  'LOAN_APPROVED',
  'LOAN_DECLINED',
  'LOAN_EXPIRED',
  'LOAN_OVERDUE',
  // disputes
  'DISPUTE_OPENED',
  'DISPUTE_UPDATED',
  'DISPUTE_RESOLVED',
  'DISPUTE_WITHDRAWN',
  // messaging
  'NEW_MESSAGE',
] as const;
export type NotificationType = (typeof NotificationTypes)[number];

/**
 * Out-of-band channels a notification can be delivered on. SMS and PUSH have senders; the rest
 * are reserved so the deliveries table and the dispatchers need no reshaping to add them.
 */
export const DeliveryChannels = ['SMS', 'PUSH', 'EMAIL', 'WHATSAPP'] as const;
export type DeliveryChannel = (typeof DeliveryChannels)[number];

export const DeliveryStatuses = ['PENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export type DeliveryStatus = (typeof DeliveryStatuses)[number];

/** IDs and non-sensitive facts only: never names, phone numbers, addresses or free text. */
export type PayloadValue = string | number | boolean | null | Money;
export type NotificationPayload = Record<string, PayloadValue>;

/** What an event asks for, before preferences are applied. */
export interface NotificationIntent {
  recipientId: string;
  type: NotificationType;
  payload: NotificationPayload;
  /**
   * Coalescing key (e.g. a conversation id): while the recipient still has an unread in-app
   * notification of the same type and key, the new one is merged into it instead of added.
   */
  coalesceKey?: string;
}

export interface Notification {
  id: string;
  recipientId: string;
  type: NotificationType;
  payload: NotificationPayload;
  readAt: Date | null;
  createdAt: Date;
}

// ------------------------------------------------------------------------------- preferences

/** One flag per channel the user controls. Adding EMAIL/WHATSAPP adds a flag here. */
export interface ChannelPreference {
  inApp: boolean;
  sms: boolean;
  push: boolean;
}

export interface EffectivePreference extends ChannelPreference {
  type: NotificationType;
}

/** SMS costs money and attention: on by default only for the moments people act on quickly. */
export const SMS_DEFAULT_TYPES: ReadonlySet<NotificationType> = new Set([
  'OFFER_RECEIVED',
  'OFFER_ACCEPTED',
  'TRANSACTION_CREATED',
  'AUCTION_WON',
  'BOOKING_CONFIRMED',
  'DISPUTE_OPENED',
]);

/** Push is free and dismissable: on for everything until the user turns a type off. */
export const defaultPreference = (type: NotificationType): ChannelPreference => ({
  inApp: true,
  sms: SMS_DEFAULT_TYPES.has(type),
  push: true,
});

export const isDefaultPreference = (type: NotificationType, p: ChannelPreference): boolean => {
  const d = defaultPreference(type);
  return d.inApp === p.inApp && d.sms === p.sms && d.push === p.push;
};

/** Defaults merged with the user's stored overrides, for every type, in a stable order. */
export function effectivePreferences(
  overrides: ReadonlyMap<NotificationType, ChannelPreference>,
): EffectivePreference[] {
  return NotificationTypes.map((type) => ({
    type,
    ...(overrides.get(type) ?? defaultPreference(type)),
  }));
}

export function preferenceFor(
  type: NotificationType,
  overrides: ReadonlyMap<NotificationType, ChannelPreference> | undefined,
): ChannelPreference {
  return overrides?.get(type) ?? defaultPreference(type);
}

/** Out-of-band channels a preference turns on (PUSH still needs a registered device). */
export const channelsFor = (p: ChannelPreference): DeliveryChannel[] => [
  ...(p.sms ? (['SMS'] as const) : []),
  ...(p.push ? (['PUSH'] as const) : []),
];
