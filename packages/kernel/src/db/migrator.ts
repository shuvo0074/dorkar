import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from '../logger';

export interface Migration {
  /** Sortable, unique, never renamed once applied: `0001_kernel`, `0002_accounts`, … */
  name: string;
  /** Runs inside a transaction with `search_path` set to the service schema. */
  up(trx: Transaction<unknown>): Promise<void>;
  down(trx: Transaction<unknown>): Promise<void>;
}

export interface MigrationStatus {
  name: string;
  appliedAt: Date | null;
}

interface Options {
  db: Kysely<unknown>;
  schema: string;
  migrations: readonly Migration[];
  logger?: Logger;
}

function assertOrdered(migrations: readonly Migration[]) {
  const names = migrations.map((m) => m.name);
  const sorted = [...names].sort();
  if (names.some((n, i) => n !== sorted[i]) || new Set(names).size !== names.length) {
    throw new Error('Migrations must be unique and listed in ascending name order');
  }
}

/**
 * Minimal, explicit migrator:
 *  - one session-level advisory lock per schema, so concurrent deploys cannot race;
 *  - each migration in its own transaction with `SET LOCAL search_path` to the service schema;
 *  - refuses to run if the DB contains migrations unknown to this code (out-of-order deploy).
 */
export async function withMigrationLock<T>(
  { db, schema }: Pick<Options, 'db' | 'schema'>,
  fn: (conn: Kysely<unknown>) => Promise<T>,
): Promise<T> {
  return db.connection().execute(async (conn) => {
    const lockKey = `migrate:${schema}`;
    await sql`select pg_advisory_lock(hashtext(${lockKey}))`.execute(conn);
    try {
      const exists = await sql<{ n: number }>`
        select count(*)::int as n from information_schema.schemata where schema_name = ${schema}`.execute(
        conn,
      );
      if (exists.rows[0]?.n === 0) await sql`create schema ${sql.id(schema)}`.execute(conn);
      await sql`
        create table if not exists ${sql.id(schema, 'schema_migrations')} (
          name text primary key,
          applied_at timestamptz not null default now()
        )`.execute(conn);
      return await fn(conn);
    } finally {
      await sql`select pg_advisory_unlock(hashtext(${lockKey}))`.execute(conn);
    }
  });
}

async function applied(conn: Kysely<unknown>, schema: string) {
  const r = await sql<{ name: string; applied_at: Date }>`
    select name, applied_at from ${sql.id(schema, 'schema_migrations')} order by name`.execute(
    conn,
  );
  return new Map(r.rows.map((row) => [row.name, row.applied_at]));
}

export async function migrationStatus(opts: Options): Promise<MigrationStatus[]> {
  assertOrdered(opts.migrations);
  return withMigrationLock(opts, async (conn) => {
    const done = await applied(conn, opts.schema);
    return opts.migrations.map((m) => ({ name: m.name, appliedAt: done.get(m.name) ?? null }));
  });
}

export async function migrateUp(opts: Options): Promise<string[]> {
  assertOrdered(opts.migrations);
  const { schema, migrations, logger } = opts;
  return withMigrationLock(opts, async (conn) => {
    const done = await applied(conn, schema);
    const known = new Set(migrations.map((m) => m.name));
    const unknown = [...done.keys()].filter((n) => !known.has(n));
    if (unknown.length) {
      throw new Error(`Database has migrations unknown to this build: ${unknown.join(', ')}`);
    }
    const ran: string[] = [];
    for (const m of migrations) {
      if (done.has(m.name)) continue;
      await conn.transaction().execute(async (trx) => {
        await sql`set local search_path to ${sql.id(schema)}, public`.execute(trx);
        await m.up(trx);
        await sql`insert into ${sql.id(schema, 'schema_migrations')} (name) values (${m.name})`.execute(
          trx,
        );
      });
      logger?.info({ migration: m.name, schema }, 'migration applied');
      ran.push(m.name);
    }
    return ran;
  });
}

/** Roll back the most recent `steps` migrations. */
export async function migrateDown(opts: Options, steps = 1): Promise<string[]> {
  const { schema, migrations, logger } = opts;
  return withMigrationLock(opts, async (conn) => {
    const done = await applied(conn, schema);
    const targets = [...done.keys()].sort().reverse().slice(0, steps);
    const byName = new Map(migrations.map((m) => [m.name, m]));
    const ran: string[] = [];
    for (const name of targets) {
      const m = byName.get(name);
      if (!m) throw new Error(`Cannot roll back unknown migration ${name}`);
      await conn.transaction().execute(async (trx) => {
        await sql`set local search_path to ${sql.id(schema)}, public`.execute(trx);
        await m.down(trx);
        await sql`delete from ${sql.id(schema, 'schema_migrations')} where name = ${name}`.execute(
          trx,
        );
      });
      logger?.info({ migration: name, schema }, 'migration rolled back');
      ran.push(name);
    }
    return ran;
  });
}
