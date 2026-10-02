import { CatalogEvents, TransactionEvents } from '@dorkar/contracts';
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
import { BookingService } from './application/booking-service';
import { CalendarService } from './application/calendar-service';
import type { VerificationGateway } from './application/ports';
import type { RentalDB } from './infrastructure/db-schema';
import { httpVerificationGateway } from './infrastructure/http-gateways';
import { pgRentalStore, pgRentalUnitOfWork } from './infrastructure/pg-rental-store';
import { rentalRoutes } from './interfaces/http/routes';

export const rentalEnvSchema = serviceEnvSchema.extend({
  SERVICE_NAME: z.string().default('rental-service'),
  PORT: z.coerce.number().int().default(4014),
  DATABASE_SCHEMA: z.string().default('rental'),
  VERIFICATION_URL: z.url().default('http://localhost:4003'),
  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(1).default(15),
  BOOKING_APPROVAL_HOURS: z.coerce.number().int().min(1).default(24),
  BOOKING_OVERDUE_GRACE_HOURS: z.coerce.number().int().min(0).default(2),
  BOOKING_MAX_ADVANCE_DAYS: z.coerce.number().int().min(1).default(180),
});

type Job = (trx: Transaction<RentalDB>) => Promise<number>;

type ListingFacts = z.output<typeof CatalogEvents.ListingPublished.schema>;

/** Composition root. Tests may replace the outbound verification port. */
export async function buildRentalService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; verification?: VerificationGateway } = {},
): Promise<{
  runtime: ServiceRuntime<RentalDB>;
  bookings: BookingService;
  calendar: CalendarService;
  jobs: { expireBookings: Job; notifyOverdue: Job };
}> {
  const config = loadConfig(rentalEnvSchema, env);
  const runtime = await createServiceRuntime<RentalDB>({
    config,
    logger,
    producer: 'rental',
    openapi: {
      title: 'Dorkar Rental API',
      description: 'Rental terms, availability calendars, holds and booking approval.',
    },
    idempotency: true,
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const verification =
    overrides.verification ??
    httpVerificationGateway(
      createInternalClient({ baseUrl: config.VERIFICATION_URL, token: config.INTERNAL_API_TOKEN }),
    );

  const uow = pgRentalUnitOfWork(runtime.db);
  const calendar = new CalendarService(uow);
  const bookings = new BookingService(uow, runtime.event, verification, {
    holdMinutes: config.BOOKING_HOLD_MINUTES,
    approvalHours: config.BOOKING_APPROVAL_HOURS,
    overdueGraceHours: config.BOOKING_OVERDUE_GRACE_HOURS,
    maxAdvanceDays: config.BOOKING_MAX_ADVANCE_DAYS,
  });

  // Projection of RENTAL listings (each event applied exactly once, in the inbox transaction).
  const onListing = async (p: ListingFacts, trx: Transaction<RentalDB>, publish: boolean) => {
    const s = pgRentalStore(trx);
    if (p.kind !== 'RENTAL') {
      // No longer a rental (or never was): make sure it cannot be booked.
      await s.markListingUnavailable(p.listingId);
      return;
    }
    await s.upsertListing(
      {
        listingId: p.listingId,
        sellerId: p.sellerId,
        categoryId: p.categoryId,
        title: p.title,
        district: p.district,
        price: p.price.amount,
        currency: p.price.currency,
        priceUnit: p.priceUnit,
      },
      publish,
    );
  };
  runtime.on(CatalogEvents.ListingPublished, (p, _e, trx) => onListing(p, trx, true));
  runtime.on(CatalogEvents.ListingUpdated, (p, _e, trx) => onListing(p, trx, false));
  runtime.on(CatalogEvents.ListingUnavailable, (p, _e, trx) =>
    pgRentalStore(trx).markListingUnavailable(p.listingId),
  );

  // Once confirmed, the transaction owns the deal; rental mirrors it.
  runtime.on(TransactionEvents.TransactionCreated, (p, _e, trx) =>
    bookings.onTransactionCreated(pgRentalStore(trx), p),
  );
  runtime.on(TransactionEvents.TransactionStateChanged, (p, e, trx) =>
    bookings.onTransactionStateChanged(pgRentalStore(trx), p, e),
  );

  const jobs = {
    expireBookings: (trx: Transaction<RentalDB>) => bookings.expireDue(pgRentalStore(trx)),
    notifyOverdue: (trx: Transaction<RentalDB>) => bookings.notifyOverdue(pgRentalStore(trx)),
  };
  runtime.every('rental.expire-bookings', 30_000, jobs.expireBookings);
  runtime.every('rental.notify-overdue', 5 * 60_000, jobs.notifyOverdue);

  await runtime.app.register(rentalRoutes, {
    bookings,
    calendar,
    runtime: runtime as unknown as ServiceRuntime<never>,
    idempotencyDb: runtime.db as unknown as Kysely<IdempotencyTables>,
  });
  return { runtime, bookings, calendar, jobs };
}
