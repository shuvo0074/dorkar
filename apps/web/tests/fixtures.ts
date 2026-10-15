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
