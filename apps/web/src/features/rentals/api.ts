import { shortCode } from '../../lib/format';
import { api, query, type Page } from '../../lib/http';
import type { Money } from '../../lib/money';

export interface RentalTerms {
  listingId: string;
  instantBook: boolean;
  minDurationHours: number;
  maxDurationDays: number;
  deposit: Money | null;
  advanceNoticeHours: number;
  bufferHours: number;
  cancellationNote: string | null;
  updatedAt: string | null;
}

export type RentalTermsInput = Omit<RentalTerms, 'listingId' | 'updatedAt'>;

export interface Availability {
  listingId: string;
  from: string;
  to: string;
  busy: Array<{ startAt: string; endAt: string }>;
}

export interface Block {
  id: string;
  listingId: string;
  startAt: string;
  endAt: string;
  reason: string | null;
  createdAt: string;
}

export const BookingStatuses = [
  'HELD',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'ACTIVE',
  'RETURNED',
  'CLOSED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type BookingStatus = (typeof BookingStatuses)[number];
export type BookingAction = 'confirm' | 'approve' | 'decline' | 'cancel';

export interface Booking {
  id: string;
  listingId: string;
  ownerId: string;
  renterId: string;
  status: BookingStatus;
  startAt: string;
  endAt: string;
  holdExpiresAt: string | null;
  amount: Money;
  deposit: Money | null;
  terms: Record<string, unknown>;
  transactionId: string | null;
  disputed: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface BookingDetail extends Booking {
  note: string | null;
  declineReason: string | null;
  cancelReason: string | null;
  overdueNotifiedAt: string | null;
  viewerRole: 'RENTER' | 'OWNER' | null;
  actions: BookingAction[];
  transitions: Array<{
    from: BookingStatus;
    to: BookingStatus;
    command: string;
    actorId: string | null;
    actorRole: string;
    reason: string | null;
    at: string;
  }>;
}

export const bookingCode = (id: string) => shortCode('R', id);

const enc = encodeURIComponent;
const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const rentalsApi = {
  terms: (listingId: string) =>
    one(api<{ data: RentalTerms }>(`/api/v1/listings/${enc(listingId)}/rental-terms`)),
  saveTerms: (listingId: string, input: RentalTermsInput) =>
    one(
      api<{ data: RentalTerms }>(`/api/v1/listings/${enc(listingId)}/rental-terms`, {
        method: 'PUT',
        body: input,
      }),
    ),
  availability: (listingId: string, from: string, to: string) =>
    one(
      api<{ data: Availability }>(
        `/api/v1/listings/${enc(listingId)}/availability${query({ from, to })}`,
      ),
    ),
  blocks: (listingId: string) =>
    one(api<{ data: Block[] }>(`/api/v1/listings/${enc(listingId)}/availability/blocks`)),
  addBlock: (
    listingId: string,
    input: { startAt: string; endAt: string; reason?: string },
    key: string,
  ) =>
    one(
      api<{ data: Block }>(`/api/v1/listings/${enc(listingId)}/availability/blocks`, {
        method: 'POST',
        body: input,
        idempotencyKey: key,
      }),
    ),
  removeBlock: (listingId: string, blockId: string) =>
    api<void>(`/api/v1/listings/${enc(listingId)}/availability/blocks/${enc(blockId)}`, {
      method: 'DELETE',
    }),

  book: (
    input: { listingId: string; startAt: string; endAt: string; note?: string },
    key: string,
  ) =>
    one(
      api<{ data: BookingDetail }>('/api/v1/bookings', {
        method: 'POST',
        body: input,
        idempotencyKey: key,
      }),
    ),
  get: (id: string) => one(api<{ data: BookingDetail }>(`/api/v1/bookings/${enc(id)}`)),
  act: (id: string, action: BookingAction, body: { reason?: string }, key: string) =>
    one(
      api<{ data: BookingDetail }>(`/api/v1/bookings/${enc(id)}/${action}`, {
        method: 'POST',
        body,
        idempotencyKey: key,
      }),
    ),
  mine: (
    f: { status?: BookingStatus | undefined; role?: 'renter' | 'owner' | undefined },
    cursor?: string,
  ) => api<Page<Booking>>(`/api/v1/me/bookings${query({ ...f, cursor, limit: 20 })}`),
};
