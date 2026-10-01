/** Helpers for integration tests. Not imported by production code. */
import { Writable } from 'node:stream';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { createLogger, type Logger } from './logger';

export const TEST_DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://localhost:5432/dorkar_test';
export const TEST_REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379/15';

/** Creates the test database if it does not exist (idempotent, race-tolerant). */
export async function ensureTestDatabase(url = TEST_DATABASE_URL): Promise<void> {
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [
      dbName,
    ]);
    if (!rowCount) {
      await client
        .query(`create database "${dbName.replace(/"/g, '')}"`)
        .catch((err: { code?: string }) => {
          if (err.code !== '42P04') throw err; // created concurrently by another worker
        });
    }
  } finally {
    await client.end();
  }
}

export const uniqueSchema = (prefix: string) => `${prefix}_t${randomBytes(4).toString('hex')}`;

export async function dropSchema(root: Kysely<unknown>, schema: string): Promise<void> {
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(root);
}

/** Logger that records every serialized line, used to assert secrets never reach logs. */
export function captureLogger(level = 'trace'): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return {
    logger: createLogger({ service: 'test', version: 'test', env: 'test', level }, stream),
    lines,
  };
}
