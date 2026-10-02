import { Errors, type InternalClient } from '@dorkar/kernel';
import { z } from 'zod';
import type { VerificationGateway } from '../application/ports';

const EvaluationResponse = z.object({
  data: z.object({ satisfied: z.boolean(), missing: z.array(z.string()).default([]) }),
});

/**
 * verification-service policy check. Fails CLOSED: if verification cannot answer, the booking
 * is not created (503), never silently let an unverified renter through.
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
        amount: String(q.amount),
      });
      let raw: unknown;
      try {
        raw = await call(`/internal/v1/verification/evaluate?${params.toString()}`, { ctx });
      } catch {
        throw Errors.unavailable('Verification is temporarily unavailable. Please try again.');
      }
      const parsed = EvaluationResponse.safeParse(raw);
      if (!parsed.success) throw Errors.unavailable('Verification returned an invalid answer.');
      return parsed.data.data;
    },
  };
}
