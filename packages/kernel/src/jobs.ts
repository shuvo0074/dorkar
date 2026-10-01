import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from './logger';

export interface PeriodicJob {
  stop(): Promise<void>;
}

/**
 * Runs `run` every `intervalMs` in at most one instance cluster-wide at a time
 * (transaction-scoped advisory lock — released automatically, PgBouncer-safe).
 * For maintenance work whose source of truth is Postgres (purges, expiry sweeps), so a lost
 * tick is simply picked up by the next one.
 */
export function startPeriodicJob<DB>(opts: {
  name: string;
  intervalMs: number;
  db: Kysely<DB>;
  logger: Logger;
  run: (trx: Transaction<DB>) => Promise<number | void>;
}): PeriodicJob {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;

  const tick = async () => {
    try {
      await opts.db.transaction().execute(async (trx) => {
        const { rows } = await sql<{ locked: boolean }>`
          select pg_try_advisory_xact_lock(hashtext(${`job:${opts.name}`})) as locked`.execute(trx);
        if (!rows[0]?.locked) return;
        const affected = await opts.run(trx);
        opts.logger.debug({ job: opts.name, affected }, 'job completed');
      });
    } catch (err) {
      opts.logger.error({ err, job: opts.name }, 'job failed');
    }
    if (!stopped) {
      timer = setTimeout(() => {
        current = tick();
      }, opts.intervalMs);
    }
  };
  timer = setTimeout(() => {
    current = tick();
  }, opts.intervalMs);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current;
    },
  };
}
