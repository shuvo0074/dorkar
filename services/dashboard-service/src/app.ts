import {
  ActivityEvents,
  BiddingEvents,
  CatalogEvents,
  DemandEvents,
  DisputeEvents,
  IdentityEvents,
  LendingEvents,
  MessagingEvents,
  OfferEvents,
  ProfileEvents,
  RentalEvents,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
  type EventEnvelope,
} from '@dorkar/contracts';
import {
  createServiceRuntime,
  loadConfig,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type EventDefinition,
  type Logger,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { Transaction } from 'kysely';
import { z } from 'zod';
import { ActivityService } from './application/activity-service';
import {
  MetricsService,
  PersonalDashboardService,
  type Summary,
} from './application/metrics-service';
import type { ProjectionStore } from './application/ports';
import { Projector } from './application/projector';
import type { DashboardDB } from './infrastructure/db-schema';
import { pgActivityStore, pgActivityUnitOfWork } from './infrastructure/pg-activity-store';
import { pgDashboardReader } from './infrastructure/pg-dashboard-reader';
import { pgProjectionStore } from './infrastructure/pg-projection-store';
import { redisSummaryCache } from './infrastructure/redis-summary-cache';
import { dashboardRoutes } from './interfaces/http/routes';

const DEFAULT_PRODUCERS =
  'identity,profile,verification,catalog,demand,matching,offer,transaction,reputation,moderation,notification,media,bidding,rental,lending,dispute,messaging,dashboard';

export const dashboardEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('dashboard-service'),
  PORT: z.coerce.number().int().default(4018),
  DATABASE_SCHEMA: z.string().default('dashboard'),
  /** Streams to read `audit.ActivityRecorded` from. */
  ACTIVITY_PRODUCERS: z
    .string()
    .default(DEFAULT_PRODUCERS)
    .transform((v) => [
      ...new Set(
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.string().regex(/^[a-z]+$/)).min(1)),
  ACTIVITY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(365),
  DASHBOARD_CACHE_SECONDS: z.coerce.number().int().min(0).max(3600).default(30),
});
export type DashboardConfig = z.infer<typeof dashboardEnvSchema>;

/** Composition root. */
export async function buildDashboardService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; now?: () => Date } = {},
): Promise<{
  runtime: ServiceRuntime<DashboardDB>;
  config: DashboardConfig;
  activity: ActivityService;
  metrics: MetricsService;
}> {
  const config = loadConfig(dashboardEnvSchema, env);
  const runtime = await createServiceRuntime<DashboardDB>({
    config,
    logger,
    producer: 'dashboard',
    openapi: {
      title: 'Dorkar Dashboard API',
      description:
        'Admin BFF (platform metrics, cross-service activity log) and the personal dashboard. Read models fed by events.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });
  const now = overrides.now ?? (() => new Date());

  const activity = new ActivityService(pgActivityUnitOfWork(runtime.db), {
    retentionDays: config.ACTIVITY_RETENTION_DAYS,
    now,
  });
  const reader = pgDashboardReader(runtime.db);
  const metrics = new MetricsService(
    reader,
    // Keyed by schema so parallel test schemas (and blue/green schemas) never share a summary.
    redisSummaryCache<Summary>(runtime.redis, `summary:${config.DATABASE_SCHEMA}`, logger),
    { cacheSeconds: config.DASHBOARD_CACHE_SECONDS, now },
  );
  const personal = new PersonalDashboardService(reader);
  const projector = new Projector();

  // ---- activity log (every producer's stream) ----
  runtime.on(
    ActivityEvents.ActivityRecorded,
    (p, e, trx) => activity.onActivityRecorded(pgActivityStore(trx), p, e),
    { producers: config.ACTIVITY_PRODUCERS },
  );
  runtime.on(ProfileEvents.ProfileUpdated, (p, e, trx) =>
    activity.onProfileUpdated(pgActivityStore(trx), p, e),
  );

  // ---- metrics and projections (each applied exactly once, in the inbox transaction) ----
  const project = <S extends z.ZodType>(
    def: EventDefinition<S>,
    fn: (s: ProjectionStore, p: z.output<S>, e: EventEnvelope) => Promise<void>,
  ) => runtime.on(def, (p, e, trx: Transaction<DashboardDB>) => fn(pgProjectionStore(trx), p, e));

  runtime.on(IdentityEvents.AccountStatusChanged, async (p, e, trx) => {
    await activity.onAccountStatusChanged(pgActivityStore(trx), p);
  });
  project(IdentityEvents.AccountCreated, (s, p, e) => projector.onAccountCreated(s, p, e));
  project(IdentityEvents.UserLoggedIn, (s, p, e) => projector.onUserLoggedIn(s, p, e));
  project(VerificationEvents.VerificationStatusChanged, (s, p, e) =>
    projector.onVerificationStatusChanged(s, p, e),
  );
  project(DemandEvents.NeedStatusChanged, (s, p, e) => projector.onNeedStatusChanged(s, p, e));
  project(CatalogEvents.ListingPublished, (s, p, e) => projector.onListingPublished(s, p, e));
  project(CatalogEvents.ListingUnavailable, (s, p, e) => projector.onListingUnavailable(s, p, e));
  project(OfferEvents.OfferSubmitted, (s, p, e) => projector.onOfferSubmitted(s, p, e));
  project(OfferEvents.OfferCountered, (s, p, e) => projector.onOfferCountered(s, p, e));
  project(OfferEvents.OfferAccepted, (s, p, e) => projector.onOfferAccepted(s, p, e));
  project(OfferEvents.OfferStatusChanged, (s, p, e) => projector.onOfferStatusChanged(s, p, e));
  project(TransactionEvents.TransactionCreated, (s, p, e) =>
    projector.onTransactionCreated(s, p, e),
  );
  project(TransactionEvents.TransactionStateChanged, (s, p, e) =>
    projector.onTransactionStateChanged(s, p, e),
  );
  project(DisputeEvents.DisputeOpened, (s, p, e) => projector.onDisputeOpened(s, p, e));
  project(DisputeEvents.DisputeStatusChanged, (s, p, e) =>
    projector.onDisputeStatusChanged(s, p, e),
  );
  project(DisputeEvents.DisputeResolved, (s, p, e) => projector.onDisputeResolved(s, p, e));
  project(DisputeEvents.DisputeWithdrawn, (s, p, e) => projector.onDisputeWithdrawn(s, p, e));
  project(ReputationEvents.ReviewCreated, (s, p, e) => projector.onReviewCreated(s, p, e));
  project(ReputationEvents.ReputationUpdated, (s, p, e) => projector.onReputationUpdated(s, p, e));
  project(BiddingEvents.AuctionOpened, (s, p, e) => projector.onAuctionOpened(s, p, e));
  project(BiddingEvents.BidPlaced, (s, p, e) => projector.onBidPlaced(s, p, e));
  project(BiddingEvents.AuctionClosed, (s, p, e) => projector.onAuctionClosed(s, p, e));
  project(BiddingEvents.AuctionAwarded, (s, p, e) => projector.onAuctionAwarded(s, p, e));
  project(RentalEvents.BookingConfirmed, (s, p, e) => projector.onBookingConfirmed(s, p, e));
  project(RentalEvents.BookingStatusChanged, (s, p, e) =>
    projector.onBookingStatusChanged(s, p, e),
  );
  project(LendingEvents.LoanRequested, (s, p, e) => projector.onLoanRequested(s, p, e));
  project(LendingEvents.LoanApproved, (s, p, e) => projector.onLoanApproved(s, p, e));
  project(LendingEvents.LoanStatusChanged, (s, p, e) => projector.onLoanStatusChanged(s, p, e));
  project(MessagingEvents.MessageSent, (s, p, e) => projector.onMessageSent(s, p, e));

  // ---- retention ----
  runtime.every('dashboard.activity-retention', 60 * 60_000, (trx) =>
    activity.purgeExpired(pgActivityStore(trx)),
  );

  await runtime.app.register(dashboardRoutes, {
    activity,
    metrics,
    personal,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return { runtime, config, activity, metrics };
}
