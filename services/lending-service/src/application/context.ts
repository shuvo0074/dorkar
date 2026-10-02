import { Errors, type Actor, type RequestContext } from '@dorkar/kernel';

export const requireActor = (ctx: RequestContext): Actor => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Context for work that is not an HTTP request (event consumers, jobs). */
export const derivedContext = (requestId: string, correlationId?: string): RequestContext => ({
  requestId,
  correlationId: correlationId ?? requestId,
  ipHash: null,
  userAgent: null,
  actor: null,
});
