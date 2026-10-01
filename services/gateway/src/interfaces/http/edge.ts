import { permissionsFor } from '@dorkar/contracts';
import {
  AppError,
  Errors,
  type AccessTokenVerifier,
  type App,
  type RateLimiter,
} from '@dorkar/kernel';
import type { FastifyRequest } from 'fastify';
import type { RevocationStore } from '../../application/revocation';

export interface EdgeOptions {
  verifier: AccessTokenVerifier;
  revocations: RevocationStore;
  limiter: RateLimiter;
  limits: { ipPerMinute: number; actorPerMinute: number };
}

const isHealth = (req: FastifyRequest) => req.url.startsWith('/health/');

/**
 * Edge policy, in order:
 *  1. Authentication — only when a bearer token is presented. Requests without one pass through;
 *     each service decides which endpoints are public. Invalid or revoked tokens stop here.
 *  2. Coarse rate limits per client IP and per account. Business limits live in services.
 * Services still verify tokens themselves (defence in depth); the gateway adds immediate
 * revocation and stops abusive traffic before it reaches them.
 */
export function registerEdgePolicy(app: App, opts: EdgeOptions): void {
  app.addHook('onRequest', async (req) => {
    if (isHealth(req)) return;
    const header = req.headers.authorization;
    if (header === undefined) return;
    if (!header.startsWith('Bearer ')) throw Errors.unauthenticated();

    const claims = await opts.verifier.verify(header.slice(7).trim());
    let revoked = false;
    try {
      revoked = await opts.revocations.isRevoked(claims);
    } catch (err) {
      // Fail open: the token is still cryptographically valid and expires within minutes;
      // refusing every authenticated request during a Redis blip would be a self-inflicted outage.
      req.log.warn({ err }, 'revocation check unavailable');
    }
    if (revoked) throw new AppError('SESSION_REVOKED', 'Session has ended. Please sign in again.');

    req.ctx.actor = {
      id: claims.sub,
      sessionId: claims.sid,
      deviceId: claims.did,
      roles: claims.roles,
      permissions: permissionsFor(claims.roles),
    };
  });

  app.addHook('onRequest', async (req) => {
    if (isHealth(req) || req.method === 'OPTIONS') return;
    const rules = [];
    if (req.ctx.ipHash) {
      rules.push({
        key: `edge:ip:${req.ctx.ipHash}`,
        limit: opts.limits.ipPerMinute,
        windowMs: 60_000,
      });
    }
    if (req.ctx.actor) {
      rules.push({
        key: `edge:actor:${req.ctx.actor.id}`,
        limit: opts.limits.actorPerMinute,
        windowMs: 60_000,
      });
    }
    try {
      const verdict = await opts.limiter.consume(rules);
      if (!verdict.allowed) throw Errors.rateLimited(verdict.retryAfterMs);
    } catch (err) {
      if (err instanceof AppError) throw err;
      req.log.warn({ err }, 'edge rate limiter unavailable; allowing request');
    }
  });
}
