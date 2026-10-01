import { z } from 'zod';

/** Envelope shared by every integration event. `id` doubles as the consumer idempotency key. */
export const EventEnvelopeSchema = z.object({
  id: z.uuid(),
  type: z.string().regex(/^[a-z]+\.[A-Za-z]+$/),
  version: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  producer: z.string(),
  aggregateId: z.string(),
  correlationId: z.string().optional(),
  causationId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope<P = Record<string, unknown>> = Omit<
  z.infer<typeof EventEnvelopeSchema>,
  'payload'
> & { payload: P };

/** Stream that a producer's relay publishes to. */
export const eventStreamFor = (producer: string) => `events:${producer}`;

// ---- identity events (no phone numbers or other PII in payloads) ----

export const AccountStatuses = ['ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED'] as const;
export type AccountStatus = (typeof AccountStatuses)[number];

export const IdentityEvents = {
  AccountCreated: {
    type: 'identity.AccountCreated',
    version: 1,
    schema: z.object({ accountId: z.uuid() }),
  },
  UserLoggedIn: {
    type: 'identity.UserLoggedIn',
    version: 1,
    schema: z.object({
      accountId: z.uuid(),
      sessionId: z.uuid(),
      deviceId: z.uuid(),
      newDevice: z.boolean(),
    }),
  },
  DeviceRevoked: {
    type: 'identity.DeviceRevoked',
    version: 1,
    schema: z.object({ accountId: z.uuid(), deviceId: z.uuid() }),
  },
  AccountStatusChanged: {
    type: 'identity.AccountStatusChanged',
    version: 1,
    schema: z.object({
      accountId: z.uuid(),
      from: z.enum(AccountStatuses),
      to: z.enum(AccountStatuses),
      reason: z.string(),
    }),
  },
} as const;
