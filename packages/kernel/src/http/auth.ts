import { permissionsFor, Roles, type Permission, type Role } from '@dorkar/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { jwtVerify, type JWTVerifyGetKey, type CryptoKey, type KeyObject } from 'jose';
import type { Actor } from '../context';
import { Errors } from '../errors';

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  did: string;
  roles: Role[];
}

/** Port: identity verifies with its own key; other services with the JWKS endpoint. */
export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}

const ROLE_SET = new Set<string>(Roles);

export function createJwtVerifier(opts: {
  key: JWTVerifyGetKey | CryptoKey | KeyObject;
  issuer: string;
  audience: string;
}): AccessTokenVerifier {
  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, opts.key as JWTVerifyGetKey, {
          issuer: opts.issuer,
          audience: opts.audience,
          algorithms: ['EdDSA'],
          clockTolerance: 5,
        });
        const { sub, sid, did, roles } = payload as Record<string, unknown>;
        if (
          typeof sub !== 'string' ||
          typeof sid !== 'string' ||
          typeof did !== 'string' ||
          !Array.isArray(roles) ||
          !roles.every((r) => typeof r === 'string' && ROLE_SET.has(r))
        ) {
          throw new Error('malformed claims');
        }
        return { sub, sid, did, roles: roles as Role[] };
      } catch {
        throw Errors.unauthenticated('Invalid or expired access token.');
      }
    },
  };
}

export interface AuthenticatorOptions {
  verifier: AccessTokenVerifier;
  /** Optional extra check (identity uses it to reject revoked sessions immediately). */
  sessionCheck?: (claims: AccessTokenClaims) => Promise<boolean>;
}

/**
 * Returns Fastify preHandlers. Authorization decisions still belong to use-case policies;
 * these only establish *who* is calling and enforce coarse permissions.
 */
export function createAuthenticator(opts: AuthenticatorOptions) {
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw Errors.unauthenticated();
    const claims = await opts.verifier.verify(header.slice(7).trim());
    if (opts.sessionCheck && !(await opts.sessionCheck(claims))) {
      throw Errors.unauthenticated('Session is no longer valid.');
    }
    const actor: Actor = {
      id: claims.sub,
      sessionId: claims.sid,
      deviceId: claims.did,
      roles: claims.roles,
      permissions: permissionsFor(claims.roles),
    };
    request.ctx.actor = actor;
  };

  const requirePermission =
    (permission: Permission) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.ctx.actor) await authenticate(request, reply);
      if (!request.ctx.actor?.permissions.has(permission)) throw Errors.forbidden();
    };

  return { authenticate, requirePermission };
}

/** For handlers behind `authenticate`: the actor, or a 401 if wiring is wrong. */
export function actorOf(request: FastifyRequest): Actor {
  const actor = request.ctx.actor;
  if (!actor) throw Errors.unauthenticated();
  return actor;
}
