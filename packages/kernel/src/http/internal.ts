import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RequestContext } from '../context';
import { safeEqual } from '../crypto';
import { AppError, Errors } from '../errors';

/**
 * Service-to-service calls use `/internal/v1/*` routes, which the gateway never routes (its
 * table only lists public prefixes) and which additionally require a shared secret header.
 * The gateway strips any client-supplied `x-internal-*` header, so the token cannot be smuggled
 * through the public edge. mTLS can replace the shared secret without changing call sites.
 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

export function requireInternal(token: string) {
  const expected = Buffer.from(token);
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const got = request.headers[INTERNAL_TOKEN_HEADER];
    if (typeof got !== 'string' || !safeEqual(Buffer.from(got), expected)) {
      throw Errors.forbidden('Internal endpoint.');
    }
  };
}

export interface InternalClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

/**
 * Minimal internal HTTP client: short timeout, correlation propagation, error envelope mapped
 * back to AppError. Callers decide whether a failure is fail-open or fail-closed.
 */
export function createInternalClient(opts: InternalClientOptions) {
  return async function call<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST';
      body?: unknown;
      ctx?: Pick<RequestContext, 'requestId' | 'correlationId'>;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      [INTERNAL_TOKEN_HEADER]: opts.token,
    };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.ctx) {
      headers['x-request-id'] = init.ctx.requestId;
      headers['x-correlation-id'] = init.ctx.correlationId;
    }
    let res: Response;
    try {
      res = await fetch(new URL(path, opts.baseUrl), {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 1_500),
      });
    } catch {
      throw Errors.unavailable('A dependency is unavailable.');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: AppError['code']; message?: string; details?: Record<string, unknown> };
      };
      if (res.status >= 500 || !body.error?.code) throw Errors.unavailable('A dependency failed.');
      throw new AppError(
        body.error.code,
        body.error.message ?? 'Dependency error',
        body.error.details,
      );
    }
    return (await res.json()) as T;
  };
}
export type InternalClient = ReturnType<typeof createInternalClient>;
