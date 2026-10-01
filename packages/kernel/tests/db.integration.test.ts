import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityEvents } from '@dorkar/contracts';
import { appendAudit } from '../src/audit';
import { createDatabase, type Database, type KernelTables } from '../src/db/database';
import { kernelMigration } from '../src/db/kernel-migration';
import { migrateDown, migrateUp, migrationStatus, type Migration } from '../src/db/migrator';
import { appendToOutbox, createEventFactory } from '../src/outbox/outbox';
import { OutboxRelay, type EventPublisher } from '../src/outbox/relay';
import {
  captureLogger,
  dropSchema,
  ensureTestDatabase,
  TEST_DATABASE_URL,
  uniqueSchema,
} from '../src/testing';
import { uuidv7 } from '../src/crypto';

const schema = uniqueSchema('kernel');
let database: Database<KernelTables>;
const { logger } = captureLogger('silent');

const widgets: Migration = {
  name: '0001_widgets',
  up: async (trx) => void (await sql`create table widgets (id int primary key)`.execute(trx)),
  down: async (trx) => void (await sql`drop table widgets`.execute(trx)),
};
const migrations = [kernelMigration, widgets];

beforeAll(async () => {
  await ensureTestDatabase();
  database = createDatabase<KernelTables>({
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_SCHEMA: schema,
    DATABASE_POOL_MAX: 5,
    DATABASE_SSL: 'disable',
    DATABASE_STATEMENT_TIMEOUT_MS: 5000,
    SERVICE_NAME: 'kernel-test',
  });
});
afterAll(async () => {
  await dropSchema(database.root, schema);
  await database.close();
});

describe('migrator', () => {
  it('applies, is idempotent, rolls back and re-applies', async () => {
    expect(await migrateUp({ db: database.root, schema, migrations, logger })).toEqual([
      '0000_kernel',
      '0001_widgets',
    ]);
    expect(await migrateUp({ db: database.root, schema, migrations })).toEqual([]);
    expect(await migrateDown({ db: database.root, schema, migrations })).toEqual(['0001_widgets']);
    const status = await migrationStatus({ db: database.root, schema, migrations });
    expect(status.map((s) => s.appliedAt !== null)).toEqual([true, false]);
    expect(await migrateUp({ db: database.root, schema, migrations })).toEqual(['0001_widgets']);
  });

  it('serializes concurrent runs (advisory lock)', async () => {
    const extra: Migration = {
      name: '0002_slow',
      up: async (trx) => void (await sql`select pg_sleep(0.2)`.execute(trx)),
      down: async () => {},
    };
    const all = [...migrations, extra];
    const results = await Promise.all([
      migrateUp({ db: database.root, schema, migrations: all }),
      migrateUp({ db: database.root, schema, migrations: all }),
    ]);
    expect(results.flat()).toEqual(['0002_slow']);
    await migrateDown({ db: database.root, schema, migrations: all });
  });

  it('refuses to run when the DB has migrations unknown to the build', async () => {
    await expect(
      migrateUp({ db: database.root, schema, migrations: [kernelMigration] }),
    ).rejects.toThrow(/unknown to this build/);
  });
});

describe('audit log', () => {
  it('is append-only', async () => {
    const ctx = { requestId: 'r1', ipHash: null, actor: null };
    await appendAudit(database.db, ctx, { action: 'test.action', metadata: { a: 1 } });
    const row = await database.db.selectFrom('audit_log').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ action: 'test.action', actor_type: 'ANONYMOUS', request_id: 'r1' });
    await expect(
      database.db.updateTable('audit_log').set({ action: 'x' }).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(database.db.deleteFrom('audit_log').execute()).rejects.toThrow(/append-only/);
    await expect(
      sql`truncate ${sql.id(schema, 'audit_log')}`.execute(database.root),
    ).rejects.toThrow(/append-only/);
  });
});

describe('outbox relay', () => {
  it('publishes committed events exactly once per tick and skips rolled-back ones', async () => {
    const event = createEventFactory('kernel-test');
    const accountId = uuidv7();
    await database.db.transaction().execute(async (trx) => {
      await appendToOutbox(trx, event(IdentityEvents.AccountCreated, accountId, { accountId }));
    });
    await database.db
      .transaction()
      .execute(async (trx) => {
        await appendToOutbox(
          trx,
          event(IdentityEvents.AccountCreated, uuidv7(), { accountId: uuidv7() }),
        );
        throw new Error('rollback');
      })
      .catch(() => {});

    const published: unknown[] = [];
    const publisher: EventPublisher = { publish: async (e) => void published.push(...e) };
    const relay = new OutboxRelay(database.db, publisher, logger, { producer: 'kernel-test' });

    expect(await relay.tick()).toBe(1);
    expect(await relay.tick()).toBe(0);
    expect(published).toEqual([
      expect.objectContaining({
        type: 'identity.AccountCreated',
        payload: { accountId },
        producer: 'kernel-test',
      }),
    ]);
  });

  it('keeps events when publishing fails', async () => {
    const event = createEventFactory('kernel-test');
    const id = uuidv7();
    await appendToOutbox(database.db, event(IdentityEvents.AccountCreated, id, { accountId: id }));
    const failing = new OutboxRelay(
      database.db,
      { publish: async () => Promise.reject(new Error('down')) },
      logger,
      {
        producer: 'kernel-test',
      },
    );
    await expect(failing.tick()).rejects.toThrow('down');
    const ok = new OutboxRelay(database.db, { publish: async () => {} }, logger, {
      producer: 'kernel-test',
    });
    expect(await ok.tick()).toBe(1);
  });

  it('rejects invalid payloads at the source', () => {
    const event = createEventFactory('kernel-test');
    expect(() => event(IdentityEvents.AccountCreated, 'x', { accountId: 'not-a-uuid' })).toThrow();
  });
});
