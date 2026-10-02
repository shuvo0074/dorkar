import {
  BiddingEvents,
  CatalogEvents,
  MatchingEvents,
  ModerationEvents,
  OfferEvents,
  TransactionEvents,
} from '@dorkar/contracts';
import {
  createInternalClient,
  createServiceRuntime,
  loadConfig,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type Logger,
  type ServiceRuntime,
} from '@dorkar/kernel';
import { z } from 'zod';
import type { VerificationGateway } from './application/ports';
import { eventContext, NeedService } from './application/need-service';
import type { NeedPolicy } from './domain/need';
import type { DemandDB } from './infrastructure/db-schema';
import { httpVerificationGateway } from './infrastructure/http-verification-gateway';
import { pgNeedStore, pgNeedUnitOfWork } from './infrastructure/pg-need-store';
import { needRoutes } from './interfaces/http/routes';

const days = (d: number) => z.coerce.number().int().min(1).max(365).default(d);

export const demandEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('demand-service'),
  PORT: z.coerce.number().int().default(4005),
  DATABASE_SCHEMA: z.string().default('demand'),
  VERIFICATION_URL: z.url().default('http://localhost:4003'),
  NEED_DEFAULT_TTL_DAYS: days(14),
  NEED_MAX_TTL_DAYS: days(60),
  NEED_MAX_RENEWALS: z.coerce.number().int().min(0).max(100).default(2),
  NEED_MAX_OPEN_PER_USER: z.coerce.number().int().min(1).max(10_000).default(20),
  NEED_MAX_OFFERS: z.coerce.number().int().min(1).max(10_000).default(50),
  NEED_EXPIRY_BATCH: z.coerce.number().int().min(1).max(10_000).default(500),
});
export type DemandConfig = z.infer<typeof demandEnvSchema>;

/** Composition root. */
export async function buildDemandService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; verification?: VerificationGateway } = {},
): Promise<{
  runtime: ServiceRuntime<DemandDB>;
  needs: NeedService;
  config: DemandConfig;
  expireNeeds: () => Promise<number>;
}> {
  const config = loadConfig(demandEnvSchema, env);
  const runtime = await createServiceRuntime<DemandDB>({
    config,
    logger,
    producer: 'demand',
    openapi: {
      title: 'Dorkar Demand API',
      description: 'Post a Need: buyer needs, their lifecycle and the open-needs feed.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const policy: NeedPolicy = {
    defaultTtlDays: config.NEED_DEFAULT_TTL_DAYS,
    maxTtlDays: config.NEED_MAX_TTL_DAYS,
    maxRenewals: config.NEED_MAX_RENEWALS,
    maxOpenPerUser: config.NEED_MAX_OPEN_PER_USER,
    maxOffers: config.NEED_MAX_OFFERS,
  };
  const verification =
    overrides.verification ??
    httpVerificationGateway(
      createInternalClient({ baseUrl: config.VERIFICATION_URL, token: config.INTERNAL_API_TOKEN }),
    );
  const needs = new NeedService(pgNeedUnitOfWork(runtime.db), runtime.event, policy, verification);

  // Projections and lifecycle driven by other services (each applied exactly once).
  runtime.on(CatalogEvents.CategoryUpserted, (p, _e, trx) =>
    pgNeedStore(trx).upsertCategory({
      id: p.categoryId,
      parentId: p.parentId,
      slug: p.slug,
      nameEn: p.nameEn,
      nameBn: p.nameBn,
      modes: p.modes,
      attributeSchema: p.attributeSchema,
      active: p.active,
    }),
  );
  runtime.on(OfferEvents.OfferSubmitted, (p, _e, trx) =>
    needs.onOfferSubmitted(pgNeedStore(trx), p.needId),
  );
  runtime.on(OfferEvents.OfferAccepted, (p, e, trx) =>
    needs.onOfferAccepted(pgNeedStore(trx), p, eventContext(e)),
  );
  runtime.on(OfferEvents.OfferStatusChanged, async (p, e, trx) => {
    if (p.from === 'ACCEPTED' && p.to === 'CANCELLED') {
      await needs.onOfferCancelled(pgNeedStore(trx), p.offerId, eventContext(e));
    }
  });
  // A reverse auction's award is an acceptance like an accepted offer, keyed by the auction id.
  runtime.on(BiddingEvents.AuctionAwarded, async (p, e, trx) => {
    if (p.kind === 'REVERSE' && p.needId) {
      await needs.onOfferAccepted(
        pgNeedStore(trx),
        { offerId: p.auctionId, needId: p.needId, quantity: p.quantity },
        eventContext(e),
      );
    }
  });
  runtime.on(TransactionEvents.TransactionStateChanged, async (p, e, trx) => {
    if (p.to === 'COMPLETED' && p.needId && p.sourceType === 'OFFER') {
      await needs.onTransactionCompleted(pgNeedStore(trx), p.sourceId, eventContext(e));
    }
    // Offer-sourced cancellations arrive as OfferStatusChanged; auction-sourced ones only here.
    if (p.needId && p.sourceType === 'AUCTION') {
      if (p.to === 'COMPLETED') {
        await needs.onTransactionCompleted(pgNeedStore(trx), p.sourceId, eventContext(e));
      } else if (p.to === 'CANCELLED' || p.to === 'EXPIRED' || p.to === 'REFUNDED') {
        await needs.onOfferCancelled(pgNeedStore(trx), p.sourceId, eventContext(e));
      }
    }
  });
  runtime.on(ModerationEvents.ContentModerated, async (p, e, trx) => {
    if (p.targetType === 'NEED') {
      await needs.onContentModerated(pgNeedStore(trx), p, eventContext(e));
    }
  });
  runtime.on(MatchingEvents.MatchFound, (p, _e, trx) =>
    pgNeedStore(trx).addMatch(p.needId, p.sellerId),
  );

  const expire = (trx: Parameters<Parameters<typeof runtime.every>[2]>[0]) =>
    needs.expireDue(pgNeedStore(trx), config.NEED_EXPIRY_BATCH);
  runtime.every('demand.expire-needs', 60_000, expire);

  await runtime.app.register(needRoutes, {
    needs,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return {
    runtime,
    needs,
    config,
    /** The expiry job body in its own transaction (tests, manual runs). */
    expireNeeds: () => runtime.db.transaction().execute(expire),
  };
}
