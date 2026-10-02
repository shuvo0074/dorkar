import { MoneySchema } from '@dorkar/contracts';
import { ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { NotificationService } from '../../application/notification-service';
import {
  NotificationTypes,
  type EffectivePreference,
  type Notification,
} from '../../domain/notification';

const iso = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});
const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
};

const NotificationDto = z.object({
  id: z.uuid(),
  type: z.enum(NotificationTypes),
  /** IDs and non-sensitive facts; clients render the text in the user's language. */
  payload: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null(), MoneySchema]),
  ),
  read: z.boolean(),
  readAt: iso.nullable(),
  createdAt: iso,
});

const toDto = (n: Notification): z.output<typeof NotificationDto> => ({
  id: n.id,
  type: n.type,
  payload: n.payload,
  read: n.readAt !== null,
  readAt: n.readAt,
  createdAt: n.createdAt,
});

const Preference = z.object({
  type: z.enum(NotificationTypes),
  inApp: z.boolean(),
  sms: z.boolean(),
});
const toPreference = (p: EffectivePreference): z.output<typeof Preference> => ({
  type: p.type,
  inApp: p.inApp,
  sms: p.sms,
});

const ListQuery = z.strictObject({
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const PreferencesBody = z.strictObject({
  items: z
    .array(
      z.strictObject({ type: z.enum(NotificationTypes), inApp: z.boolean(), sms: z.boolean() }),
    )
    .min(1)
    .max(NotificationTypes.length),
});

export interface NotificationRouteDeps {
  notifications: NotificationService;
  runtime: ServiceRuntime<never>;
}

export const notificationRoutes: FastifyPluginAsyncZod<NotificationRouteDeps> = async (
  app,
  { notifications, runtime },
) => {
  const { authenticate } = runtime.auth;
  const secured = { tags: ['notifications'], security: [{ bearerAuth: [] }] };

  app.get(
    '/api/v1/me/notifications',
    {
      preHandler: authenticate,
      schema: {
        ...secured,
        summary: 'My notifications, newest first',
        querystring: ListQuery,
        response: {
          200: z.object({
            data: z.array(NotificationDto),
            page: z.object({ nextCursor: z.string().nullable() }),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const page = await notifications.listMine(req.query, req.ctx);
      return { data: page.items.map(toDto), page: { nextCursor: page.nextCursor } };
    },
  );

  app.get(
    '/api/v1/me/notifications/unread-count',
    {
      preHandler: authenticate,
      schema: {
        ...secured,
        response: { 200: z.object({ data: z.object({ count: z.number().int() }) }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.header('cache-control', 'private, no-store');
      return ok({ count: await notifications.unreadCount(req.ctx) });
    },
  );

  app.post(
    '/api/v1/me/notifications/read-all',
    {
      preHandler: authenticate,
      schema: {
        ...secured,
        response: { 200: z.object({ data: z.object({ updated: z.number().int() }) }), ...errors },
      },
    },
    async (req) => ok({ updated: await notifications.markAllRead(req.ctx) }),
  );

  app.post(
    '/api/v1/me/notifications/:id/read',
    {
      preHandler: authenticate,
      schema: {
        ...secured,
        params: z.strictObject({ id: z.uuid() }),
        response: { 200: z.object({ data: NotificationDto }), ...errors },
      },
    },
    async (req) => ok(toDto(await notifications.markRead(req.params.id, req.ctx))),
  );

  app.get(
    '/api/v1/me/notifications/preferences',
    {
      preHandler: authenticate,
      schema: {
        ...secured,
        summary: 'Effective channel preferences for every notification type',
        response: { 200: z.object({ data: z.array(Preference) }), ...errors },
      },
    },
    async (req) => ok((await notifications.preferences(req.ctx)).map(toPreference)),
  );

  app.put(
    '/api/v1/me/notifications/preferences',
    {
      preHandler: authenticate,
      schema: {
        ...secured,
        body: PreferencesBody,
        response: { 200: z.object({ data: z.array(Preference) }), ...errors },
      },
    },
    async (req) =>
      ok((await notifications.setPreferences(req.body.items, req.ctx)).map(toPreference)),
  );
};
