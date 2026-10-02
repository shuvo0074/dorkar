import type { EventEnvelope } from '@dorkar/contracts';
import type { Kysely, Transaction } from 'kysely';
import type { KernelTables } from './database';

/**
 * Exactly-once *effects* on top of at-least-once delivery: records `(consumer, event.id)` in the
 * service's `inbox` table in the same transaction as the handler's writes. A redelivered event
 * finds its row and is skipped; a failed handler rolls back both, so it is retried cleanly.
 *
 * Returns true when the handler ran, false when the event had already been processed.
 */
export async function handleOnce<DB extends KernelTables>(
  db: Kysely<DB>,
  consumer: string,
  event: Pick<EventEnvelope, 'id'>,
  fn: (trx: Transaction<DB>) => Promise<void>,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const k = trx as unknown as Transaction<KernelTables>;
    const inserted = await k
      .insertInto('inbox')
      .values({ consumer, event_id: event.id })
      .onConflict((oc) => oc.columns(['consumer', 'event_id']).doNothing())
      .returning('event_id')
      .executeTakeFirst();
    if (!inserted) return false;
    await fn(trx);
    return true;
  });
}
