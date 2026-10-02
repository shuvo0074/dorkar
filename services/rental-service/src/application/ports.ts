import type { BookingStatus, EventEnvelope, Money } from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { ActorRole, BookingCommand } from '../domain/booking-state-machine';
import type { Booking, Interval, RentalListing, RentalTerms } from '../domain/booking';

export interface ListQuery {
  status?: BookingStatus | undefined;
  cursor: Cursor | null;
  limit: number;
}

export interface Loaded {
  booking: Booking;
  /** Database clock at load time. */
  now: Date;
}

export interface Transition {
  id: string;
  bookingId: string;
  from: BookingStatus;
  to: BookingStatus;
  command: string;
  actorId: string | null;
  actorRole: ActorRole;
  reason: string | null;
  at: Date;
}

export interface NewBooking {
  id: string;
  listingId: string;
  ownerId: string;
  renterId: string;
  startAt: Date;
  endAt: Date;
  status: 'HELD' | 'PENDING_APPROVAL';
  holdExpiresAt: Date;
  amount: number;
  deposit: number | null;
  terms: Record<string, unknown>;
  note: string | null;
}

export interface Block {
  id: string;
  listingId: string;
  startAt: Date;
  endAt: Date;
  reason: string | null;
  createdAt: Date;
}

export interface TransitionPatch {
  declineReason?: string;
  cancelReason?: string;
  transactionId?: string;
  transactionState?: string;
  disputed?: boolean;
  clearHold?: true;
}

export interface TermsInput {
  instantBook: boolean;
  minDurationHours: number;
  maxDurationDays: number;
  deposit: Money | null;
  advanceNoticeHours: number;
  bufferHours: number;
  cancellationNote: string | null;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface RentalStore {
  now(): Promise<Date>;

  // listings (projection) and terms
  listing(listingId: string): Promise<RentalListing | null>;
  /** Row lock on the listing: serialises bookings per listing (the EXCLUDE constraint still decides). */
  lockListing(listingId: string): Promise<RentalListing | null>;
  upsertListing(l: Omit<RentalListing, 'available'>, publish: boolean): Promise<void>;
  markListingUnavailable(listingId: string): Promise<void>;
  terms(listingId: string): Promise<RentalTerms | null>;
  putTerms(listingId: string, t: TermsInput): Promise<RentalTerms>;

  // calendar
  /** Throws 409 BOOKING_CONFLICT when the period overlaps an active slot. */
  insertSlot(slot: {
    id: string;
    listingId: string;
    startAt: Date;
    endAt: Date;
    kind: 'BOOKING' | 'BLOCK';
    refId: string | null;
    reason: string | null;
    createdBy: string | null;
  }): Promise<void>;
  releaseBookingSlot(bookingId: string): Promise<void>;
  busy(listingId: string, from: Date, to: Date): Promise<Interval[]>;
  blocks(listingId: string, from: Date, to: Date): Promise<Block[]>;
  removeBlock(listingId: string, blockId: string): Promise<boolean>;

  // bookings
  insert(b: NewBooking): Promise<Booking>;
  load(id: string, opts?: { forUpdate?: boolean }): Promise<Loaded | null>;
  transition(
    id: string,
    guard: { from: BookingStatus; version: number },
    to: BookingStatus,
    patch: TransitionPatch,
  ): Promise<Booking | null>;
  /** Field changes without a status change (mirror facts). */
  patch(id: string, version: number, patch: TransitionPatch): Promise<Booking | null>;
  appendTransition(t: Omit<Transition, 'id' | 'at'>): Promise<void>;
  transitions(bookingId: string): Promise<Transition[]>;
  listForParty(
    accountId: string,
    role: 'renter' | 'owner' | undefined,
    q: ListQuery,
  ): Promise<Booking[]>;
  listAll(q: ListQuery): Promise<Booking[]>;

  // jobs (rows locked FOR UPDATE SKIP LOCKED by the caller's transaction)
  dueForExpiry(limit: number, listingId?: string): Promise<string[]>;
  dueForOverdue(graceHours: number, limit: number): Promise<string[]>;
  markOverdueNotified(id: string): Promise<Booking | null>;

  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
}

export interface RentalUnitOfWork {
  readonly store: RentalStore;
  transaction<T>(fn: (store: RentalStore) => Promise<T>): Promise<T>;
}

export interface VerificationDecision {
  satisfied: boolean;
  missing: string[];
}

/** Port to verification-service's policy engine. Implementations fail CLOSED (throw 503). */
export interface VerificationGateway {
  evaluate(
    q: {
      accountId: string;
      action: 'BOOKING_CREATE';
      categoryId: string;
      mode: 'RENT';
      amount: number;
    },
    ctx: RequestContext,
  ): Promise<VerificationDecision>;
}

export type { BookingCommand };
