import { createLogger, migrationStatus, runService } from '@dorkar/kernel';
import { migrations } from '../migrations';
import { buildIdentityService } from './app';
import { loadIdentityConfig } from './config/env';

const config = loadIdentityConfig();
const logger = createLogger({
  service: config.SERVICE_NAME,
  version: config.SERVICE_VERSION,
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
});

const svc = await buildIdentityService(config, logger);

// Services never migrate themselves in production; refuse to start on a stale schema instead.
const pending = (
  await migrationStatus({ db: svc.database.root, schema: config.DATABASE_SCHEMA, migrations })
).filter((m) => !m.appliedAt);
if (pending.length) {
  logger.fatal(
    { pending: pending.map((m) => m.name) },
    'database has pending migrations; run the migrate job',
  );
  process.exit(1);
}

svc.startWorkers();
await runService({
  app: svc.app,
  host: config.HOST,
  port: config.PORT,
  logger,
  graceMs: config.SHUTDOWN_GRACE_MS,
  closers: [
    { name: 'redis', close: async () => svc.redis.disconnect() },
    { name: 'postgres', close: () => svc.database.close() },
    { name: 'workers', close: () => svc.stopWorkers() },
  ],
});
