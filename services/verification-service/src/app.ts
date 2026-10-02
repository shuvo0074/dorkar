import { IdentityEvents } from '@dorkar/contracts';
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
import { PolicyService } from './application/policy-service';
import type { Clock, NidProvider } from './application/ports';
import { VerificationService } from './application/verification-service';
import type { VerificationDB } from './infrastructure/db-schema';
import { hmacFingerprinter, ManualReviewNidProvider } from './infrastructure/nid-provider';
import {
  pgVerificationStore,
  pgVerificationUnitOfWork,
} from './infrastructure/pg-verification-store';
import { verificationRoutes } from './interfaces/http/routes';

export const verificationEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('verification-service'),
  PORT: z.coerce.number().int().default(4003),
  DATABASE_SCHEMA: z.string().default('verification'),
  NID_PROVIDER: z.enum(['manual']).default('manual'),
});

const RETENTION_JOB_INTERVAL_MS = 6 * 60 * 60_000;

/** Composition root. */
export async function buildVerificationService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: {
    verifier?: AccessTokenVerifier;
    nidProvider?: NidProvider;
    limiter?: RateLimiter;
    clock?: Clock;
  } = {},
): Promise<{
  runtime: ServiceRuntime<VerificationDB>;
  verifications: VerificationService;
  policies: PolicyService;
}> {
  const config = loadConfig(verificationEnvSchema, env);
  const runtime = await createServiceRuntime<VerificationDB>({
    config,
    logger,
    producer: 'verification',
    openapi: {
      title: 'Dorkar Verification API',
      description: 'Phone, NID and business verification; configurable verification policies.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });
  const uow = pgVerificationUnitOfWork(runtime.db);
  const verifications = new VerificationService(uow, runtime.event, {
    nidProvider: overrides.nidProvider ?? new ManualReviewNidProvider(),
    fingerprint: hmacFingerprinter(config.PII_HASH_KEY),
    limiter: overrides.limiter ?? new RedisRateLimiter(runtime.redis),
    clock: overrides.clock ?? { now: () => new Date() },
  });
  const policies = new PolicyService(uow);

  runtime.on(IdentityEvents.AccountCreated, (p, e, trx) =>
    verifications.onAccountCreated(pgVerificationStore(trx), p.accountId, e),
  );
  runtime.every('verification.purge-rejected-nid-fingerprints', RETENTION_JOB_INTERVAL_MS, (trx) =>
    verifications.purgeRejectedFingerprints(pgVerificationStore(trx)),
  );

  await runtime.app.register(verificationRoutes, {
    verifications,
    policies,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return { runtime, verifications, policies };
}
