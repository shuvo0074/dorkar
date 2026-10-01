/**
 * Public routing table. Explicit and reviewable: a path not listed here is a 404 at the edge,
 * so internal endpoints (`/internal/*`, `/docs`, `/health` of services) are never exposed.
 * Add a line per public path prefix when a service ships new endpoints.
 */
export const Upstreams = ['identity'] as const;
export type Upstream = (typeof Upstreams)[number];

export interface RouteRule {
  prefix: string;
  upstream: Upstream;
}

export const ROUTE_TABLE: readonly RouteRule[] = [
  { prefix: '/api/v1/auth', upstream: 'identity' },
  { prefix: '/api/v1/me/account', upstream: 'identity' },
  { prefix: '/api/v1/me/sessions', upstream: 'identity' },
  { prefix: '/api/v1/me/devices', upstream: 'identity' },
  { prefix: '/api/v1/admin/accounts', upstream: 'identity' },
  { prefix: '/.well-known/jwks.json', upstream: 'identity' },
];
