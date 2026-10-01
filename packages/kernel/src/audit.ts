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
 */
export async function appendAudit(
  trx: Executor,
  ctx: Pick<RequestContext, 'requestId' | 'ipHash' | 'actor'>,
  entry: AuditEntry,
): Promise<void> {
  const actorId = entry.actorId !== undefined ? entry.actorId : (ctx.actor?.id ?? null);
  await trx
    .insertInto('audit_log')
    .values({
      id: uuidv7(),
      actor_id: actorId,
      actor_type: entry.actorType ?? (actorId ? 'USER' : 'ANONYMOUS'),
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      request_id: ctx.requestId,
      ip_hash: ctx.ipHash,
      metadata: JSON.stringify(entry.metadata ?? {}),
    })
    .execute();
}
