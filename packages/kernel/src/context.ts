import type { Permission, Role } from '@dorkar/contracts';

/** Authenticated principal, derived from a verified access token. */
export interface Actor {
  id: string;
  sessionId: string;
  deviceId: string;
  roles: readonly Role[];
  permissions: ReadonlySet<Permission>;
}

/**
 * Per-request metadata passed explicitly into use cases (no ambient globals), so the same
 * use case can run from HTTP, a job or an event consumer.
 */
export interface RequestContext {
  requestId: string;
  correlationId: string;
  /** Keyed hash of the client IP — never the raw address. */
  ipHash: string | null;
  userAgent: string | null;
  actor: Actor | null;
}

export const systemContext = (requestId: string): RequestContext => ({
  requestId,
  correlationId: requestId,
  ipHash: null,
  userAgent: null,
  actor: null,
});
