import { createLogger, runServiceMain } from '@dorkar/kernel';
import { migrations } from '../migrations';
import { buildMatchingService } from './app';

const { runtime } = await buildMatchingService(
  process.env,
  createLogger({
    service: process.env['SERVICE_NAME'] ?? 'matching-service',
    version: process.env['SERVICE_VERSION'] ?? 'dev',
    env: process.env['NODE_ENV'] ?? 'development',
    level: process.env['LOG_LEVEL'] ?? 'info',
  }),
);
await runServiceMain(runtime, migrations);
