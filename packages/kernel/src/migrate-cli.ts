import { z } from 'zod';
import { baseEnvSchema, loadConfig } from './config';
import { createDatabase } from './db/database';
import { migrateDown, migrateUp, migrationStatus, type Migration } from './db/migrator';
import { createLogger } from './logger';

/**
 * Body of every service's `src/cli/migrate.ts`: `migrate up | down [steps] | status`.
 * Runs as a one-shot job before a release takes traffic, optionally with a more privileged role
 * (MIGRATION_DATABASE_URL).
 */
export async function runMigrateCli(opts: {
  service: string;
  defaultSchema: string;
  migrations: readonly Migration[];
  argv?: string[];
}): Promise<void> {
  const config = loadConfig(
    baseEnvSchema
      .pick({ DATABASE_URL: true, DATABASE_SSL: true, DATABASE_SSL_CA: true, LOG_LEVEL: true })
      .extend({
        DATABASE_SCHEMA: z.string().default(opts.defaultSchema),
        MIGRATION_DATABASE_URL: z.string().optional(),
      }),
  );
  const logger = createLogger({
    service: `${opts.service}-migrate`,
    version: 'n/a',
    env: 'n/a',
    level: config.LOG_LEVEL,
  });
  const database = createDatabase({
    ...config,
    DATABASE_URL: config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL,
    DATABASE_POOL_MAX: 1,
    DATABASE_STATEMENT_TIMEOUT_MS: 15 * 60_000,
    SERVICE_NAME: `${opts.service}-migrate`,
  });
  const m = {
    db: database.root,
    schema: config.DATABASE_SCHEMA,
    migrations: opts.migrations,
    logger,
  };
  const [command = 'up', arg] = opts.argv ?? process.argv.slice(2);
  try {
    if (command === 'up') {
      const ran = await migrateUp(m);
      logger.info({ ran }, ran.length ? 'migrations applied' : 'already up to date');
    } else if (command === 'down') {
      logger.info({ ran: await migrateDown(m, Number(arg ?? 1)) }, 'migrations rolled back');
    } else if (command === 'status') {
      for (const s of await migrationStatus(m)) {
        process.stdout.write(
          `${s.appliedAt ? '✔' : '·'} ${s.name}${s.appliedAt ? `  (${s.appliedAt.toISOString()})` : ''}\n`,
        );
      }
    } else {
      throw new Error(`unknown command ${command}`);
    }
  } catch (err) {
    logger.fatal({ err }, 'migration failed');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
