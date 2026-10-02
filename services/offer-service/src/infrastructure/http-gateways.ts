import { Errors, type InternalClient, type Logger } from '@dorkar/kernel';
import { z } from 'zod';
import type { ProfileDirectory, VerificationGateway } from '../application/ports';

const EvaluationResponse = z.object({
  data: z.object({ satisfied: z.boolean(), missing: z.array(z.string()).default([]) }),
});

/**
 * verification-service policy check. Fails CLOSED: if verification cannot answer, the offer is
 * not submitted (503) — never silently let an unverified seller through.
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

const CardsResponse = z.object({
  data: z.array(z.object({ accountId: z.string(), displayName: z.string() })),
});

/** profile-service public cards. Fails OPEN: names are decoration, so the list still renders. */
export function httpProfileDirectory(call: InternalClient, logger: Logger): ProfileDirectory {
  return {
    async displayNames(ids, ctx) {
      const names = new Map<string, string>();
      if (ids.length === 0) return names;
      try {
        const res = CardsResponse.parse(
          await call(`/internal/v1/profiles?ids=${ids.map(encodeURIComponent).join(',')}`, {
            ctx,
          }),
        );
        for (const c of res.data) names.set(c.accountId, c.displayName);
      } catch (err) {
        logger.warn({ err }, 'profile names unavailable; listing offers without them');
      }
      return names;
    },
  };
}
