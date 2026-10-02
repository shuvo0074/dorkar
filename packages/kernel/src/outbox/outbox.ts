import type { EventEnvelope } from '@dorkar/contracts';
import type { Kysely, Transaction } from 'kysely';
import type { z } from 'zod';
import type { RequestContext } from '../context';
import { uuidv7 } from '../crypto';
import type { KernelTables } from '../db/database';
import { currentTraceparent, parseTraceparent } from '../trace';

export interface EventDefinition<S extends z.ZodType> {
  type: string;
  version: number;
  schema: S;
}

/**
 * Builds validated envelopes for one producer. Payloads are validated at the source so
 * a malformed event can never be committed. The envelope carries the caller's `traceparent`
 * (from `ctx`, else the current execution scope) so consumers continue the same trace.
 */
export function createEventFactory(producer: string) {
  return function event<S extends z.ZodType>(
    def: EventDefinition<S>,
    aggregateId: string,
    payload: z.input<S>,
    ctx?: Pick<RequestContext, 'correlationId' | 'requestId' | 'traceparent'>,
  ): EventEnvelope<z.output<S>> {
    const traceparent = ctx?.traceparent ?? currentTraceparent();
    return {
      id: uuidv7(),
      type: def.type,
      version: def.version,
      occurredAt: new Date().toISOString(),
      producer,
      aggregateId,
      ...(ctx ? { correlationId: ctx.correlationId, causationId: ctx.requestId } : {}),
      ...(traceparent && parseTraceparent(traceparent) ? { traceparent } : {}),
      payload: def.schema.parse(payload),
    };
  };
}

type Executor = Kysely<KernelTables> | Transaction<KernelTables>;

/** Must be called with the same transaction as the state change it describes. */
export async function appendToOutbox(
  trx: Executor,
  events: EventEnvelope<unknown> | readonly EventEnvelope<unknown>[],
): Promise<void> {
  const list = Array.isArray(events) ? events : [events];
  if (list.length === 0) return;
  await trx
    .insertInto('outbox')
    .values(
      list.map((e: EventEnvelope<unknown>) => ({
        id: e.id,
        type: e.type,
        version: e.version,
        aggregate_id: e.aggregateId,
        payload: JSON.stringify(e.payload),
        correlation_id: e.correlationId ?? null,
        causation_id: e.causationId ?? null,
        traceparent: e.traceparent ?? null,
        occurred_at: e.occurredAt,
        published_at: null,
      })),
    )
    .execute();
}
