import {
  CatalogEvents,
  LendingEvents,
  ModerationEvents,
  OfferEvents,
  TransactionEvents,
} from '@dorkar/contracts';
import {
  createRedis,
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
import { MessagingService } from './application/messaging-service';
import type { MessagingDB } from './infrastructure/db-schema';
import { pgMessagingStore, pgMessagingUnitOfWork } from './infrastructure/pg-messaging-store';
import { RedisMessageNotifier } from './infrastructure/redis-message-notifier';
import { messagingRoutes } from './interfaces/http/routes';

export const messagingEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('messaging-service'),
  PORT: z.coerce.number().int().default(4017),
  DATABASE_SCHEMA: z.string().default('messaging'),
  MESSAGING_SEND_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  /** The gateway proxies with a 10s upstream timeout: a long poll must answer before that. */
  MESSAGING_LONG_POLL_MAX_SECONDS: z.coerce.number().int().min(0).max(9).default(8),
});

/** Composition root. Tests may replace the rate limiter. */
export async function buildMessagingService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; limiter?: RateLimiter } = {},
): Promise<{
  runtime: ServiceRuntime<MessagingDB>;
  messaging: MessagingService;
  notifier: RedisMessageNotifier;
}> {
  const config = loadConfig(messagingEnvSchema, env);
  const runtime = await createServiceRuntime<MessagingDB>({
    config,
    logger,
    producer: 'messaging',
    openapi: {
      title: 'Dorkar Messaging API',
      description: 'In-app conversations bound to listings, offers, transactions and lend items.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  // Dedicated subscriber connection (a subscribed client can issue no other commands);
  // published through the unprefixed bus connection.
  const notifier = new RedisMessageNotifier(
    runtime.bus,
    () => createRedis(config.REDIS_URL, { keyPrefix: null, commandTimeoutMs: null, logger }),
    logger,
  );
  runtime.app.addHook('onClose', async () => notifier.close());

  const messaging = new MessagingService(
    pgMessagingUnitOfWork(runtime.db),
    runtime.event,
    overrides.limiter ?? new RedisRateLimiter(runtime.redis),
    notifier,
    {
      sendPerMinute: config.MESSAGING_SEND_PER_MINUTE,
      longPollMaxSeconds: config.MESSAGING_LONG_POLL_MAX_SECONDS,
    },
    logger,
  );

  // Context projections (each applied exactly once, in the inbox transaction; out-of-order
  // deliveries are ignored by comparing the event time).
  const at = (e: { occurredAt: string }) => new Date(e.occurredAt);
  runtime.on(CatalogEvents.ListingPublished, (p, e, trx) =>
    messaging.onListing(pgMessagingStore(trx), p, at(e)),
  );
  runtime.on(CatalogEvents.ListingUpdated, (p, e, trx) =>
    messaging.onListing(pgMessagingStore(trx), p, at(e)),
  );
  runtime.on(CatalogEvents.ListingUnavailable, (p, e, trx) =>
    messaging.onListingUnavailable(pgMessagingStore(trx), p, at(e)),
  );
  runtime.on(LendingEvents.LendItemPublished, (p, e, trx) =>
    messaging.onLendItem(pgMessagingStore(trx), p, at(e)),
  );
  runtime.on(OfferEvents.OfferSubmitted, (p, e, trx) =>
    messaging.onOfferSubmitted(pgMessagingStore(trx), p, at(e)),
  );
  runtime.on(TransactionEvents.TransactionCreated, (p, e, trx) =>
    messaging.onTransactionCreated(pgMessagingStore(trx), p, at(e)),
  );
  runtime.on(ModerationEvents.ContentModerated, (p, _e, trx) =>
    messaging.onContentModerated(pgMessagingStore(trx), p),
  );

  await runtime.app.register(messagingRoutes, {
    messaging,
    runtime: runtime as unknown as ServiceRuntime<never>,
    longPollMaxSeconds: config.MESSAGING_LONG_POLL_MAX_SECONDS,
  });
  return { runtime, messaging, notifier };
}
