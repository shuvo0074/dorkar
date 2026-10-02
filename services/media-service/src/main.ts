import { createLogger, runServiceMain } from '@dorkar/kernel';
import { migrations } from '../migrations';
import { buildMediaService } from './app';

const { runtime } = await buildMediaService(
  process.env,
  createLogger({
    service: process.env['SERVICE_NAME'] ?? 'media-service',
    version: process.env['SERVICE_VERSION'] ?? 'dev',
    env: process.env['NODE_ENV'] ?? 'development',
    level: process.env['LOG_LEVEL'] ?? 'info',
  }),
);
await runServiceMain(runtime, migrations);
