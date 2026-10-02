import { randomUUID } from 'node:crypto';
import { ActivityEvents, type ActorType, type EventEnvelope } from '@dorkar/contracts';
import { envelope, startTestService, type TestService } from '@dorkar/kernel/testing';
import type { EventDefinition } from '@dorkar/kernel';
import type { z } from 'zod';
import { migrations } from '../migrations';
import { buildDashboardService } from '../src/app';

type UUID = ReturnType<typeof randomUUID>;

export type Svc = Awaited<ReturnType<typeof buildDashboardService>>;
export type T = TestService<Svc>;

export const start = (now?: () => Date, env: Record<string, string> = {}) =>
  startTestService({
    schemaPrefix: 'dashboard',
    migrations,
    env,
    build: (e, logger, verifier) =>
      buildDashboardService(e, logger, { verifier, ...(now ? { now } : {}) }),
  });

/** A domain event from its usual producer, optionally at a given time. */
export function ev<S extends z.ZodType>(
  def: EventDefinition<S>,
  payload: z.input<S>,
  at?: Date | string,
  aggregateId?: string,
): EventEnvelope {
  const e =
    aggregateId === undefined
      ? envelope(def, payload)
      : envelope(def, payload, aggregateId as UUID);
  return { ...e, ...(at ? { occurredAt: new Date(at).toISOString() } : {}) } as EventEnvelope;
}

export interface ActivityInput {
  auditId?: string;
  producer?: string;
  occurredAt?: Date | string;
  actorId?: string | null;
  actorType?: ActorType;
  action?: string;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  ipHash?: string | null;
  metadata?: Record<string, unknown>;
}

/** An `audit.ActivityRecorded` envelope as `producer` would publish it. */
export function activity(a: ActivityInput = {}): EventEnvelope {
  const auditId = a.auditId ?? randomUUID();
  const actorId = a.actorId === undefined ? randomUUID() : a.actorId;
  const e = envelope(
    ActivityEvents.ActivityRecorded,
    {
      auditId,
      occurredAt: new Date(a.occurredAt ?? new Date()).toISOString(),
      actorId,
      actorType: a.actorType ?? (actorId ? 'USER' : 'ANONYMOUS'),
      action: a.action ?? 'offer.submit',
      targetType: a.targetType === undefined ? 'OFFER' : a.targetType,
      targetId: a.targetId === undefined ? randomUUID() : a.targetId,
      requestId: a.requestId === undefined ? `req-${randomUUID()}` : a.requestId,
      ipHash: a.ipHash === undefined ? 'iphash-abc' : a.ipHash,
      metadata: a.metadata ?? {},
    },
    auditId as UUID,
  );
  return { ...e, producer: a.producer ?? 'offer' };
}

export const money = (amount: number) => ({ amount, currency: 'BDT' as const });

/** Lowercase letters only (service names must match ^[a-z]+$). */
export const letters = (n = 10) =>
  Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
    '',
  );
