import { CatalogEvents, OfferEvents } from '@dorkar/contracts';
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
import { TransactionService } from './application/transaction-service';
import { policyFrom } from './domain/transaction';
import type { TransactionDB } from './infrastructure/db-schema';
import { pgTransactionStore, pgTransactionUnitOfWork } from './infrastructure/pg-transaction-store';
import {
  CashPaymentProvider,
  mvpProviderSelection,
  providerRegistry,
  SelfArrangedDelivery,
} from './infrastructure/providers';
import { transactionRoutes } from './interfaces/http/routes';

export const transactionEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('transaction-service'),
  PORT: z.coerce.number().int().default(4009),
  DATABASE_SCHEMA: z.string().default('txn'),
  TRANSACTION_CONFIRM_TTL_HOURS: z.coerce.number().positive().default(48),
  TRANSACTION_AUTO_COMPLETE_DAYS: z.coerce.number().positive().default(3),
  TRANSACTION_DISPUTE_WINDOW_DAYS: z.coerce.number().positive().default(3),
});

type Job = (trx: Transaction<TransactionDB>) => Promise<number>;

/** Composition root. */
export async function buildTransactionService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier } = {},
): Promise<{
  runtime: ServiceRuntime<TransactionDB>;
  txns: TransactionService;
  jobs: { expireUnconfirmed: Job; autoComplete: Job };
}> {
  const config = loadConfig(transactionEnvSchema, env);
  const runtime = await createServiceRuntime<TransactionDB>({
    config,
    logger,
    producer: 'transaction',
    openapi: {
      title: 'Dorkar Transaction API',
      description: 'Agreed deals: confirmation, delivery, completion, disputes.',
    },
    idempotency: true,
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const txns = new TransactionService(
    pgTransactionUnitOfWork(runtime.db),
    runtime.event,
    providerRegistry([new CashPaymentProvider()]),
    providerRegistry([new SelfArrangedDelivery()]),
    mvpProviderSelection,
    policyFrom({
      confirmTtlHours: config.TRANSACTION_CONFIRM_TTL_HOURS,
      autoCompleteDays: config.TRANSACTION_AUTO_COMPLETE_DAYS,
      disputeWindowDays: config.TRANSACTION_DISPUTE_WINDOW_DAYS,
    }),
  );

  // A deal exists once an offer is accepted (exactly once per offer: inbox + unique source).
  runtime.on(OfferEvents.OfferAccepted, (p, e, trx) =>
    txns.onOfferAccepted(pgTransactionStore(trx), p, e),
  );
  // Listing projection for direct purchases.
  const listing = (p: z.output<typeof CatalogEvents.ListingPublished.schema>) => ({
    listingId: p.listingId,
    sellerId: p.sellerId,
    kind: p.kind,
    title: p.title,
    price: p.price.amount,
    currency: p.price.currency,
    priceUnit: p.priceUnit,
    quantityAvailable: p.quantityAvailable,
    deliveryModes: p.deliveryModes,
  });
  runtime.on(CatalogEvents.ListingPublished, (p, _e, trx) =>
    pgTransactionStore(trx).upsertListing(listing(p), true),
  );
  runtime.on(CatalogEvents.ListingUpdated, (p, _e, trx) =>
    pgTransactionStore(trx).upsertListing(listing(p), false),
  );
  runtime.on(CatalogEvents.ListingUnavailable, (p, _e, trx) =>
    pgTransactionStore(trx).markListingUnavailable(p.listingId),
  );

  const jobs = {
    expireUnconfirmed: (trx: Transaction<TransactionDB>) => txns.expireDue(pgTransactionStore(trx)),
    autoComplete: (trx: Transaction<TransactionDB>) =>
      txns.autoCompleteDue(pgTransactionStore(trx)),
  };
  runtime.every('transaction.expire-unconfirmed', 5 * 60_000, jobs.expireUnconfirmed);
  runtime.every('transaction.auto-complete', 15 * 60_000, jobs.autoComplete);

  await runtime.app.register(transactionRoutes, {
    txns,
    runtime: runtime as unknown as ServiceRuntime<never>,
    idempotencyDb: runtime.db as unknown as Kysely<IdempotencyTables>,
  });
  return { runtime, txns, jobs };
}
