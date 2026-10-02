import { ModerationEvents, TransactionEvents } from '@dorkar/contracts';
import {
  createServiceRuntime,
  loadConfig,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type Logger,
  type ServiceRuntime,
} from '@dorkar/kernel';
import { z } from 'zod';
import { ReputationService } from './application/reputation-service';
import type { ReputationDB } from './infrastructure/db-schema';
import { pgReputationStore, pgReputationUnitOfWork } from './infrastructure/pg-reputation-store';
import { reputationRoutes } from './interfaces/http/routes';

export const reputationEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('reputation-service'),
  PORT: z.coerce.number().int().default(4010),
  DATABASE_SCHEMA: z.string().default('reputation'),
  REVIEW_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  REVIEW_PAIR_CAP: z.coerce.number().int().min(1).max(100).default(3),
});

/** Composition root. */
export async function buildReputationService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier } = {},
): Promise<{ runtime: ServiceRuntime<ReputationDB>; reputation: ReputationService }> {
  const config = loadConfig(reputationEnvSchema, env);
  const runtime = await createServiceRuntime<ReputationDB>({
    config,
    logger,
    producer: 'reputation',
    openapi: {
      title: 'Dorkar Reputation API',
      description: 'Reviews after completed transactions and multiple reputation signals.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });
  const reputation = new ReputationService(pgReputationUnitOfWork(runtime.db), runtime.event, {
    reviewWindowDays: config.REVIEW_WINDOW_DAYS,
    reviewPairCap: config.REVIEW_PAIR_CAP,
  });

  // Projections from other services (each applied exactly once).
  runtime.on(TransactionEvents.TransactionCreated, (p, e, trx) =>
    reputation.onTransactionCreated(pgReputationStore(trx), p, e),
  );
  runtime.on(TransactionEvents.TransactionStateChanged, (p, e, trx) =>
    reputation.onTransactionStateChanged(pgReputationStore(trx), p, e),
  );
  runtime.on(ModerationEvents.ContentModerated, (p, e, trx) =>
    reputation.onContentModerated(pgReputationStore(trx), p, e),
  );

  await runtime.app.register(reputationRoutes, {
    reputation,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return { runtime, reputation };
}
