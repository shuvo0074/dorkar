import { AppError, Errors, type InternalClient } from '@dorkar/kernel';
import { z } from 'zod';
import type { VerificationGateway } from '../application/ports';

const EvaluationResponse = z.object({
  data: z.object({ satisfied: z.boolean(), missing: z.array(z.string()) }),
});

/**
 * verification-service policy check. Fails closed: if the policy cannot be evaluated (network,
 * 5xx, unexpected answer), publishing is refused with 503 rather than skipping verification.
 */
export function httpVerificationGateway(call: InternalClient): VerificationGateway {
  return {
    async evaluate(q, ctx) {
      const params = new URLSearchParams({
        accountId: q.accountId,
        // Roles from the verified token, so ROLE-scoped policies (e.g. BUSINESS) apply.
        ...(ctx.actor ? { roles: ctx.actor.roles.join(',') } : {}),
        action: q.action,
        categoryId: q.categoryId,
        mode: q.mode,
        ...(q.amount !== null ? { amount: String(q.amount) } : {}),
      });
      let body: unknown;
      try {
        body = await call(`/internal/v1/verification/evaluate?${params.toString()}`, { ctx });
      } catch (err) {
        if (err instanceof AppError && err.code === 'UNAVAILABLE') throw err;
        throw Errors.unavailable('Verification is temporarily unavailable. Try again shortly.');
      }
      const parsed = EvaluationResponse.safeParse(body);
      if (!parsed.success) {
        throw Errors.unavailable('Verification is temporarily unavailable. Try again shortly.');
      }
      return parsed.data.data;
    },
  };
}
