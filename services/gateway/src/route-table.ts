/**
 * Public routing table. Explicit and reviewable: a path not listed here is a 404 at the edge,
 * so internal endpoints (`/internal/*`, `/docs`, `/health` of services) are never exposed.
 * Add a line per public path prefix when a service ships new endpoints.
 *
 * Parametric prefixes (`/api/v1/needs/:needId/offers`) are more specific than the plain
 * `/api/v1/needs` prefix, so nested resources owned by another service route correctly.
 */
export const Upstreams = [
  'identity',
  'profile',
  'verification',
  'catalog',
  'demand',
  'matching',
  'offer',
  'transaction',
  'reputation',
  'moderation',
  'notification',
  'media',
] as const;
export type Upstream = (typeof Upstreams)[number];

export interface RouteRule {
  prefix: string;
  upstream: Upstream;
}

export const ROUTE_TABLE: readonly RouteRule[] = [
  // identity
  { prefix: '/api/v1/auth', upstream: 'identity' },
  { prefix: '/api/v1/me/account', upstream: 'identity' },
  { prefix: '/api/v1/me/sessions', upstream: 'identity' },
  { prefix: '/api/v1/me/devices', upstream: 'identity' },
  { prefix: '/api/v1/admin/accounts', upstream: 'identity' },
  { prefix: '/.well-known/jwks.json', upstream: 'identity' },
  // profile
  { prefix: '/api/v1/me/profile', upstream: 'profile' },
  { prefix: '/api/v1/me/seller-capabilities', upstream: 'profile' },
  { prefix: '/api/v1/users', upstream: 'profile' },
  // verification
  { prefix: '/api/v1/me/verifications', upstream: 'verification' },
  { prefix: '/api/v1/admin/verifications', upstream: 'verification' },
  { prefix: '/api/v1/admin/verification-policies', upstream: 'verification' },
  // catalog
  { prefix: '/api/v1/categories', upstream: 'catalog' },
  { prefix: '/api/v1/listings', upstream: 'catalog' },
  { prefix: '/api/v1/me/listings', upstream: 'catalog' },
  { prefix: '/api/v1/admin/categories', upstream: 'catalog' },
  { prefix: '/api/v1/admin/listings', upstream: 'catalog' },
  // demand
  { prefix: '/api/v1/needs', upstream: 'demand' },
  { prefix: '/api/v1/me/needs', upstream: 'demand' },
  { prefix: '/api/v1/admin/needs', upstream: 'demand' },
  // matching
  { prefix: '/api/v1/needs/:needId/matches', upstream: 'matching' },
  { prefix: '/api/v1/me/matched-needs', upstream: 'matching' },
  // offer
  { prefix: '/api/v1/needs/:needId/offers', upstream: 'offer' },
  { prefix: '/api/v1/offers', upstream: 'offer' },
  { prefix: '/api/v1/me/offers', upstream: 'offer' },
  { prefix: '/api/v1/admin/offers', upstream: 'offer' },
  // transaction
  { prefix: '/api/v1/transactions', upstream: 'transaction' },
  { prefix: '/api/v1/me/transactions', upstream: 'transaction' },
  { prefix: '/api/v1/admin/transactions', upstream: 'transaction' },
  // reputation
  { prefix: '/api/v1/transactions/:transactionId/reviews', upstream: 'reputation' },
  { prefix: '/api/v1/users/:userId/reviews', upstream: 'reputation' },
  { prefix: '/api/v1/admin/reviews', upstream: 'reputation' },
  // moderation
  { prefix: '/api/v1/reports', upstream: 'moderation' },
  { prefix: '/api/v1/admin/moderation', upstream: 'moderation' },
  // notification
  { prefix: '/api/v1/me/notifications', upstream: 'notification' },
  // media
  { prefix: '/api/v1/media', upstream: 'media' },
];
