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
] as const;
export type NotificationType = (typeof NotificationTypes)[number];

/**
 * Out-of-band channels a notification can be delivered on. Only SMS has a sender today; the
 * rest are reserved so the deliveries table and the dispatcher need no reshaping to add them.
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

/** One flag per channel the user controls. Adding PUSH/EMAIL/WHATSAPP adds a flag here. */
export interface ChannelPreference {
  inApp: boolean;
  sms: boolean;
}

export interface EffectivePreference extends ChannelPreference {
  type: NotificationType;
}

/** SMS costs money and attention: on by default only for the moments people act on quickly. */
export const SMS_DEFAULT_TYPES: ReadonlySet<NotificationType> = new Set([
  'OFFER_RECEIVED',
  'OFFER_ACCEPTED',
  'TRANSACTION_CREATED',
]);

export const defaultPreference = (type: NotificationType): ChannelPreference => ({
  inApp: true,
  sms: SMS_DEFAULT_TYPES.has(type),
});

export const isDefaultPreference = (type: NotificationType, p: ChannelPreference): boolean => {
  const d = defaultPreference(type);
  return d.inApp === p.inApp && d.sms === p.sms;
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

/** Out-of-band channels a preference turns on. */
export const channelsFor = (p: ChannelPreference): DeliveryChannel[] => (p.sms ? ['SMS'] : []);
