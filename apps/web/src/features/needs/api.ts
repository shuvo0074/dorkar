import type { Condition, District, Division, NeedMode } from '@dorkar/contracts';
import { api, query, type Page } from '../../lib/http';
import type { Money } from '../../lib/money';

export const NeedStatuses = [
  'DRAFT',
  'OPEN',
  'PAUSED',
  'FULFILLING',
  'FULFILLED',
  'CLOSED',
  'EXPIRED',
  'HIDDEN',
] as const;
export type NeedStatus = (typeof NeedStatuses)[number];

export const DeliveryPreferences = ['EITHER', 'PICKUP', 'DELIVERY'] as const;
export type DeliveryPreference = (typeof DeliveryPreferences)[number];

export const ServiceWindows = ['ANY', 'MORNING', 'AFTERNOON', 'EVENING', 'NIGHT'] as const;
export type ServiceWindow = (typeof ServiceWindows)[number];

export interface Budget {
  min: Money | null;
  max: Money | null;
  flexible: boolean;
}

export interface NeedLocation {
  division: Division;
  district: District;
  area: string | null;
}

export interface Need {
  id: string;
  requesterId: string;
  mode: NeedMode;
  categoryId: string;
  title: string;
  description: string | null;
  quantity: number;
  acceptedQuantity: number;
  budget: Budget;
  condition: Condition[];
  attributes: Record<string, unknown>;
  modeTerms: Record<string, unknown>;
  location: NeedLocation;
  deliveryPreference: DeliveryPreference;
  requiredBy: string | null;
  status: NeedStatus;
  offerCount: number;
  maxOffers: number;
  expiresAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Owner only:
  visibility?: 'PUBLIC' | 'MATCHED_ONLY';
  renewals?: number;
  version?: number;
  history?: Array<{ from: NeedStatus | null; to: NeedStatus; reason: string; at: string }>;
}

export interface NeedInput {
  mode: NeedMode;
  categoryId: string;
  title: string;
  location: { district: District; area?: string };
  description?: string | null;
  quantity?: number;
  budget?: { min?: Money | null; max?: Money | null; flexible?: boolean } | null;
  condition?: Condition[];
  attributes?: Record<string, unknown>;
  modeTerms?: Record<string, unknown>;
  deliveryPreference?: DeliveryPreference;
  requiredBy?: string | null;
  visibility?: 'PUBLIC' | 'MATCHED_ONLY';
  publish?: boolean;
}

export interface NeedSearch {
  q?: string | undefined;
  categoryId?: string | undefined;
  mode?: NeedMode | undefined;
  district?: string | undefined;
  budgetMaxAtLeast?: number | undefined;
}

export type NeedCommand = 'publish' | 'pause' | 'resume' | 'close' | 'renew';

/** What the owner may do in each state; the API has no actions list for needs. */
export const needCommands: Record<NeedStatus, NeedCommand[]> = {
  DRAFT: ['publish'],
  OPEN: ['pause', 'close'],
  PAUSED: ['resume', 'close'],
  FULFILLING: [],
  FULFILLED: [],
  CLOSED: [],
  EXPIRED: ['renew'],
  HIDDEN: [],
};
export const needEditable = (s: NeedStatus) => s === 'DRAFT' || s === 'OPEN' || s === 'PAUSED';

export interface Match {
  matchId: string;
  candidateType: 'LISTING' | 'SELLER';
  sellerId: string;
  listingId: string | null;
  score: number;
  reasons: Record<string, number>;
  status: 'NEW' | 'DISMISSED' | 'RESPONDED' | 'CLOSED';
}

export interface MatchedNeed {
  matchId: string;
  status: 'NEW' | 'RESPONDED';
  score: number;
  reasons: Record<string, number>;
  listingId: string | null;
  matchedAt: string;
  need: {
    id: string;
    title: string;
    mode: NeedMode;
    categoryId: string;
    quantity: number;
    district: District;
    budget: { min: Money | null; max: Money | null };
    expiresAt: string;
  };
}

const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);
const enc = encodeURIComponent;

export const needsApi = {
  feed: (s: NeedSearch, cursor?: string) =>
    api<Page<Need>>(`/api/v1/needs${query({ ...s, cursor, limit: 24 })}`),
  get: (id: string) => one(api<{ data: Need }>(`/api/v1/needs/${enc(id)}`)),
  mine: (status?: NeedStatus, cursor?: string) =>
    api<Page<Need>>(`/api/v1/me/needs${query({ status, cursor, limit: 20 })}`),
  create: (input: NeedInput) =>
    one(api<{ data: Need }>('/api/v1/needs', { method: 'POST', body: input })),
  update: (id: string, patch: Partial<Omit<NeedInput, 'publish'>>) =>
    one(api<{ data: Need }>(`/api/v1/needs/${enc(id)}`, { method: 'PATCH', body: patch })),
  command: (id: string, command: NeedCommand) =>
    one(api<{ data: Need }>(`/api/v1/needs/${enc(id)}/${command}`, { method: 'POST' })),

  matches: (id: string, cursor?: string) =>
    api<Page<Match>>(`/api/v1/needs/${enc(id)}/matches${query({ cursor, limit: 20 })}`),
  matchedNeeds: (cursor?: string) =>
    api<Page<MatchedNeed>>(`/api/v1/me/matched-needs${query({ cursor, limit: 20 })}`),
  dismissMatch: (matchId: string) =>
    api<void>(`/api/v1/me/matched-needs/${enc(matchId)}/dismiss`, { method: 'POST' }),
};
