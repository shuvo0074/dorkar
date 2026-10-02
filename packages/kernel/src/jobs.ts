import { sql, type Kysely, type Transaction } from 'kysely';
import type { Logger } from './logger';
import type { Metrics } from './metrics';

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
  /** `job_runs_total{job,outcome}` and `job_duration_seconds{job}`. */
  metrics?: Metrics;
}): PeriodicJob {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;

  const tick = async () => {
    const started = performance.now();
    let ran = false;
    try {
      await opts.db.transaction().execute(async (trx) => {
        const { rows } = await sql<{ locked: boolean }>`
          select pg_try_advisory_xact_lock(hashtext(${`job:${opts.name}`})) as locked`.execute(trx);
        if (!rows[0]?.locked) return;
        ran = true;
        const affected = await opts.run(trx);
        opts.logger.debug({ job: opts.name, affected }, 'job completed');
      });
      opts.metrics?.jobRuns.inc({ job: opts.name, outcome: ran ? 'succeeded' : 'skipped' });
    } catch (err) {
      opts.metrics?.jobRuns.inc({ job: opts.name, outcome: 'failed' });
      opts.logger.error({ err, job: opts.name }, 'job failed');
    }
    if (ran) {
      opts.metrics?.jobDuration.observe({ job: opts.name }, (performance.now() - started) / 1000);
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
