import {
  CatalogEvents,
  ModerationEvents,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
} from '@dorkar/contracts';
import {
  createInternalClient,
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
import { LendItemService } from './application/lend-item-service';
import { LoanService } from './application/loan-service';
import type { VerificationGateway } from './application/ports';
import type { LendingDB } from './infrastructure/db-schema';
import { httpVerificationGateway } from './infrastructure/http-verification-gateway';
import { pgLendingStore, pgLendingUnitOfWork } from './infrastructure/pg-lending-store';
import { itemRoutes } from './interfaces/http/item-routes';
import { loanRoutes } from './interfaces/http/loan-routes';

export const lendingEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('lending-service'),
  PORT: z.coerce.number().int().default(4015),
  DATABASE_SCHEMA: z.string().default('lending'),
  VERIFICATION_URL: z.url().default('http://localhost:4003'),
  LOAN_REQUEST_TTL_HOURS: z.coerce.number().positive().default(48),
  LOAN_MAX_DAYS: z.coerce.number().int().min(1).max(365).default(60),
});

type Job = (trx: Transaction<LendingDB>) => Promise<number>;

/** Composition root. Tests may replace the verification port. */
export async function buildLendingService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; verification?: VerificationGateway } = {},
): Promise<{
  runtime: ServiceRuntime<LendingDB>;
  items: LendItemService;
  loans: LoanService;
  jobs: { expireRequests: Job; notifyOverdue: Job };
}> {
  const config = loadConfig(lendingEnvSchema, env);
  const runtime = await createServiceRuntime<LendingDB>({
    config,
    logger,
    producer: 'lending',
    openapi: {
      title: 'Dorkar Lending API',
      description: 'Neighbour-to-neighbour lending: shelves, borrow requests, trust gating.',
    },
    idempotency: true,
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const verification =
    overrides.verification ??
    httpVerificationGateway(
      createInternalClient({ baseUrl: config.VERIFICATION_URL, token: config.INTERNAL_API_TOKEN }),
    );

  const uow = pgLendingUnitOfWork(runtime.db);
  const items = new LendItemService(uow, runtime.event, verification, {
    maxLoanDays: config.LOAN_MAX_DAYS,
  });
  const loans = new LoanService(
    uow,
    runtime.event,
    verification,
    { requestTtlMs: config.LOAN_REQUEST_TTL_HOURS * 3_600_000 },
    logger,
  );

  // Projections and the transaction mirror (each applied exactly once, in the inbox trx).
  runtime.on(CatalogEvents.CategoryUpserted, (p, _e, trx) =>
    items.onCategoryUpserted(pgLendingStore(trx), p),
  );
  runtime.on(ReputationEvents.ReputationUpdated, (p, _e, trx) =>
    pgLendingStore(trx).setReputation(p.accountId, {
      completedCount: p.completedCount,
      ratingAverage: p.ratingAverage,
      ratingCount: p.ratingCount,
    }),
  );
  runtime.on(VerificationEvents.VerificationStatusChanged, async (p, _e, trx) => {
    if (p.kind !== 'NID') return;
    await pgLendingStore(trx).setNidVerified(p.accountId, p.status === 'VERIFIED');
  });
  runtime.on(ModerationEvents.ContentModerated, (p, e, trx) =>
    items.onContentModerated(pgLendingStore(trx), p, e),
  );
  runtime.on(TransactionEvents.TransactionCreated, (p, _e, trx) =>
    loans.onTransactionCreated(pgLendingStore(trx), p),
  );
  runtime.on(TransactionEvents.TransactionStateChanged, (p, e, trx) =>
    loans.onTransactionStateChanged(pgLendingStore(trx), p, e),
  );

  const jobs = {
    expireRequests: (trx: Transaction<LendingDB>) => loans.expireDue(pgLendingStore(trx)),
    notifyOverdue: (trx: Transaction<LendingDB>) => loans.notifyOverdue(pgLendingStore(trx)),
  };
  runtime.every('lending.expire-requests', 5 * 60_000, jobs.expireRequests);
  runtime.every('lending.overdue-loans', 15 * 60_000, jobs.notifyOverdue);

  const deps = {
    runtime: runtime as unknown as ServiceRuntime<never>,
    idempotencyDb: runtime.db as unknown as Kysely<IdempotencyTables>,
  };
  await runtime.app.register(itemRoutes, { items, ...deps });
  await runtime.app.register(loanRoutes, { loans, ...deps });
  return { runtime, items, loans, jobs };
}
