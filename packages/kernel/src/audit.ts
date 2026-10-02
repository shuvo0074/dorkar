import { ActivityEvents } from '@dorkar/contracts';
import type { Kysely, Transaction } from 'kysely';
import type { RequestContext } from './context';
import { uuidv7 } from './crypto';
import type { KernelTables } from './db/database';

export interface AuditEntry {
  action: string;
  actorId?: string | null;
  actorType?: 'USER' | 'ADMIN' | 'SYSTEM' | 'ANONYMOUS';
  targetType?: string;
  targetId?: string;
  /** Never put secrets, OTPs, raw phone numbers or NID data here. */
  metadata?: Record<string, unknown>;
}

type Executor = Kysely<KernelTables> | Transaction<KernelTables>;

/**
 * Append an audit record. Call it with the same transaction as the audited change so the
 * record exists if and only if the change does.
 *
 * The record is also queued in the outbox as `audit.ActivityRecorded` (same transaction), which
 * feeds the cross-service activity log. Its aggregate id is the audit id, never the target's,
 * so per-aggregate event streams are unaffected.
 */
export async function appendAudit(
  trx: Executor,
  ctx: Pick<RequestContext, 'requestId' | 'ipHash' | 'actor'>,
  entry: AuditEntry,
): Promise<void> {
  const actorId = entry.actorId !== undefined ? entry.actorId : (ctx.actor?.id ?? null);
  const id = uuidv7();
  const occurredAt = new Date().toISOString();
  const row = {
    actorId,
    actorType: entry.actorType ?? (actorId ? 'USER' : 'ANONYMOUS'),
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    metadata: entry.metadata ?? {},
  } as const;
  await trx
    .insertInto('audit_log')
    .values({
      id,
      occurred_at: new Date(occurredAt),
      actor_id: row.actorId,
      actor_type: row.actorType,
      action: entry.action,
      target_type: row.targetType,
      target_id: row.targetId,
      request_id: ctx.requestId,
      ip_hash: ctx.ipHash,
      metadata: JSON.stringify(row.metadata),
    })
    .execute();
  const def = ActivityEvents.ActivityRecorded;
  const payload = def.schema.parse({
    auditId: id,
    occurredAt,
    actorId: row.actorId,
    actorType: row.actorType,
    action: entry.action,
    targetType: row.targetType,
    targetId: row.targetId,
    requestId: ctx.requestId,
    ipHash: ctx.ipHash,
    metadata: row.metadata,
  });
  await trx
    .insertInto('outbox')
    .values({
      id: uuidv7(),
      type: def.type,
      version: def.version,
      aggregate_id: id,
      payload: JSON.stringify(payload),
      correlation_id: null,
      causation_id: ctx.requestId,
      occurred_at: occurredAt,
      published_at: null,
    })
    .execute();
}
