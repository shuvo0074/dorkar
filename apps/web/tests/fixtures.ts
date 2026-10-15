import { account, inTenMinutes } from './fake-api';

/** Shared marketplace fixtures for page tests. */

export const ME = account.id;
export const OTHER = '0192f0c4-0000-7000-8000-0000000000aa';

export const signedIn = (roles: string[] = ['MEMBER']) => ({
  'POST /api/v1/auth/refresh': () => ({
    body: { data: { accessToken: 'a', accessTokenExpiresAt: inTenMinutes() } },
  }),
  'GET /api/v1/me/account': () => ({ body: { data: { ...account, roles } } }),
});

export const signedOut = {
  'POST /api/v1/auth/refresh': () => ({
    status: 401,
    body: { error: { code: 'UNAUTHENTICATED' } },
  }),
};

export const money = (taka: number) => ({ amount: taka * 100, currency: 'BDT' as const });

export const PHONES = '0192f0c4-0000-7000-8000-00000000c001';
export const ELECTRONICS = '0192f0c4-0000-7000-8000-00000000c000';
export const SERVICES = '0192f0c4-0000-7000-8000-00000000c100';

export const categoryTree = [
  {
    id: ELECTRONICS,
    slug: 'electronics',
    nameEn: 'Electronics',
    nameBn: 'ইলেকট্রনিক্স',
    modes: ['BUY', 'RENT', 'SOURCE'],
    sort: 0,
    children: [
      {
        id: PHONES,
        slug: 'phones',
        nameEn: 'Phones',
        nameBn: 'ফোন',
        modes: ['BUY', 'SOURCE'],
        sort: 0,
        children: [],
      },
    ],
  },
  {
    id: SERVICES,
    slug: 'services',
    nameEn: 'Home services',
    nameBn: 'ঘরের কাজ',
    modes: ['HIRE'],
    sort: 1,
    children: [],
  },
];

export const phonesCategory = {
  id: PHONES,
  parentId: ELECTRONICS,
  slug: 'phones',
  nameEn: 'Phones',
  nameBn: 'ফোন',
  modes: ['BUY', 'SOURCE'],
  sort: 0,
  attributeSchema: {
    properties: {
      brand: { type: 'string', label: { en: 'Brand', bn: 'ব্র্যান্ড' } },
      storageGb: { type: 'integer', label: { en: 'Storage', bn: 'স্টোরেজ' }, unit: 'GB' },
    },
    required: ['brand'],
  },
};

export const catalogRoutes = {
  'GET /api/v1/categories': () => ({ body: { data: categoryTree } }),
  [`GET /api/v1/categories/${PHONES}`]: () => ({ body: { data: phonesCategory } }),
};

export const NEED = '0192f0c4-0000-7000-8000-00000000e001';

export const need = (over: Record<string, unknown> = {}) => ({
  id: NEED,
  requesterId: ME,
  mode: 'BUY',
  categoryId: PHONES,
  title: 'Used iPhone 15 Pro, 256GB',
  description: 'Battery above 85%',
  quantity: 1,
  acceptedQuantity: 0,
  budget: { min: null, max: money(80_000), flexible: false },
  condition: ['USED'],
  attributes: { brand: 'Apple', storageGb: 256 },
  modeTerms: { acceptsUsed: true },
  location: { division: 'dhaka', district: 'dhaka', area: 'Mirpur' },
  deliveryPreference: 'EITHER',
  requiredBy: null,
  status: 'OPEN',
  offerCount: 0,
  maxOffers: 50,
  expiresAt: '2026-11-15T00:00:00.000Z',
  publishedAt: '2026-10-15T08:00:00.000Z',
  createdAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:00.000Z',
  visibility: 'PUBLIC',
  renewals: 0,
  version: 1,
  history: [{ from: 'DRAFT', to: 'OPEN', reason: 'PUBLISHED', at: '2026-10-15T08:00:00.000Z' }],
  ...over,
});

export const OFFER = '0192f0c4-0000-7000-8000-00000000f001';

export const offer = (over: Record<string, unknown> = {}) => ({
  id: OFFER,
  needId: NEED,
  buyerId: ME,
  sellerId: OTHER,
  listingId: null,
  status: 'SUBMITTED',
  price: money(78_000),
  quantity: 1,
  condition: 'USED',
  availabilityFrom: null,
  deliveryTerms: { method: 'SELLER_DELIVERY', feeAmount: 20_000, etaDays: 2 },
  modeTerms: { warrantyMonths: 3 },
  description: 'Battery 91%, box included',
  attachmentMediaIds: [],
  expiresAt: '2026-10-18T08:00:00.000Z',
  currentRound: 1,
  awaiting: 'BUYER',
  hidden: false,
  createdAt: '2026-10-15T09:00:00.000Z',
  updatedAt: '2026-10-15T09:00:00.000Z',
  actions: ['ACCEPT', 'COUNTER', 'REJECT'],
  rounds: [
    {
      round: 1,
      proposedBy: 'SELLER',
      price: money(78_000),
      quantity: 1,
      terms: {
        delivery: { method: 'SELLER_DELIVERY', feeAmount: 20_000, etaDays: 2 },
        mode: { warrantyMonths: 3 },
        condition: 'USED',
        availabilityFrom: null,
      },
      message: null,
      createdAt: '2026-10-15T09:00:00.000Z',
    },
  ],
  ...over,
});

export const DEAL = '0192f0c4-0000-7000-8000-00000000d001';

export const deal = (over: Record<string, unknown> = {}) => ({
  id: DEAL,
  sourceType: 'OFFER',
  sourceId: OFFER,
  listingId: null,
  needId: NEED,
  buyerId: ME,
  sellerId: OTHER,
  mode: 'BUY',
  amount: money(78_000),
  quantity: 1,
  terms: {},
  state: 'CREATED',
  buyerConfirmedAt: null,
  sellerConfirmedAt: '2026-10-15T10:00:00.000Z',
  deliveredAt: null,
  handedOverAt: null,
  returnReportedAt: null,
  returnedAt: null,
  completedAt: null,
  cancelReason: null,
  disputeReason: null,
  disputeCategory: null,
  preDisputeState: null,
  createdAt: '2026-10-15T09:30:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  version: 2,
  viewerRole: 'BUYER',
  actions: ['confirm', 'cancel'],
  payment: {
    provider: 'CASH',
    status: 'PENDING',
    amount: money(78_000),
    note: null,
    updatedAt: '2026-10-15T09:30:00.000Z',
  },
  delivery: null,
  deposit: null,
  transitions: [
    {
      from: 'CREATED',
      to: 'CREATED',
      command: 'confirm',
      actorId: OTHER,
      actorRole: 'SELLER',
      reason: null,
      at: '2026-10-15T10:00:00.000Z',
    },
  ],
  ...over,
});

export const LISTING = '0192f0c4-0000-7000-8000-00000000b001';
export const MEDIA = '0192f0c4-0000-7000-8000-00000000a001';

export const listing = (over: Record<string, unknown> = {}) => ({
  id: LISTING,
  sellerId: OTHER,
  categoryId: PHONES,
  kind: 'PRODUCT',
  condition: 'USED',
  title: 'iPhone 13, 128GB, blue',
  description: 'One owner, no scratches.',
  price: money(52_000),
  priceUnit: 'TOTAL',
  quantityAvailable: 1,
  attributes: { brand: 'Apple' },
  district: 'dhaka',
  area: 'Dhanmondi',
  deliveryModes: ['BUYER_PICKUP'],
  mediaIds: [MEDIA],
  status: 'PUBLISHED',
  publishedAt: '2026-10-14T08:00:00.000Z',
  createdAt: '2026-10-14T08:00:00.000Z',
  updatedAt: '2026-10-14T08:00:00.000Z',
  ...over,
});

export const mediaRoutes = {
  [`GET /api/v1/media/${MEDIA}`]: () => ({
    body: {
      data: {
        id: MEDIA,
        purpose: 'LISTING',
        status: 'READY',
        contentType: 'image/webp',
        width: 320,
        height: 240,
        rejectionReason: null,
        createdAt: '2026-10-14T08:00:00.000Z',
        urls: { thumb: '/files/thumb.webp', medium: '/files/medium.webp' },
        urlsExpireAt: '2026-10-14T08:10:00.000Z',
      },
    },
  }),
};
