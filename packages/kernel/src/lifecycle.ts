import type { App } from './http/server';
import type { Logger } from './logger';

export interface ServiceProcess {
  app: App;
  host: string;
  port: number;
  logger: Logger;
  graceMs: number;
  /** Closed in reverse order after the HTTP server stops (workers first, then pools). */
  closers: Array<{ name: string; close: () => Promise<unknown> }>;
}

/**
 * Starts the HTTP server and installs graceful shutdown:
 * SIGTERM → readiness fails (LB stops routing) → short drain delay → stop accepting,
 * finish in-flight requests → close workers and pools → exit.
 */
export async function runService(p: ServiceProcess): Promise<void> {
  let stopping = false;

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    p.logger.info({ signal }, 'shutdown started');
    const force = setTimeout(() => {
      p.logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, p.graceMs + 5_000);
    force.unref();

    p.app.markShuttingDown();
    await new Promise((r) => setTimeout(r, Math.min(p.graceMs, 5_000)));
    try {
      await p.app.close();
      for (const c of [...p.closers].reverse()) {
        try {
          await c.close();
        } catch (err) {
          p.logger.error({ err, resource: c.name }, 'error while closing');
        }
      }
      p.logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      p.logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => p.logger.error({ err }, 'unhandled rejection'));

  await p.app.listen({ host: p.host, port: p.port });
}
