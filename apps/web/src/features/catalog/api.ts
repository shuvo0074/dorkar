import type {
  AttributeSchema,
  Condition,
  DeliveryMode,
  District,
  NeedMode,
} from '@dorkar/contracts';
import { api, query, type Page } from '../../lib/http';
import type { Money } from '../../lib/money';

export interface CategoryNode {
  id: string;
  slug: string;
  nameEn: string;
  nameBn: string;
  modes: NeedMode[];
  sort: number;
  children: CategoryNode[];
}

export interface Category {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameBn: string;
  modes: NeedMode[];
  attributeSchema: AttributeSchema;
  sort: number;
}

export const ListingKinds = ['PRODUCT', 'SERVICE', 'RENTAL'] as const;
export type ListingKind = (typeof ListingKinds)[number];
export const PriceUnits = ['TOTAL', 'PER_UNIT', 'PER_HOUR', 'PER_DAY'] as const;
export type PriceUnit = (typeof PriceUnits)[number];
export const ListingStatuses = [
  'DRAFT',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'WITHDRAWN',
  'HIDDEN',
] as const;
export type ListingStatus = (typeof ListingStatuses)[number];

export interface Listing {
  id: string;
  sellerId: string;
  categoryId: string;
  kind: ListingKind;
  condition: Condition | null;
  title: string;
  description: string;
  price: Money;
  priceUnit: PriceUnit;
  quantityAvailable: number;
  attributes: Record<string, string | number | boolean>;
  district: District;
  area: string | null;
  deliveryModes: DeliveryMode[];
  mediaIds: string[];
  status: ListingStatus;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListingInput {
  categoryId: string;
  kind: ListingKind;
  title: string;
  price: Money;
  district: District;
  condition?: Condition | null;
  description?: string;
  priceUnit?: PriceUnit;
  quantityAvailable?: number;
  attributes?: Record<string, string | number | boolean>;
  area?: string | null;
  deliveryModes?: DeliveryMode[];
  mediaIds?: string[];
}

export interface ListingSearch {
  q?: string | undefined;
  categoryId?: string | undefined;
  district?: string | undefined;
  kind?: ListingKind | undefined;
  condition?: Condition | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  sort?: 'newest' | 'price_asc' | 'price_desc' | undefined;
}

export type ListingCommand = 'publish' | 'pause' | 'resume' | 'mark-sold-out' | 'withdraw';

/** What the owner may do with a listing in each state (the API has no actions list for these). */
export const listingCommands: Record<ListingStatus, ListingCommand[]> = {
  DRAFT: ['publish', 'withdraw'],
  PUBLISHED: ['pause', 'mark-sold-out', 'withdraw'],
  PAUSED: ['resume', 'mark-sold-out', 'withdraw'],
  SOLD_OUT: ['withdraw'],
  WITHDRAWN: [],
  HIDDEN: [],
};
export const listingEditable = (s: ListingStatus) =>
  s === 'DRAFT' || s === 'PUBLISHED' || s === 'PAUSED';

const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const catalogApi = {
  categories: () => one(api<{ data: CategoryNode[] }>('/api/v1/categories', { auth: false })),
  category: (id: string) =>
    one(api<{ data: Category }>(`/api/v1/categories/${encodeURIComponent(id)}`, { auth: false })),

  listings: (s: ListingSearch, cursor?: string) =>
    api<Page<Listing>>(`/api/v1/listings${query({ ...s, cursor, limit: 24 })}`),
  listing: (id: string) =>
    one(api<{ data: Listing }>(`/api/v1/listings/${encodeURIComponent(id)}`)),
  myListings: (status?: ListingStatus, cursor?: string) =>
    api<Page<Listing>>(`/api/v1/me/listings${query({ status, cursor, limit: 20 })}`),
  createListing: (input: ListingInput) =>
    one(api<{ data: Listing }>('/api/v1/listings', { method: 'POST', body: input })),
  updateListing: (id: string, patch: Partial<ListingInput>) =>
    one(
      api<{ data: Listing }>(`/api/v1/listings/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: patch,
      }),
    ),
  listingCommand: (id: string, command: ListingCommand) =>
    one(
      api<{ data: Listing }>(`/api/v1/listings/${encodeURIComponent(id)}/${command}`, {
        method: 'POST',
      }),
    ),
};
