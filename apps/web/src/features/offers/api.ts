import type { Condition, DeliveryMode } from '@dorkar/contracts';
import { api, query, type Page } from '../../lib/http';
import type { Money } from '../../lib/money';

export const OfferStatuses = [
  'SUBMITTED',
  'COUNTERED_BY_BUYER',
  'COUNTERED_BY_SELLER',
  'ACCEPTED',
  'REJECTED',
  'WITHDRAWN',
  'EXPIRED',
  'CANCELLED',
] as const;
export type OfferStatus = (typeof OfferStatuses)[number];
export type OfferAction = 'ACCEPT' | 'COUNTER' | 'REJECT' | 'WITHDRAW';

export interface DeliveryTerms {
  method: DeliveryMode;
  feeAmount?: number;
  etaDays?: number;
}

export interface Offer {
  id: string;
  needId: string;
  buyerId: string;
  sellerId: string;
  listingId: string | null;
  status: OfferStatus;
  price: Money;
  quantity: number;
  condition: Condition | null;
  availabilityFrom: string | null;
  deliveryTerms: DeliveryTerms;
  modeTerms: Record<string, unknown>;
  description: string | null;
  attachmentMediaIds: string[];
  expiresAt: string;
  currentRound: number;
  awaiting: 'BUYER' | 'SELLER' | null;
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
  /** What the caller may do right now; render exactly these. */
  actions: OfferAction[];
}

export interface Round {
  round: number;
  proposedBy: 'BUYER' | 'SELLER';
  price: Money;
  quantity: number;
  terms: {
    delivery: DeliveryTerms;
    mode: Record<string, unknown>;
    condition: Condition | null;
    availabilityFrom: string | null;
  };
  message: string | null;
  createdAt: string;
}

export interface OfferDetail extends Offer {
  rounds: Round[];
}

export interface CompareItem extends Offer {
  sellerDisplayName: string | null;
}

export interface OfferInput {
  price: Money;
  quantity: number;
  deliveryTerms: DeliveryTerms;
  listingId?: string | null;
  condition?: Condition | null;
  availabilityFrom?: string | null;
  modeTerms?: Record<string, unknown>;
  description?: string | null;
  attachmentMediaIds?: string[];
  expiresInHours?: number;
}

export interface CounterInput {
  price: Money;
  quantity: number;
  deliveryTerms?: DeliveryTerms;
  modeTerms?: Record<string, unknown>;
  condition?: Condition | null;
  availabilityFrom?: string | null;
  message?: string | null;
}

export const liveOffer = (s: OfferStatus) =>
  s === 'SUBMITTED' || s === 'COUNTERED_BY_BUYER' || s === 'COUNTERED_BY_SELLER';

const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);
const enc = encodeURIComponent;

export const offersApi = {
  submit: (needId: string, input: OfferInput, idempotencyKey: string) =>
    one(
      api<{ data: OfferDetail }>(`/api/v1/needs/${enc(needId)}/offers`, {
        method: 'POST',
        body: input,
        idempotencyKey,
      }),
    ),
  forNeed: (
    needId: string,
    sort: 'newest' | 'price_asc',
    status: OfferStatus | undefined,
    cursor?: string,
  ) =>
    api<Page<CompareItem>>(
      `/api/v1/needs/${enc(needId)}/offers${query({ sort, status, cursor, limit: 20 })}`,
    ),
  mine: (status?: OfferStatus, cursor?: string) =>
    api<Page<Offer>>(`/api/v1/me/offers${query({ status, cursor, limit: 20 })}`),
  get: (id: string) => one(api<{ data: OfferDetail }>(`/api/v1/offers/${enc(id)}`)),
  counter: (id: string, input: CounterInput, idempotencyKey: string) =>
    one(
      api<{ data: OfferDetail }>(`/api/v1/offers/${enc(id)}/counter`, {
        method: 'POST',
        body: input,
        idempotencyKey,
      }),
    ),
  accept: (id: string, idempotencyKey: string) =>
    one(
      api<{ data: OfferDetail }>(`/api/v1/offers/${enc(id)}/accept`, {
        method: 'POST',
        idempotencyKey,
      }),
    ),
  reject: (id: string) =>
    one(api<{ data: OfferDetail }>(`/api/v1/offers/${enc(id)}/reject`, { method: 'POST' })),
  withdraw: (id: string) =>
    one(api<{ data: OfferDetail }>(`/api/v1/offers/${enc(id)}/withdraw`, { method: 'POST' })),
};
