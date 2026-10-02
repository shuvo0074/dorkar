import { readFileSync } from 'node:fs';
import { Kysely, PostgresDialect, sql, type Generated, type ColumnType } from 'kysely';
import pg from 'pg';
import type { BaseConfig } from '../config';

// Return bigint (int8) as string → mapped explicitly where used; never silently lose precision.
// Return timestamptz as Date (pg default).

export type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
export type { Generated };

/** Tables every service schema gets from the kernel migration. */
export interface KernelTables {
  outbox: {
    id: string;
    type: string;
    version: number;
    aggregate_id: string;
    payload: unknown;
    correlation_id: string | null;
    causation_id: string | null;
    /** W3C traceparent of the producing span (kernelOutboxTraceMigration). */
    traceparent: string | null;
    occurred_at: Timestamp;
    published_at: Timestamp | null;
    attempts: Generated<number>;
  };
  inbox: {
    consumer: string;
    event_id: string;
    processed_at: Generated<Date>;
  };
  audit_log: {
    id: string;
    occurred_at: Generated<Date>;
    actor_id: string | null;
    actor_type: 'USER' | 'ADMIN' | 'SYSTEM' | 'ANONYMOUS';
    action: string;
    target_type: string | null;
    target_id: string | null;
    request_id: string | null;
    ip_hash: string | null;
    metadata: unknown;
  };
}

export type DatabaseConfig = Pick<
  BaseConfig,
  | 'DATABASE_URL'
  | 'DATABASE_SCHEMA'
  | 'DATABASE_POOL_MAX'
  | 'DATABASE_SSL'
  | 'DATABASE_SSL_CA'
  | 'DATABASE_STATEMENT_TIMEOUT_MS'
  | 'SERVICE_NAME'
>;

export interface Database<DB> {
  /** Query builder scoped to the service's own schema. */
  db: Kysely<DB>;
  /** Unscoped handle — migrations and health checks only. */
  root: Kysely<unknown>;
  pool: pg.Pool;
  ping(): Promise<void>;
  close(): Promise<void>;
}

function sslOptions(cfg: DatabaseConfig): pg.PoolConfig['ssl'] {
  switch (cfg.DATABASE_SSL) {
    case 'disable':
      return false;
    case 'require':
      // Encrypted, but the server certificate is not verified (common for managed PG behind private networking).
      return { rejectUnauthorized: false };
    case 'verify-full':
      return {
        rejectUnauthorized: true,
        ...(cfg.DATABASE_SSL_CA ? { ca: readFileSync(cfg.DATABASE_SSL_CA, 'utf8') } : {}),
      };
  }
}

/**
 * Connects using only standard Postgres features so the same code runs on managed PG, a VPS
 * or a laptop. Schema scoping uses `withSchema` (not `search_path` startup options) so it also
 * works behind PgBouncer in transaction mode.
 */
export function createDatabase<DB>(cfg: DatabaseConfig): Database<DB> {
  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    ssl: sslOptions(cfg),
    application_name: cfg.SERVICE_NAME,
    statement_timeout: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const root = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
  const db = (root as unknown as Kysely<DB>).withSchema(cfg.DATABASE_SCHEMA);

  return {
    db,
    root,
    pool,
    async ping() {
      await sql`select 1`.execute(root);
    },
    async close() {
      await root.destroy();
    },
  };
}
