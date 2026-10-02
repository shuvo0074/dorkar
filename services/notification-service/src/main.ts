import { createLogger, runServiceMain } from '@dorkar/kernel';
import { migrations } from '../migrations';
import { buildNotificationService } from './app';

const { runtime } = await buildNotificationService(
  process.env,
  createLogger({
    service: process.env['SERVICE_NAME'] ?? 'notification-service',
    version: process.env['SERVICE_VERSION'] ?? 'dev',
    env: process.env['NODE_ENV'] ?? 'development',
    level: process.env['LOG_LEVEL'] ?? 'info',
  }),
);
await runServiceMain(runtime, migrations);
