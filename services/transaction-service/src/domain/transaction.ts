import {
  findContactInfo,
  MoneySchema,
  type DeliveryMode,
  type NeedMode,
  type TransactionState,
} from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

export const SourceTypes = ['OFFER', 'LISTING'] as const;
export type SourceType = (typeof SourceTypes)[number];

export const PaymentStatuses = ['PENDING', 'PAID', 'REFUNDED', 'FAILED'] as const;
export type PaymentStatus = (typeof PaymentStatuses)[number];
/** Only cash in the MVP; bKash/Nagad/cards/escrow add adapters, not states. */
export const PaymentProviderNames = ['CASH'] as const;
export type PaymentProviderName = (typeof PaymentProviderNames)[number];

export const DeliveryStatuses = ['ARRANGED', 'DELIVERED', 'CANCELLED'] as const;
export type DeliveryStatus = (typeof DeliveryStatuses)[number];
/** Parties arrange delivery themselves in the MVP; Pathao/Steadfast/RedX come later. */
export const DeliveryProviderNames = ['SELF_ARRANGED'] as const;
export type DeliveryProviderName = (typeof DeliveryProviderNames)[number];

export const ListingKinds = ['PRODUCT', 'SERVICE', 'RENTAL'] as const;
export type ListingKind = (typeof ListingKinds)[number];
export const PriceUnits = ['TOTAL', 'PER_UNIT', 'PER_HOUR', 'PER_DAY'] as const;
export type PriceUnit = (typeof PriceUnits)[number];

export interface Transaction {
  id: string;
  sourceType: SourceType;
  sourceId: string;
  listingId: string | null;
  needId: string | null;
  buyerId: string;
  sellerId: string;
  mode: NeedMode;
  amount: number;
  currency: 'BDT';
  quantity: number;
  terms: Record<string, unknown>;
  state: TransactionState;
  buyerConfirmedAt: Date | null;
  sellerConfirmedAt: Date | null;
  deliveredAt: Date | null;
  completedAt: Date | null;
  cancelReason: string | null;
  disputeReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface Payment {
  id: string;
  transactionId: string;
  provider: PaymentProviderName;
  status: PaymentStatus;
  amount: number;
  currency: 'BDT';
  providerRef: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Delivery {
  id: string;
  transactionId: string;
  method: DeliveryMode;
  status: DeliveryStatus;
  notes: string | null;
  scheduledFor: Date | null;
  provider: DeliveryProviderName;
  providerRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Transition {
  id: string;
  transactionId: string;
  from: TransactionState;
  to: TransactionState;
  command: string;
  actorId: string | null;
  actorRole: string;
  reason: string | null;
  at: Date;
}

export interface ListingSnapshot {
  listingId: string;
  sellerId: string;
  kind: ListingKind;
  title: string;
  price: number;
  currency: 'BDT';
  priceUnit: PriceUnit;
  quantityAvailable: number;
  deliveryModes: DeliveryMode[];
  available: boolean;
}

/** Durations (ms) that drive the time-based guards. */
export interface TransactionPolicy {
  confirmTtlMs: number;
  autoCompleteMs: number;
  disputeWindowMs: number;
}

export const policyFrom = (s: {
  confirmTtlHours: number;
  autoCompleteDays: number;
  disputeWindowDays: number;
}): TransactionPolicy => ({
  confirmTtlMs: s.confirmTtlHours * 3_600_000,
  autoCompleteMs: s.autoCompleteDays * 86_400_000,
  disputeWindowMs: s.disputeWindowDays * 86_400_000,
});

const MODE_BY_KIND: Record<ListingKind, NeedMode> = {
  PRODUCT: 'BUY',
  SERVICE: 'HIRE',
  RENTAL: 'RENT',
};

const MAX_AMOUNT = MoneySchema.shape.amount.maxValue ?? 100_000_000_000;

const rule = (rule: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError('BUSINESS_RULE_VIOLATION', message, { rule, ...details });

/**
 * Direct purchase of a listing: who may buy, how many, and for how much.
 * TOTAL priced listings are sold as one lot (quantity 1); every other unit multiplies.
 */
export function priceListingPurchase(
  listing: ListingSnapshot,
  buyerId: string,
  quantity: number,
): { mode: NeedMode; amount: number } {
  if (!listing.available) throw rule('LISTING_UNAVAILABLE', 'This listing is no longer available.');
  if (listing.sellerId === buyerId) throw rule('OWN_LISTING', 'You cannot buy your own listing.');
  if (!Number.isInteger(quantity) || quantity < 1)
    throw rule('INVALID_QUANTITY', 'Quantity must be at least 1.');
  if (listing.priceUnit === 'TOTAL' && quantity !== 1)
    throw rule('QUANTITY_NOT_ALLOWED', 'This listing is sold as a single lot; quantity must be 1.');
  if (quantity > listing.quantityAvailable)
    throw rule('INSUFFICIENT_QUANTITY', 'Not enough quantity available.', {
      available: listing.quantityAvailable,
    });
  const amount = listing.priceUnit === 'TOTAL' ? listing.price : listing.price * quantity;
  if (!Number.isSafeInteger(amount) || amount > MAX_AMOUNT)
    throw rule('AMOUNT_TOO_LARGE', 'The total amount is too large.');
  return { mode: MODE_BY_KIND[listing.kind], amount };
}

/** Frozen terms of a direct purchase, so later listing edits never change the deal. */
export const listingTerms = (l: ListingSnapshot, quantity: number): Record<string, unknown> => ({
  listingId: l.listingId,
  title: l.title,
  kind: l.kind,
  priceUnit: l.priceUnit,
  unitPrice: { amount: l.price, currency: l.currency },
  quantity,
  deliveryModes: l.deliveryModes,
});

/** Delivery notes are private to the parties, but phone numbers still stay inside Dorkar. */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw rule(
      'NO_CONTACT_INFO',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from your ${field}. Use Dorkar messages to coordinate.`,
      { field },
    );
  }
}
