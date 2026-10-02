import {
  CatalogEvents,
  DemandEvents,
  ModerationEvents,
  TransactionEvents,
} from '@dorkar/contracts';
import {
  createInternalClient,
  createServiceRuntime,
  loadConfig,
  RedisRateLimiter,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type IdempotencyTables,
  type Logger,
  type RateLimiter,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { BiddingService } from './application/bidding-service';
import type { VerificationGateway } from './application/ports';
import type { BiddingDB } from './infrastructure/db-schema';
import { httpVerificationGateway } from './infrastructure/http-gateways';
import { pgAuctionStore, pgAuctionUnitOfWork } from './infrastructure/pg-auction-store';
import { biddingRoutes } from './interfaces/http/routes';

export const biddingEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('bidding-service'),
  PORT: z.coerce.number().int().default(4013),
  DATABASE_SCHEMA: z.string().default('bidding'),
  BIDDING_RETRACT_WINDOW_SECONDS: z.coerce.number().int().min(0).default(60),
  BIDDING_DEFAULT_ANTI_SNIPE_SECONDS: z.coerce.number().int().min(0).max(600).default(120),
  BIDDING_MAX_DURATION_DAYS: z.coerce.number().int().min(1).default(14),
  VERIFICATION_URL: z.url().default('http://localhost:4003'),
});

/** Composition root. Tests may replace the outbound ports. */
export async function buildBiddingService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: {
    verifier?: AccessTokenVerifier;
    verification?: VerificationGateway;
    limiter?: RateLimiter;
  } = {},
): Promise<{ runtime: ServiceRuntime<BiddingDB>; bidding: BiddingService }> {
  const config = loadConfig(biddingEnvSchema, env);
  const runtime = await createServiceRuntime<BiddingDB>({
    config,
    logger,
    producer: 'bidding',
    openapi: {
      title: 'Dorkar Bidding API',
      description: 'Forward and reverse auctions, atomic bidding, anti-sniping, awards.',
    },
    idempotency: true,
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const verification =
    overrides.verification ??
    httpVerificationGateway(
      createInternalClient({ baseUrl: config.VERIFICATION_URL, token: config.INTERNAL_API_TOKEN }),
    );

  const bidding = new BiddingService(
    pgAuctionUnitOfWork(runtime.db),
    runtime.event,
    verification,
    overrides.limiter ?? new RedisRateLimiter(runtime.redis),
    {
      retractWindowSeconds: config.BIDDING_RETRACT_WINDOW_SECONDS,
      defaultAntiSnipeSeconds: config.BIDDING_DEFAULT_ANTI_SNIPE_SECONDS,
      maxDurationDays: config.BIDDING_MAX_DURATION_DAYS,
      bidsPerMinute: 10,
    },
  );

  // Projections and lifecycle from other services (each applied exactly once, in the inbox trx).
  runtime.on(CatalogEvents.ListingPublished, (p, _e, trx) =>
    bidding.onListing(pgAuctionStore(trx), p),
  );
  runtime.on(CatalogEvents.ListingUpdated, (p, _e, trx) =>
    bidding.onListing(pgAuctionStore(trx), p),
  );
  runtime.on(CatalogEvents.ListingUnavailable, (p, e, trx) =>
    bidding.onListingUnavailable(pgAuctionStore(trx), p, e),
  );
  runtime.on(DemandEvents.NeedPublished, (p, _e, trx) =>
    bidding.onNeed(pgAuctionStore(trx), p, 'PUBLISHED'),
  );
  runtime.on(DemandEvents.NeedUpdated, (p, _e, trx) =>
    bidding.onNeed(pgAuctionStore(trx), p, 'UPDATED'),
  );
  runtime.on(DemandEvents.NeedStatusChanged, (p, e, trx) =>
    bidding.onNeedStatusChanged(pgAuctionStore(trx), p, e),
  );
  runtime.on(ModerationEvents.ContentModerated, (p, _e, trx) =>
    bidding.onContentModerated(pgAuctionStore(trx), p),
  );
  runtime.on(TransactionEvents.TransactionCreated, (p, _e, trx) =>
    bidding.onTransactionCreated(pgAuctionStore(trx), p),
  );

  // Cluster-single jobs on the DB clock.
  runtime.every('bidding.open-auctions', 15_000, (trx) => bidding.openDue(pgAuctionStore(trx)));
  runtime.every('bidding.close-auctions', 15_000, (trx) => bidding.closeDue(pgAuctionStore(trx)));

  await runtime.app.register(biddingRoutes, {
    bidding,
    runtime: runtime as unknown as ServiceRuntime<never>,
    db: runtime.db as unknown as Kysely<IdempotencyTables>,
  });
  return { runtime, bidding };
}
