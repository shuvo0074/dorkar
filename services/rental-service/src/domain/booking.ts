import { findContactInfo, type BookingStatus, type District, type Money } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

export type PriceUnit = 'TOTAL' | 'PER_UNIT' | 'PER_HOUR' | 'PER_DAY';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** MoneySchema's ceiling (poisha). */
export const MAX_AMOUNT = 100_000_000_000;

/** A catalog RENTAL listing as rental sees it (projection). */
export interface RentalListing {
  listingId: string;
  sellerId: string;
  categoryId: string;
  title: string;
  district: District;
  price: number;
  currency: 'BDT';
  priceUnit: PriceUnit;
  available: boolean;
}

export interface RentalTerms {
  listingId: string;
  instantBook: boolean;
  minDurationHours: number;
  maxDurationDays: number;
  deposit: Money | null;
  advanceNoticeHours: number;
  bufferHours: number;
  cancellationNote: string | null;
  /** null when the listing has no terms row yet (defaults). */
  updatedAt: Date | null;
}

export const DEFAULT_TERMS: Omit<RentalTerms, 'listingId' | 'updatedAt'> = {
  instantBook: false,
  minDurationHours: 24,
  maxDurationDays: 30,
  deposit: null,
  advanceNoticeHours: 12,
  bufferHours: 0,
  cancellationNote: null,
};

export const defaultTerms = (listingId: string): RentalTerms => ({
  listingId,
  ...DEFAULT_TERMS,
  updatedAt: null,
});

export interface Booking {
  id: string;
  listingId: string;
  ownerId: string;
  renterId: string;
  startAt: Date;
  endAt: Date;
  status: BookingStatus;
  holdExpiresAt: Date | null;
  amount: number;
  currency: 'BDT';
  deposit: number | null;
  terms: Record<string, unknown>;
  note: string | null;
  declineReason: string | null;
  cancelReason: string | null;
  transactionId: string | null;
  transactionState: string | null;
  disputed: boolean;
  overdueNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface BookingPolicy {
  holdMinutes: number;
  approvalHours: number;
  overdueGraceHours: number;
  maxAdvanceDays: number;
}

// ---------------------------------------------------------------- text

/** Booking notes and public terms must not leak contact details (phone numbers stay private). */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from your ${field}. People contact each other through Dorkar.`,
      { rule: 'NO_CONTACT_INFO', field },
    );
  }
}

const rule = (r: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError('BUSINESS_RULE_VIOLATION', message, { rule: r, ...details });

// ---------------------------------------------------------------- terms

export function assertTermsConsistent(t: Omit<RentalTerms, 'listingId' | 'updatedAt'>): void {
  if (t.minDurationHours > t.maxDurationDays * 24) {
    throw rule('TERMS_INCONSISTENT', 'The minimum rental duration is longer than the maximum.', {});
  }
  assertNoContactInfo('cancellation note', t.cancellationNote);
}

// ---------------------------------------------------------------- pricing

export interface Quote {
  amount: number;
  /** Exact duration in hours (may be fractional). */
  hours: number;
  /** Units charged: days, hours, or 1 for a TOTAL price. */
  billedUnits: number;
  /** PER_UNIT is priced like PER_DAY. */
  effectiveUnit: 'TOTAL' | 'PER_HOUR' | 'PER_DAY';
}

export const durationHours = (startAt: Date, endAt: Date) =>
  (endAt.getTime() - startAt.getTime()) / HOUR_MS;

/**
 * PER_DAY (and PER_UNIT) → every started 24 hours is a day; PER_HOUR → every started hour;
 * TOTAL → the listed price for the whole period.
 */
export function quote(priceUnit: PriceUnit, unitPrice: number, startAt: Date, endAt: Date): Quote {
  const ms = endAt.getTime() - startAt.getTime();
  if (!(ms > 0)) throw rule('INVALID_PERIOD', 'The rental must end after it starts.');
  const hours = ms / HOUR_MS;
  let billedUnits: number;
  let effectiveUnit: Quote['effectiveUnit'];
  switch (priceUnit) {
    case 'PER_HOUR':
      billedUnits = Math.ceil(ms / HOUR_MS);
      effectiveUnit = 'PER_HOUR';
      break;
    case 'TOTAL':
      billedUnits = 1;
      effectiveUnit = 'TOTAL';
      break;
    case 'PER_DAY':
    case 'PER_UNIT':
      billedUnits = Math.ceil(ms / DAY_MS);
      effectiveUnit = 'PER_DAY';
      break;
  }
  const amount = billedUnits * unitPrice;
  if (!Number.isSafeInteger(amount) || amount > MAX_AMOUNT) {
    throw rule('AMOUNT_TOO_LARGE', 'The total for this period is too large.');
  }
  return { amount, hours, billedUnits, effectiveUnit };
}

// ---------------------------------------------------------------- request rules

export interface BookingRequest {
  renterId: string;
  startAt: Date;
  endAt: Date;
}

/** Everything a booking request must satisfy, checked against the database clock `now`. */
export function assertBookable(
  listing: RentalListing,
  terms: RentalTerms,
  req: BookingRequest,
  now: Date,
  policy: BookingPolicy,
): void {
  if (listing.sellerId === req.renterId) {
    throw rule('OWN_LISTING', 'You cannot book your own listing.');
  }
  if (!listing.available) {
    throw rule('LISTING_UNAVAILABLE', 'This listing is not available for booking right now.');
  }
  const start = req.startAt.getTime();
  const end = req.endAt.getTime();
  if (!(end > start)) throw rule('INVALID_PERIOD', 'The rental must end after it starts.');
  const hours = (end - start) / HOUR_MS;
  if (hours < terms.minDurationHours) {
    throw rule('DURATION_TOO_SHORT', `The minimum rental is ${terms.minDurationHours} hours.`, {
      minDurationHours: terms.minDurationHours,
    });
  }
  if (hours > terms.maxDurationDays * 24) {
    throw rule('DURATION_TOO_LONG', `The maximum rental is ${terms.maxDurationDays} days.`, {
      maxDurationDays: terms.maxDurationDays,
    });
  }
  if (start < now.getTime() + terms.advanceNoticeHours * HOUR_MS) {
    throw rule(
      'ADVANCE_NOTICE',
      `Bookings must start at least ${terms.advanceNoticeHours} hours from now.`,
      { advanceNoticeHours: terms.advanceNoticeHours },
    );
  }
  if (end > now.getTime() + policy.maxAdvanceDays * DAY_MS) {
    throw rule(
      'TOO_FAR_AHEAD',
      `Bookings can end at most ${policy.maxAdvanceDays} days from now.`,
      { maxAdvanceDays: policy.maxAdvanceDays },
    );
  }
}

/** Initial status and the deadline for the next step. Never later than the start. */
export function initialState(
  terms: RentalTerms,
  startAt: Date,
  now: Date,
  policy: BookingPolicy,
): { status: 'HELD' | 'PENDING_APPROVAL'; holdExpiresAt: Date } {
  const window = terms.instantBook ? policy.holdMinutes * 60_000 : policy.approvalHours * HOUR_MS;
  const deadline = Math.min(now.getTime() + window, startAt.getTime());
  return {
    status: terms.instantBook ? 'HELD' : 'PENDING_APPROVAL',
    holdExpiresAt: new Date(deadline),
  };
}

/** The calendar slot a booking occupies: its period plus the owner's turnaround buffer. */
export const bookingSlot = (startAt: Date, endAt: Date, bufferHours: number) => ({
  startAt,
  endAt: new Date(endAt.getTime() + bufferHours * HOUR_MS),
});

/** Frozen terms carried by the booking and by BookingConfirmed. */
export function termsSnapshot(
  listing: RentalListing,
  terms: RentalTerms,
  q: Quote,
): Record<string, unknown> {
  return {
    listingTitle: listing.title,
    priceUnit: listing.priceUnit,
    effectivePriceUnit: q.effectiveUnit,
    unitPrice: { amount: listing.price, currency: listing.currency },
    hours: q.hours,
    billedUnits: q.billedUnits,
    instantBook: terms.instantBook,
    bufferHours: terms.bufferHours,
    depositNote: terms.deposit
      ? 'Refundable security deposit, handed over with the item and returned when it comes back undamaged.'
      : null,
    cancellationNote: terms.cancellationNote,
  };
}

// ---------------------------------------------------------------- calendar

export interface Interval {
  startAt: Date;
  endAt: Date;
}

export const MAX_AVAILABILITY_WINDOW_DAYS = 120;
export const MAX_BLOCK_DAYS = 366;

export function assertWindow(from: Date, to: Date, maxDays: number, what: string): void {
  if (!(to.getTime() > from.getTime())) {
    throw new AppError('VALIDATION_FAILED', `${what}: the end must be after the start.`);
  }
  if (to.getTime() - from.getTime() > maxDays * DAY_MS) {
    throw new AppError('VALIDATION_FAILED', `${what}: at most ${maxDays} days at a time.`);
  }
}

/**
 * Busy intervals inside [from, to): clipped and merged (overlapping or touching intervals become
 * one), so the response never reveals where a booking ends and a block or buffer begins.
 */
export function mergeBusy(slots: readonly Interval[], from: Date, to: Date): Interval[] {
  const clipped = slots
    .map((s) => ({
      start: Math.max(s.startAt.getTime(), from.getTime()),
      end: Math.min(s.endAt.getTime(), to.getTime()),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const s of clipped) {
    const last = out.at(-1);
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out.map((s) => ({ startAt: new Date(s.start), endAt: new Date(s.end) }));
}

/** Reaching one of these statuses releases the booking's calendar slot. */
export const SLOT_RELEASING: ReadonlySet<BookingStatus> = new Set([
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
]);
