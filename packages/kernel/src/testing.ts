/** Helpers for integration tests. Not imported by production code. */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Role } from '@dorkar/contracts';
import { SignJWT } from 'jose';
import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { z } from 'zod';
import type { KernelTables } from './db/database';
import { migrateUp, type Migration } from './db/migrator';
import { createJwtVerifier, type AccessTokenVerifier } from './http/auth';
import { createLogger, type Logger } from './logger';
import { createEventFactory, type EventDefinition } from './outbox/outbox';
import type { ServiceRuntime } from './service';

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

// ---------------------------------------------------------------------------------------------
// Service test harness: real Postgres (fresh schema per test file), real Redis, local token
// signing instead of identity's JWKS.

export interface TestAuth {
  verifier: AccessTokenVerifier;
  /** Signs an access token like identity would. Defaults: random account, MEMBER role. */
  token(
    claims?: Partial<{ sub: string; sid: string; did: string; roles: Role[]; iat: number }>,
  ): Promise<string>;
  /** `{ authorization: 'Bearer …' }` for `inject({ headers })`. */
  as(sub: string, roles?: Role[]): Promise<{ authorization: string }>;
}

export async function testAuth(): Promise<TestAuth> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const issuer = 'dorkar-identity';
  const audience = 'dorkar-api';
  const verifier = createJwtVerifier({ key: publicKey, issuer, audience });
  const token: TestAuth['token'] = async (c = {}) =>
    new SignJWT({
      sid: c.sid ?? randomUUID(),
      did: c.did ?? randomUUID(),
      roles: c.roles ?? ['MEMBER'],
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(c.sub ?? randomUUID())
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(c.iat ?? Math.floor(Date.now() / 1000))
      .setExpirationTime('10m')
      .sign(privateKey);
  return {
    verifier,
    token,
    async as(sub, roles = ['MEMBER']) {
      return { authorization: `Bearer ${await token({ sub, roles })}` };
    },
  };
}

export const TEST_INTERNAL_TOKEN = 'test-internal-token-0123456789abcdef0123456789';

/** Env for `serviceEnvSchema` (plus anything service-specific in `extra`). Workers off by default. */
export function testServiceEnv(
  schema: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: 'test',
    SERVICE_NAME: `${schema}-svc`,
    PORT: '1',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_SCHEMA: schema,
    REDIS_URL: TEST_REDIS_URL,
    JWKS_URL: 'http://127.0.0.1:9/.well-known/jwks.json',
    INTERNAL_API_TOKEN: TEST_INTERNAL_TOKEN,
    PII_HASH_KEY: randomBytes(32).toString('hex'),
    OUTBOX_RELAY_ENABLED: 'false',
    CONSUMERS_ENABLED: 'false',
    JOBS_ENABLED: 'false',
    ...extra,
  };
}

export interface TestService<R> {
  svc: R;
  auth: TestAuth;
  logLines: string[];
  schema: string;
  close(): Promise<void>;
}

/**
 * Builds a service against a fresh schema, migrates it, and returns it ready for `inject`.
 * `build` receives the env, a capturing logger and the test verifier.
 */
export async function startTestService<R extends { runtime: ServiceRuntime<KernelTables> }>(opts: {
  schemaPrefix: string;
  migrations: readonly Migration[];
  env?: Record<string, string>;
  build: (env: Record<string, string>, logger: Logger, verifier: AccessTokenVerifier) => Promise<R>;
}): Promise<TestService<R>> {
  await ensureTestDatabase();
  const schema = uniqueSchema(opts.schemaPrefix);
  const auth = await testAuth();
  const { logger, lines } = captureLogger('info');
  const svc = await opts.build(testServiceEnv(schema, opts.env), logger, auth.verifier);
  await migrateUp({ db: svc.runtime.database.root, schema, migrations: opts.migrations });
  await svc.runtime.app.ready();
  return {
    svc,
    auth,
    logLines: lines,
    schema,
    async close() {
      await svc.runtime.app.close();
      await dropSchema(svc.runtime.database.root, schema);
      await svc.runtime.close();
    },
  };
}

/** A fake envelope from another producer, for driving `runtime.deliver` in tests. */
export function envelope<S extends z.ZodType>(
  def: EventDefinition<S>,
  payload: z.input<S>,
  aggregateId = randomUUID(),
) {
  return createEventFactory(def.type.split('.')[0]!)(def, aggregateId, payload);
}
