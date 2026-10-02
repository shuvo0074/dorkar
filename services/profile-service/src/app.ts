import { IdentityEvents, ReputationEvents, VerificationEvents } from '@dorkar/contracts';
import {
  createServiceRuntime,
  loadConfig,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type Logger,
  type ServiceRuntime,
} from '@dorkar/kernel';
import { z } from 'zod';
import { ProfileService } from './application/profile-service';
import type { ProfileDB } from './infrastructure/db-schema';
import { pgProfileStore, pgProfileUnitOfWork } from './infrastructure/pg-profile-store';
import { profileRoutes } from './interfaces/http/routes';

export const profileEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('profile-service'),
  PORT: z.coerce.number().int().default(4002),
  DATABASE_SCHEMA: z.string().default('profile'),
});

/** Composition root. */
export async function buildProfileService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier } = {},
): Promise<{ runtime: ServiceRuntime<ProfileDB>; profiles: ProfileService }> {
  const config = loadConfig(profileEnvSchema, env);
  const runtime = await createServiceRuntime<ProfileDB>({
    config,
    logger,
    producer: 'profile',
    openapi: {
      title: 'Dorkar Profile API',
      description: 'Profiles, seller capabilities, public cards.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });
  const profiles = new ProfileService(pgProfileUnitOfWork(runtime.db), runtime.event);

  // Projections and lifecycle from other services (each applied exactly once).
  runtime.on(IdentityEvents.AccountCreated, (p, _e, trx) =>
    profiles.onAccountCreated(pgProfileStore(trx), p.accountId),
  );
  runtime.on(IdentityEvents.AccountStatusChanged, (p, _e, trx) =>
    profiles.onAccountStatusChanged(pgProfileStore(trx), p.accountId, p.to),
  );
  runtime.on(ReputationEvents.ReputationUpdated, (p, _e, trx) =>
    pgProfileStore(trx).setReputation(p.accountId, {
      ratingAverage: p.ratingAverage,
      ratingCount: p.ratingCount,
      completedCount: p.completedCount,
      cancelledCount: p.cancelledCount,
      disputedCount: p.disputedCount,
    }),
  );
  runtime.on(VerificationEvents.VerificationStatusChanged, (p, _e, trx) =>
    pgProfileStore(trx).setVerification(p.accountId, p.kind, p.status),
  );

  await runtime.app.register(profileRoutes, {
    profiles,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return { runtime, profiles };
}
