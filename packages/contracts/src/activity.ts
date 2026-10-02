import { z } from 'zod';

/**
 * Every audit record (kernel `appendAudit`) is also published, through the same outbox and in
 * the same transaction, as an `audit.ActivityRecorded` event on its producer's stream. The
 * dashboard service projects these into the cross-service activity log.
 *
 * Unlike other events the type prefix is not the producer: every service emits this type, so
 * consumers subscribe to it on each producer's stream (`runtime.on(def, handler, { producers })`).
 * The metadata follows audit rules: never secrets, OTPs, phone numbers or NID data.
 */
export const ActorTypes = ['USER', 'ADMIN', 'SYSTEM', 'ANONYMOUS'] as const;
export type ActorType = (typeof ActorTypes)[number];

export const ActivityEvents = {
  ActivityRecorded: {
    type: 'audit.ActivityRecorded',
    version: 1,
    schema: z.object({
      auditId: z.uuid(),
      occurredAt: z.iso.datetime(),
      actorId: z.uuid().nullable(),
      actorType: z.enum(ActorTypes),
      action: z.string().min(1).max(100),
      targetType: z.string().max(50).nullable(),
      targetId: z.string().max(100).nullable(),
      requestId: z.string().nullable(),
      ipHash: z.string().nullable(),
      metadata: z.record(z.string(), z.unknown()),
    }),
  },
} as const;
