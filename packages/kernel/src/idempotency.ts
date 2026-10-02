import { sql, type Kysely } from 'kysely';
import { sha256 } from './crypto';
import type { Migration } from './db/migrator';
import { AppError, Errors } from './errors';
import { boundedLabel } from './metrics';
import { currentScope } from './trace';

/**
 * `Idempotency-Key` support for critical POSTs (accept offer, place bid, create transaction…).
 *
 * The first request with a key executes and its response is stored for 24h; a retry with the
 * same key and body gets the stored response; the same key with a different body is a 409; a
 * duplicate arriving while the first is still running is a 409 too. A key left IN_PROGRESS by a
 * crashed request is taken over after `staleAfterMs`.
 */

export const kernelIdempotencyMigration: Migration = {
  name: '0000_kernel_idempotency',
  async up(trx) {
    await sql`
      create table idempotency_keys (
        actor_id text not null,
        scope text not null,
        key text not null,
        request_hash bytea not null,
        status text not null check (status in ('IN_PROGRESS','COMPLETED')),
        response_status int,
        response_body jsonb,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null default now() + interval '24 hours',
        primary key (actor_id, scope, key)
      )`.execute(trx);
    await sql`create index idempotency_keys_expires_idx on idempotency_keys (expires_at)`.execute(
      trx,
    );
  },
  async down(trx) {
    await sql`drop table idempotency_keys`.execute(trx);
  },
};

export interface IdempotencyTables {
  idempotency_keys: {
    actor_id: string;
    scope: string;
    key: string;
    request_hash: Buffer;
    status: 'IN_PROGRESS' | 'COMPLETED';
    response_status: number | null;
    response_body: unknown;
    created_at: Date | string | undefined;
    expires_at: Date | string | undefined;
  };
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

interface StoredError {
  __error: { code: AppError['code']; message: string; details?: Record<string, unknown> };
}
const isStoredError = (v: unknown): v is StoredError =>
  typeof v === 'object' && v !== null && '__error' in v;

/** Hash of everything that identifies the request's intent (route params + body). */
export const requestFingerprint = (parts: unknown): Buffer => sha256(JSON.stringify(parts ?? null));

export async function withIdempotency<T>(
  db: Kysely<IdempotencyTables>,
  opts: {
    actorId: string;
    scope: string;
    key: string | undefined;
    fingerprint: Buffer;
    /** When false, a missing key is allowed and the operation just runs. */
    required?: boolean;
    staleAfterMs?: number;
  },
  run: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!opts.key) {
    if (opts.required)
      throw Errors.validation('Idempotency-Key header is required for this request.');
    return { ...(await run()), replayed: false };
  }
  if (!KEY_PATTERN.test(opts.key))
    throw Errors.validation('Idempotency-Key must be 8–128 URL-safe characters.');

  const pk = { actor_id: opts.actorId, scope: opts.scope, key: opts.key };
  const claimed = await db
    .insertInto('idempotency_keys')
    .values({
      ...pk,
      request_hash: opts.fingerprint,
      status: 'IN_PROGRESS',
      response_status: null,
      response_body: null,
      created_at: undefined,
      expires_at: undefined,
    })
    .onConflict((oc) => oc.columns(['actor_id', 'scope', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();

  if (!claimed) {
    const existing = await db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('actor_id', '=', pk.actor_id)
      .where('scope', '=', pk.scope)
      .where('key', '=', pk.key)
      .executeTakeFirst();
    if (existing) {
      if (!existing.request_hash.equals(opts.fingerprint)) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request.',
        );
      }
      if (existing.status === 'COMPLETED') {
        const stored = existing.response_body as StoredError | T;
        currentScope()?.metrics?.idempotencyReplays.inc({ scope: boundedLabel(opts.scope) });
        if (isStoredError(stored)) {
          throw new AppError(stored.__error.code, stored.__error.message, stored.__error.details);
        }
        return { status: existing.response_status ?? 200, body: stored, replayed: true };
      }
      const age = Date.now() - new Date(existing.created_at as Date).getTime();
      if (age < (opts.staleAfterMs ?? 60_000)) {
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'The original request is still being processed. Retry shortly.',
        );
      }
      // Abandoned by a crashed request: take it over (guarded so only one taker wins).
      const taken = await db
        .updateTable('idempotency_keys')
        .set({ created_at: new Date() })
        .where('actor_id', '=', pk.actor_id)
        .where('scope', '=', pk.scope)
        .where('key', '=', pk.key)
        .where('status', '=', 'IN_PROGRESS')
        .where('created_at', '=', existing.created_at as Date)
        .executeTakeFirst();
      if (taken.numUpdatedRows !== 1n) {
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'The original request is still being processed. Retry shortly.',
        );
      }
    }
  }

  try {
    const result = await run();
    await db
      .updateTable('idempotency_keys')
      .set({
        status: 'COMPLETED',
        response_status: result.status,
        response_body: JSON.stringify(result.body),
      })
      .where('actor_id', '=', pk.actor_id)
      .where('scope', '=', pk.scope)
      .where('key', '=', pk.key)
      .execute();
    return { ...result, replayed: false };
  } catch (err) {
    // Business errors are deterministic for this body: store them so retries get the same answer.
    if (err instanceof AppError && err.status < 500) {
      await db
        .updateTable('idempotency_keys')
        .set({
          status: 'COMPLETED',
          response_status: err.status,
          response_body: JSON.stringify({
            __error: { code: err.code, message: err.message, details: err.details },
          }),
        })
        .where('actor_id', '=', pk.actor_id)
        .where('scope', '=', pk.scope)
        .where('key', '=', pk.key)
        .execute();
    } else {
      await db
        .deleteFrom('idempotency_keys')
        .where('actor_id', '=', pk.actor_id)
        .where('scope', '=', pk.scope)
        .where('key', '=', pk.key)
        .execute();
    }
    throw err;
  }
}

export async function purgeExpiredIdempotencyKeys(db: Kysely<IdempotencyTables>): Promise<number> {
  const r = await db
    .deleteFrom('idempotency_keys')
    .where('expires_at', '<', sql<Date>`now()`)
    .executeTakeFirst();
  return Number(r.numDeletedRows);
}
