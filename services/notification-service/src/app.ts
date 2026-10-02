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
import { NotificationService } from './application/notification-service';
import type { ContactDirectory, SmsChannel } from './application/ports';
import { SmsDispatcher } from './application/sms-dispatcher';
import { notificationRules } from './domain/rules';
import type { NotificationDB } from './infrastructure/db-schema';
import { IdentityContactDirectory } from './infrastructure/identity-contact-directory';
import {
  pgDeliveryStore,
  pgNotificationStore,
  pgNotificationUnitOfWork,
} from './infrastructure/pg-notification-store';
import { FileSmsChannel } from './infrastructure/sms/sms-channels';
import { notificationRoutes } from './interfaces/http/routes';

const int = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);

export const notificationEnvSchema = serviceEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('notification-service'),
    PORT: z.coerce.number().int().default(4012),
    DATABASE_SCHEMA: z.string().default('notification'),
    IDENTITY_URL: z.url().default('http://localhost:4001'),
    /** Base for the short link in SMS texts (`dorkar.com.bd/n/<id>`). */
    PUBLIC_BASE_URL: z.url().default('https://dorkar.com.bd'),
    SMS_PROVIDER: z.enum(['file']).default('file'),
    SMS_FILE_PATH: z.string().default('var/notification-sms.log'),
    SMS_MAX_ATTEMPTS: int(5).pipe(z.number().max(20)),
    SMS_BATCH_SIZE: int(20).pipe(z.number().max(200)),
    SMS_DISPATCH_INTERVAL_MS: int(3_000, 500),
    SMS_LEASE_MS: int(120_000, 10_000),
    NOTIFICATION_RETENTION_DAYS: int(90),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.SMS_PROVIDER === 'file') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'the file SMS provider is for development/staging only; configure a real provider',
      });
    }
  });
export type NotificationConfig = z.infer<typeof notificationEnvSchema>;

/** Composition root. Tests replace the contact lookup and the SMS channel. */
export async function buildNotificationService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; contacts?: ContactDirectory; sms?: SmsChannel } = {},
): Promise<{
  runtime: ServiceRuntime<NotificationDB>;
  notifications: NotificationService;
  dispatcher: SmsDispatcher;
  config: NotificationConfig;
}> {
  const config = loadConfig(notificationEnvSchema, env);
  const runtime = await createServiceRuntime<NotificationDB>({
    config,
    logger,
    producer: 'notification',
    openapi: {
      title: 'Dorkar Notification API',
      description: 'In-app notifications, delivery channels and preferences.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const notifications = new NotificationService(pgNotificationUnitOfWork(runtime.db));
  const dispatcher = new SmsDispatcher({
    deliveries: pgDeliveryStore(runtime.db),
    notifications: pgNotificationStore(runtime.db),
    contacts:
      overrides.contacts ??
      new IdentityContactDirectory(
        createInternalClient({ baseUrl: config.IDENTITY_URL, token: config.INTERNAL_API_TOKEN }),
      ),
    sms: overrides.sms ?? new FileSmsChannel(config.SMS_FILE_PATH),
    logger,
    settings: {
      batchSize: config.SMS_BATCH_SIZE,
      maxAttempts: config.SMS_MAX_ATTEMPTS,
      leaseMs: config.SMS_LEASE_MS,
      publicBaseUrl: config.PUBLIC_BASE_URL,
    },
  });

  // Every consumed event → notifications + queued deliveries, inside its inbox transaction.
  for (const rule of notificationRules) {
    runtime.on(rule.def, async (payload, event, trx) => {
      await notifications.onEvent(pgNotificationStore(trx), event, rule.map(payload));
    });
  }

  // Sending happens outside the job's lock transaction: the dispatcher uses its own short
  // transactions so network calls never hold row locks.
  runtime.every('notification.sms-dispatch', config.SMS_DISPATCH_INTERVAL_MS, () =>
    dispatcher.runOnce(),
  );
  runtime.every('notification.retention', 60 * 60_000, (trx) =>
    notifications.purge(pgNotificationStore(trx), config.NOTIFICATION_RETENTION_DAYS),
  );

  await runtime.app.register(notificationRoutes, {
    notifications,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return { runtime, notifications, dispatcher, config };
}
