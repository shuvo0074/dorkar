import {
  CatalogEvents,
  DemandEvents,
  OfferEvents,
  ProfileEvents,
  ReputationEvents,
  VerificationEvents,
} from '@dorkar/contracts';
import {
  createServiceRuntime,
  loadConfig,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type Logger,
  type ServiceRuntime,
} from '@dorkar/kernel';
import { z } from 'zod';
import { causedBy, MatchingService } from './application/matching-service';
import type { ListingFacts, MatchScorer, NeedFacts } from './application/ports';
import { RulesScorerV1 } from './domain/scoring';
import type { MatchingDB } from './infrastructure/db-schema';
import { pgMatchingStore, pgMatchingUnitOfWork } from './infrastructure/pg-matching-store';
import { matchingRoutes } from './interfaces/http/routes';

export const matchingEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('matching-service'),
  PORT: z.coerce.number().int().default(4007),
  DATABASE_SCHEMA: z.string().default('matching'),
  MATCH_MIN_SCORE: z.coerce.number().min(0).max(100).default(40),
  MATCH_MAX_PER_NEED: z.coerce.number().int().min(1).max(500).default(50),
  MATCH_REVERSE_SCAN_LIMIT: z.coerce.number().int().min(1).max(5000).default(200),
});

type NeedPayload = z.output<(typeof DemandEvents)['NeedPublished']['schema']>;
type ListingPayload = z.output<(typeof CatalogEvents)['ListingPublished']['schema']>;

const needFacts = (p: NeedPayload): NeedFacts => ({
  needId: p.needId,
  requesterId: p.requesterId,
  mode: p.mode,
  categoryId: p.categoryId,
  title: p.title,
  quantity: p.quantity,
  budgetMin: p.budgetMin?.amount ?? null,
  budgetMax: p.budgetMax?.amount ?? null,
  conditions: p.conditions,
  district: p.district,
  attributes: p.attributes,
  expiresAt: p.expiresAt,
});

const listingFacts = (p: ListingPayload): ListingFacts => ({
  listingId: p.listingId,
  sellerId: p.sellerId,
  categoryId: p.categoryId,
  kind: p.kind,
  condition: p.condition,
  priceAmount: p.price.amount,
  priceUnit: p.priceUnit,
  quantityAvailable: p.quantityAvailable,
  district: p.district,
  attributes: p.attributes,
  deliveryModes: p.deliveryModes,
});

/** Composition root. `scorer` lets a future ML scorer replace or wrap the rules. */
export async function buildMatchingService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; scorer?: MatchScorer } = {},
): Promise<{ runtime: ServiceRuntime<MatchingDB>; matching: MatchingService }> {
  const config = loadConfig(matchingEnvSchema, env);
  const runtime = await createServiceRuntime<MatchingDB>({
    config,
    logger,
    producer: 'matching',
    openapi: {
      title: 'Dorkar Matching API',
      description: 'Explainable need ↔ seller/listing matches.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });
  const matching = new MatchingService(
    pgMatchingUnitOfWork(runtime.db),
    runtime.event,
    overrides.scorer ?? new RulesScorerV1(),
    {
      minScore: config.MATCH_MIN_SCORE,
      maxPerNeed: config.MATCH_MAX_PER_NEED,
      reverseScanLimit: config.MATCH_REVERSE_SCAN_LIMIT,
    },
  );

  // Projections and matching triggers (each event applied exactly once, in the inbox transaction).
  runtime.on(CatalogEvents.CategoryUpserted, (p, _e, trx) =>
    pgMatchingStore(trx).upsertCategory({
      id: p.categoryId,
      parentId: p.parentId,
      modes: p.modes,
      active: p.active,
    }),
  );
  runtime.on(CatalogEvents.ListingPublished, (p, e, trx) =>
    matching.onListingPublished(pgMatchingStore(trx), listingFacts(p), causedBy(e)),
  );
  runtime.on(CatalogEvents.ListingUpdated, (p, _e, trx) =>
    pgMatchingStore(trx).upsertListing(listingFacts(p)),
  );
  runtime.on(CatalogEvents.ListingUnavailable, (p, _e, trx) =>
    pgMatchingStore(trx).setListingUnavailable(p.listingId),
  );
  runtime.on(ProfileEvents.SellerCapabilitiesChanged, (p, e, trx) =>
    matching.onSellerCapabilities(pgMatchingStore(trx), p, causedBy(e)),
  );
  runtime.on(DemandEvents.NeedPublished, (p, e, trx) =>
    matching.onNeedFacts(pgMatchingStore(trx), needFacts(p), e.occurredAt, causedBy(e)),
  );
  runtime.on(DemandEvents.NeedUpdated, (p, e, trx) =>
    matching.onNeedFacts(pgMatchingStore(trx), needFacts(p), null, causedBy(e)),
  );
  runtime.on(DemandEvents.NeedStatusChanged, (p, _e, trx) =>
    matching.onNeedStatusChanged(pgMatchingStore(trx), p.needId, p.to),
  );
  runtime.on(OfferEvents.OfferSubmitted, (p, _e, trx) =>
    matching.onOfferSubmitted(pgMatchingStore(trx), p.needId, p.sellerId),
  );
  runtime.on(ReputationEvents.ReputationUpdated, (p, _e, trx) =>
    pgMatchingStore(trx).setReputation(p.accountId, {
      ratingAverage: p.ratingAverage,
      ratingCount: p.ratingCount,
      completedCount: p.completedCount,
    }),
  );
  runtime.on(VerificationEvents.VerificationStatusChanged, async (p, _e, trx) => {
    if (p.kind === 'NID')
      await pgMatchingStore(trx).setNidVerified(p.accountId, p.status === 'VERIFIED');
  });

  await runtime.app.register(matchingRoutes, {
    matching,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return { runtime, matching };
}
