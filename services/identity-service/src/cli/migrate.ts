/**
 * Migration job: `migrate up | down [steps] | status`.
 * Runs as a one-shot container before a release receives traffic.
 */
import {
  baseEnvSchema,
  createDatabase,
  createLogger,
  loadConfig,
  migrateDown,
  migrateUp,
  migrationStatus,
} from '@dorkar/kernel';
import { z } from 'zod';
import { migrations } from '../../migrations';

const config = loadConfig(
  baseEnvSchema
    .pick({ DATABASE_URL: true, DATABASE_SSL: true, DATABASE_SSL_CA: true, LOG_LEVEL: true })
    .extend({
      DATABASE_SCHEMA: z.string().default('identity'),
      // Migrations may use a more privileged role than the service.
      MIGRATION_DATABASE_URL: z.string().optional(),
    }),
);
const logger = createLogger({
  service: 'identity-migrate',
  version: 'n/a',
  env: 'n/a',
  level: config.LOG_LEVEL,
});
const database = createDatabase({
  ...config,
  DATABASE_URL: config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL,
  DATABASE_POOL_MAX: 1,
  DATABASE_STATEMENT_TIMEOUT_MS: 15 * 60_000,
  SERVICE_NAME: 'identity-migrate',
});
const opts = { db: database.root, schema: config.DATABASE_SCHEMA, migrations, logger };

const [command = 'up', arg] = process.argv.slice(2);
try {
  if (command === 'up') {
    const ran = await migrateUp(opts);
    logger.info({ ran }, ran.length ? 'migrations applied' : 'already up to date');
  } else if (command === 'down') {
    const ran = await migrateDown(opts, Number(arg ?? 1));
    logger.info({ ran }, 'migrations rolled back');
  } else if (command === 'status') {
    for (const m of await migrationStatus(opts)) {
      console.log(
        `${m.appliedAt ? '✔' : '·'} ${m.name}${m.appliedAt ? `  (${m.appliedAt.toISOString()})` : ''}`,
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
