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
import type { ContactDirectory, PushProvider, PushThrottle, SmsChannel } from './application/ports';
import { PushDeviceService } from './application/push-devices';
import { PushDispatcher } from './application/push-dispatcher';
import { SmsDispatcher } from './application/sms-dispatcher';
import { notificationRules } from './domain/rules';
import type { NotificationDB } from './infrastructure/db-schema';
import { IdentityContactDirectory } from './infrastructure/identity-contact-directory';
import {
  pgDeliveryStore,
  pgNotificationStore,
  pgNotificationUnitOfWork,
} from './infrastructure/pg-notification-store';
import { pgPushDeviceStore, pgPushDeviceUnitOfWork } from './infrastructure/pg-push-device-store';
import { FcmPushProvider, parseServiceAccount } from './infrastructure/push/fcm-push-provider';
import { FilePushProvider, RedisPushThrottle } from './infrastructure/push/push-providers';
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
    /** `none` disables push entirely (no deliveries queued, no sender job). */
    PUSH_PROVIDER: z.enum(['none', 'file', 'fcm']).default('file'),
    PUSH_FILE_PATH: z.string().default('var/notification-push.log'),
    /** Base64 of the Firebase service-account JSON (required for `fcm`). A secret. */
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
    PUSH_MAX_ATTEMPTS: int(5).pipe(z.number().max(20)),
    PUSH_BATCH_SIZE: int(50).pipe(z.number().max(500)),
    PUSH_DISPATCH_INTERVAL_MS: int(2_000, 500),
    PUSH_LEASE_MS: int(120_000, 10_000),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.SMS_PROVIDER === 'file') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'the file SMS provider is for development/staging only; configure a real provider',
      });
    }
    if (c.NODE_ENV === 'production' && c.PUSH_PROVIDER === 'file') {
      ctx.addIssue({
        code: 'custom',
        path: ['PUSH_PROVIDER'],
        message: 'the file push provider is for development/staging only; use fcm (or none)',
      });
    }
    if (c.PUSH_PROVIDER === 'fcm') {
      try {
        parseServiceAccount(c.FCM_SERVICE_ACCOUNT_JSON ?? '');
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['FCM_SERVICE_ACCOUNT_JSON'],
          message: 'fcm needs FCM_SERVICE_ACCOUNT_JSON: base64 of a service-account JSON',
        });
      }
    }
  });
export type NotificationConfig = z.infer<typeof notificationEnvSchema>;

function pushProviderFor(config: NotificationConfig): PushProvider | null {
  switch (config.PUSH_PROVIDER) {
    case 'none':
      return null;
    case 'file':
      return new FilePushProvider(config.PUSH_FILE_PATH);
    case 'fcm':
      return new FcmPushProvider({
        serviceAccount: parseServiceAccount(config.FCM_SERVICE_ACCOUNT_JSON ?? ''),
        publicBaseUrl: config.PUBLIC_BASE_URL,
      });
  }
}

/** Composition root. Tests replace the contact lookup, the SMS channel and the push provider. */
export async function buildNotificationService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: {
    verifier?: AccessTokenVerifier;
    contacts?: ContactDirectory;
    sms?: SmsChannel;
    push?: PushProvider;
    pushThrottle?: PushThrottle;
  } = {},
): Promise<{
  runtime: ServiceRuntime<NotificationDB>;
  notifications: NotificationService;
  dispatcher: SmsDispatcher;
  pushDispatcher: PushDispatcher | null;
  pushDevices: PushDeviceService;
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

  const push = overrides.push ?? pushProviderFor(config);
  const notifications = new NotificationService(pgNotificationUnitOfWork(runtime.db), {
    pushEnabled: push !== null,
  });
  const pushDevices = new PushDeviceService(pgPushDeviceUnitOfWork(runtime.db), logger);
  const pushDispatcher = push
    ? new PushDispatcher({
        deliveries: pgDeliveryStore(runtime.db),
        notifications: pgNotificationStore(runtime.db),
        devices: pgPushDeviceStore(runtime.db),
        push,
        throttle: overrides.pushThrottle ?? new RedisPushThrottle(runtime.redis),
        logger,
        settings: {
          batchSize: config.PUSH_BATCH_SIZE,
          maxAttempts: config.PUSH_MAX_ATTEMPTS,
          leaseMs: config.PUSH_LEASE_MS,
        },
      })
    : null;
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
  if (pushDispatcher) {
    runtime.every('notification.push-dispatch', config.PUSH_DISPATCH_INTERVAL_MS, () =>
      pushDispatcher.runOnce(),
    );
  }
  runtime.every('notification.retention', 60 * 60_000, (trx) =>
    notifications.purge(pgNotificationStore(trx), config.NOTIFICATION_RETENTION_DAYS),
  );

  await runtime.app.register(notificationRoutes, {
    notifications,
    pushDevices,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  return { runtime, notifications, dispatcher, pushDispatcher, pushDevices, config };
}
