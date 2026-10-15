import type { DeliveryMode, NeedMode } from '@dorkar/contracts';
import { shortCode } from '../../lib/format';
import { api, query, type Page } from '../../lib/http';
import type { Money } from '../../lib/money';

export const TransactionStates = [
  'CREATED',
  'CONFIRMED',
  'DELIVERY_PENDING',
  'DELIVERED',
  'HANDED_OVER',
  'RETURN_REPORTED',
  'RETURNED',
  'COMPLETED',
  'CANCELLED',
  'DISPUTED',
  'REFUNDED',
  'EXPIRED',
] as const;
export type TransactionState = (typeof TransactionStates)[number];
export const finalStates: ReadonlySet<TransactionState> = new Set([
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'EXPIRED',
]);

export type SourceType = 'OFFER' | 'LISTING' | 'AUCTION' | 'BOOKING' | 'LOAN';

export const DisputeReasons = [
  'NOT_RECEIVED',
  'NOT_AS_DESCRIBED',
  'DAMAGED',
  'NOT_RETURNED',
  'PAYMENT',
  'NO_SHOW',
  'OTHER',
] as const;
export type DisputeReason = (typeof DisputeReasons)[number];

export const DealActions = [
  'confirm',
  'arrange-delivery',
  'mark-delivered',
  'confirm-receipt',
  'hand-over',
  'report-return',
  'confirm-return',
  'complete',
  'cancel',
  'dispute',
] as const;
export type DealAction = (typeof DealActions)[number];

export interface Deal {
  id: string;
  sourceType: SourceType;
  sourceId: string;
  listingId: string | null;
  needId: string | null;
  buyerId: string;
  sellerId: string;
  mode: NeedMode;
  amount: Money;
  quantity: number;
  terms: Record<string, unknown>;
  state: TransactionState;
  buyerConfirmedAt: string | null;
  sellerConfirmedAt: string | null;
  deliveredAt: string | null;
  handedOverAt: string | null;
  returnReportedAt: string | null;
  returnedAt: string | null;
  completedAt: string | null;
  cancelReason: string | null;
  disputeReason: string | null;
  disputeCategory: DisputeReason | null;
  preDisputeState: TransactionState | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface DealDetail extends Deal {
  viewerRole: 'BUYER' | 'SELLER' | null;
  actions: DealAction[];
  payment: {
    provider: string;
    status: 'PENDING' | 'PAID' | 'REFUNDED' | 'FAILED';
    amount: Money;
    note: string | null;
    updatedAt: string;
  } | null;
  delivery: {
    method: DeliveryMode;
    status: 'ARRANGED' | 'DELIVERED' | 'CANCELLED';
    provider: string;
    scheduledFor: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  deposit: {
    amount: Money;
    status: 'HELD' | 'RETURNED' | 'FORFEITED';
    note: string | null;
    updatedAt: string;
  } | null;
  transitions: Array<{
    from: TransactionState;
    to: TransactionState;
    command: string;
    actorId: string | null;
    actorRole: string;
    reason: string | null;
    at: string;
  }>;
}

export type DealCommandBody =
  | { action: 'cancel'; reason: string }
  | { action: 'arrange-delivery'; method: DeliveryMode; scheduledFor?: string; notes?: string }
  | { action: 'dispute'; reason: string; category: DisputeReason }
  | {
      action: Exclude<DealAction, 'cancel' | 'arrange-delivery' | 'dispute'>;
    };

const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);
const enc = encodeURIComponent;

export const dealsApi = {
  mine: (
    f: { state?: TransactionState | undefined; role?: 'buyer' | 'seller' | undefined },
    cursor?: string,
  ) => api<Page<Deal>>(`/api/v1/me/transactions${query({ ...f, cursor, limit: 20 })}`),
  get: (id: string) => one(api<{ data: DealDetail }>(`/api/v1/transactions/${enc(id)}`)),
  buy: (listingId: string, quantity: number, idempotencyKey: string) =>
    one(
      api<{ data: DealDetail }>('/api/v1/transactions', {
        method: 'POST',
        body: { listingId, quantity },
        idempotencyKey,
      }),
    ),
  command: (id: string, cmd: DealCommandBody, idempotencyKey: string) => {
    const { action, ...body } = cmd;
    return one(
      api<{ data: DealDetail }>(`/api/v1/transactions/${enc(id)}/${action}`, {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    );
  },
};

/** A deal's human name: the listing or item title when the terms carry one. */
export function dealTitle(d: Pick<Deal, 'terms'>): string | null {
  for (const k of ['title', 'listingTitle', 'itemTitle', 'auctionTitle']) {
    const v = d.terms[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

export const dealCode = (id: string) => shortCode('T', id);
