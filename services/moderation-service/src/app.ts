import {
  createServiceRuntime,
  loadConfig,
  RedisRateLimiter,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type Logger,
  type RateLimiter,
  type ServiceRuntime,
} from '@dorkar/kernel';
import { z } from 'zod';
import { ModerationService } from './application/moderation-service';
import type { ModerationDB } from './infrastructure/db-schema';
import { pgModerationUnitOfWork } from './infrastructure/pg-moderation-store';
import { moderationRoutes } from './interfaces/http/routes';

export const moderationEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('moderation-service'),
  PORT: z.coerce.number().int().default(4011),
  DATABASE_SCHEMA: z.string().default('moderation'),
  REPORTS_PER_REPORTER_PER_DAY: z.coerce.number().int().min(1).default(20),
});

/** Composition root. */
export async function buildModerationService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; limiter?: RateLimiter } = {},
): Promise<{ runtime: ServiceRuntime<ModerationDB>; moderation: ModerationService }> {
  const config = loadConfig(moderationEnvSchema, env);
  const runtime = await createServiceRuntime<ModerationDB>({
    config,
    logger,
    producer: 'moderation',
    openapi: {
      title: 'Dorkar Moderation API',
      description: 'Reports, the moderation queue and moderator decisions.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });
  const moderation = new ModerationService(
    pgModerationUnitOfWork(runtime.db),
    runtime.event,
    overrides.limiter ?? new RedisRateLimiter(runtime.redis),
    { reportsPerReporterPerDay: config.REPORTS_PER_REPORTER_PER_DAY },
  );

  await runtime.app.register(moderationRoutes, {
    moderation,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return { runtime, moderation };
}
