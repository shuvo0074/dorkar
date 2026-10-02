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
  serviceEnvSchema,
  type AccessTokenVerifier,
  type IdempotencyTables,
  type Logger,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { OfferService } from './application/offer-service';
import type { ProfileDirectory, VerificationGateway } from './application/ports';
import type { OfferDB } from './infrastructure/db-schema';
import { httpProfileDirectory, httpVerificationGateway } from './infrastructure/http-gateways';
import { pgOfferStore, pgOfferUnitOfWork } from './infrastructure/pg-offer-store';
import { offerRoutes } from './interfaces/http/routes';

export const offerEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('offer-service'),
  PORT: z.coerce.number().int().default(4008),
  DATABASE_SCHEMA: z.string().default('offer'),
  OFFER_DEFAULT_TTL_HOURS: z.coerce.number().int().min(1).default(72),
  OFFER_MAX_TTL_DAYS: z.coerce.number().int().min(1).default(14),
  OFFER_MAX_ROUNDS: z.coerce.number().int().min(1).max(20).default(5),
  VERIFICATION_URL: z.url().default('http://localhost:4003'),
  PROFILE_URL: z.url().default('http://localhost:4002'),
});

/** Composition root. Tests may replace the outbound ports. */
export async function buildOfferService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: {
    verifier?: AccessTokenVerifier;
    verification?: VerificationGateway;
    profiles?: ProfileDirectory;
  } = {},
): Promise<{ runtime: ServiceRuntime<OfferDB>; offers: OfferService }> {
  const config = loadConfig(offerEnvSchema, env);
  const runtime = await createServiceRuntime<OfferDB>({
    config,
    logger,
    producer: 'offer',
    openapi: {
      title: 'Dorkar Offer API',
      description: 'Offers on needs, negotiation rounds, exclusive acceptance.',
    },
    idempotency: true,
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const verification =
    overrides.verification ??
    httpVerificationGateway(
      createInternalClient({ baseUrl: config.VERIFICATION_URL, token: config.INTERNAL_API_TOKEN }),
    );
  const profiles =
    overrides.profiles ??
    httpProfileDirectory(
      createInternalClient({ baseUrl: config.PROFILE_URL, token: config.INTERNAL_API_TOKEN }),
      logger,
    );

  const offers = new OfferService(
    pgOfferUnitOfWork(runtime.db),
    runtime.event,
    verification,
    profiles,
    {
      defaultTtlHours: config.OFFER_DEFAULT_TTL_HOURS,
      maxTtlDays: config.OFFER_MAX_TTL_DAYS,
      maxRounds: config.OFFER_MAX_ROUNDS,
    },
  );

  // Projections and lifecycle from other services (each applied exactly once, in the inbox trx).
  runtime.on(DemandEvents.NeedPublished, (p, _e, trx) =>
    offers.onNeedFacts(pgOfferStore(trx), p, 'PUBLISHED'),
  );
  runtime.on(DemandEvents.NeedUpdated, (p, _e, trx) =>
    offers.onNeedFacts(pgOfferStore(trx), p, 'UPDATED'),
  );
  runtime.on(DemandEvents.NeedStatusChanged, (p, e, trx) =>
    offers.onNeedStatusChanged(pgOfferStore(trx), p, e),
  );
  runtime.on(CatalogEvents.ListingPublished, (p, _e, trx) =>
    offers.onListing(pgOfferStore(trx), p),
  );
  runtime.on(CatalogEvents.ListingUpdated, (p, _e, trx) => offers.onListing(pgOfferStore(trx), p));
  runtime.on(CatalogEvents.ListingUnavailable, (p, _e, trx) =>
    offers.onListing(pgOfferStore(trx), p),
  );
  runtime.on(TransactionEvents.TransactionStateChanged, (p, e, trx) =>
    offers.onTransactionStateChanged(pgOfferStore(trx), p, e),
  );
  runtime.on(ModerationEvents.ContentModerated, (p, _e, trx) =>
    offers.onContentModerated(pgOfferStore(trx), p),
  );

  runtime.every('offer.expire-offers', 60_000, (trx) => offers.expireDue(pgOfferStore(trx)));

  await runtime.app.register(offerRoutes, {
    offers,
    runtime: runtime as unknown as ServiceRuntime<never>,
    db: runtime.db as unknown as Kysely<IdempotencyTables>,
  });
  return { runtime, offers };
}
