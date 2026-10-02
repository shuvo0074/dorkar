import { createLogger, runServiceMain } from '@dorkar/kernel';
import { migrations } from '../migrations';
import { buildCatalogService } from './app';

const { runtime } = await buildCatalogService(
  process.env,
  createLogger({
    service: process.env['SERVICE_NAME'] ?? 'catalog-service',
    version: process.env['SERVICE_VERSION'] ?? 'dev',
    env: process.env['NODE_ENV'] ?? 'development',
    level: process.env['LOG_LEVEL'] ?? 'info',
  }),
);
await runServiceMain(runtime, migrations);
