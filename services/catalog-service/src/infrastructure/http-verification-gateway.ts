import { createInternalClient, Errors } from '@dorkar/kernel';
import { z } from 'zod';
import type { VerificationGateway } from '../application/ports';

const Decision = z.object({
  satisfied: z.boolean(),
  missing: z.array(z.string()).default([]),
});

/**
 * Asks verification's policy engine whether a seller may publish. Fails CLOSED: any transport
 * error, non-2xx answer or malformed body becomes 503, never an implicit "allowed".
 */
export function httpVerificationGateway(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}): VerificationGateway {
  const call = createInternalClient({
    baseUrl: opts.baseUrl,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? 1_500,
  });
  const unavailable = () =>
    Errors.unavailable('We could not check verification right now. Please try again shortly.');

  return {
    async evaluate(q, ctx) {
      const params = new URLSearchParams({
        accountId: q.accountId,
        action: q.action,
        categoryId: q.categoryId,
        amount: String(q.amount),
      });
      let body: unknown;
      try {
        body = await call<unknown>(`/internal/v1/verification/evaluate?${params.toString()}`, {
          ctx: { requestId: ctx.requestId, correlationId: ctx.correlationId },
        });
      } catch {
        throw unavailable();
      }
      // Standard `{ data }` envelope; tolerate a bare decision too.
      const inner = typeof body === 'object' && body !== null && 'data' in body ? body.data : body;
      const parsed = Decision.safeParse(inner);
      if (!parsed.success) throw unavailable();
      return parsed.data;
    },
  };
}
