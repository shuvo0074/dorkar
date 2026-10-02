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
import { CategoryService } from './application/category-service';
import { ListingService } from './application/listing-service';
import type { VerificationGateway } from './application/ports';
import type { CatalogDB } from './infrastructure/db-schema';
import { httpVerificationGateway } from './infrastructure/http-verification-gateway';
import { pgCatalogStore, pgCatalogUnitOfWork } from './infrastructure/pg-catalog-store';
import { categoryRoutes } from './interfaces/http/category-routes';
import { listingRoutes } from './interfaces/http/listing-routes';

export const catalogEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('catalog-service'),
  PORT: z.coerce.number().int().default(4004),
  DATABASE_SCHEMA: z.string().default('catalog'),
  VERIFICATION_URL: z.url().default('http://localhost:4003'),
});

/** Composition root. */
export async function buildCatalogService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; verification?: VerificationGateway } = {},
): Promise<{
  runtime: ServiceRuntime<CatalogDB>;
  categories: CategoryService;
  listings: ListingService;
}> {
  const config = loadConfig(catalogEnvSchema, env);
  const runtime = await createServiceRuntime<CatalogDB>({
    config,
    logger,
    producer: 'catalog',
    openapi: {
      title: 'Dorkar Catalog API',
      description: 'Category tree with attribute schemas; listings (the supply side).',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });
  const verification =
    overrides.verification ??
    httpVerificationGateway({ baseUrl: config.VERIFICATION_URL, token: config.INTERNAL_API_TOKEN });

  const uow = pgCatalogUnitOfWork(runtime.db);
  const categories = new CategoryService(uow, runtime.event);
  const listings = new ListingService(uow, runtime.event, verification);

  // Moderator decisions on listings (applied exactly once, inside the inbox transaction).
  runtime.on(ModerationEvents.ContentModerated, async (p, e, trx) => {
    if (p.targetType !== 'LISTING') return;
    await listings.onContentModerated(pgCatalogStore(trx), p, e);
  });

  // Stock reservations from deals (exactly once; the listing row is locked inside).
  runtime.on(TransactionEvents.TransactionCreated, (p, e, trx) =>
    listings.onTransactionCreated(pgCatalogStore(trx), p, e),
  );
  runtime.on(TransactionEvents.TransactionStateChanged, (p, e, trx) =>
    listings.onTransactionStateChanged(pgCatalogStore(trx), p, e),
  );

  const deps = { runtime: runtime as unknown as ServiceRuntime<never> };
  await runtime.app.register(categoryRoutes, { ...deps, categories });
  await runtime.app.register(listingRoutes, { ...deps, listings });
  return { runtime, categories, listings };
}
