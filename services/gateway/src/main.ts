import { createLogger, runService } from '@dorkar/kernel';
import { buildGateway } from './app';
import { loadGatewayConfig } from './config/env';

const config = loadGatewayConfig();
const logger = createLogger({
  service: config.SERVICE_NAME,
  version: config.SERVICE_VERSION,
  env: config.NODE_ENV,
  level: config.LOG_LEVEL,
});

const gw = await buildGateway(config, logger);
await gw.startWorkers();
await runService({
  app: gw.app,
  host: config.HOST,
  port: config.PORT,
  logger,
  graceMs: config.SHUTDOWN_GRACE_MS,
  closers: [
    { name: 'redis', close: async () => gw.redis.disconnect() },
    { name: 'workers', close: () => gw.stopWorkers() },
  ],
});
