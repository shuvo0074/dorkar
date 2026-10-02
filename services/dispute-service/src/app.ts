import { TransactionEvents } from '@dorkar/contracts';
import {
  createServiceRuntime,
  loadConfig,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type IdempotencyTables,
  type Logger,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { DisputeService } from './application/dispute-service';
import type { DisputeDB } from './infrastructure/db-schema';
import { pgDisputeStore, pgDisputeUnitOfWork } from './infrastructure/pg-dispute-store';
import { disputeRoutes } from './interfaces/http/routes';

export const disputeEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('dispute-service'),
  PORT: z.coerce.number().int().default(4016),
  DATABASE_SCHEMA: z.string().default('dispute'),
  DISPUTE_RESPONSE_HOURS: z.coerce.number().positive().default(72),
  DISPUTE_UNASSIGNED_ESCALATION_HOURS: z.coerce.number().positive().default(24),
});

type Job = (trx: Transaction<DisputeDB>) => Promise<number>;

/** Composition root. */
export async function buildDisputeService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier } = {},
): Promise<{
  runtime: ServiceRuntime<DisputeDB>;
  disputes: DisputeService;
  jobs: { respondentDeadline: Job; escalateUnassigned: Job };
}> {
  const config = loadConfig(disputeEnvSchema, env);
  const runtime = await createServiceRuntime<DisputeDB>({
    config,
    logger,
    producer: 'dispute',
    openapi: {
      title: 'Dorkar Dispute API',
      description: 'Dispute cases: statements, evidence, staff review and decisions.',
    },
    idempotency: true,
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const disputes = new DisputeService(pgDisputeUnitOfWork(runtime.db), runtime.event, {
    responseHours: config.DISPUTE_RESPONSE_HOURS,
    unassignedEscalationHours: config.DISPUTE_UNASSIGNED_ESCALATION_HOURS,
  });

  // Deal projection, and case opening/closing from the transaction's state (ADR-0009).
  runtime.on(TransactionEvents.TransactionCreated, (p, _e, trx) =>
    disputes.onTransactionCreated(pgDisputeStore(trx), p),
  );
  runtime.on(TransactionEvents.TransactionStateChanged, (p, e, trx) =>
    disputes.onTransactionStateChanged(pgDisputeStore(trx), p, e),
  );

  const jobs = {
    respondentDeadline: (trx: Transaction<DisputeDB>) => disputes.deadlineDue(pgDisputeStore(trx)),
    escalateUnassigned: (trx: Transaction<DisputeDB>) => disputes.escalateDue(pgDisputeStore(trx)),
  };
  runtime.every('dispute.respondent-deadline', 5 * 60_000, jobs.respondentDeadline);
  runtime.every('dispute.escalate-unassigned', 15 * 60_000, jobs.escalateUnassigned);

  await runtime.app.register(disputeRoutes, {
    disputes,
    runtime: runtime as unknown as ServiceRuntime<never>,
    idempotencyDb: runtime.db as unknown as Kysely<IdempotencyTables>,
  });
  return { runtime, disputes, jobs };
}
