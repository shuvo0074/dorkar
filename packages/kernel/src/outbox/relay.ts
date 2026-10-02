import type { EventEnvelope } from '@dorkar/contracts';
import type { Kysely } from 'kysely';
import type { KernelTables } from '../db/database';
import type { Logger } from '../logger';
import type { Metrics } from '../metrics';

/** Port: where committed events go. Redis Streams today; NATS/RabbitMQ later. */
export interface EventPublisher {
  publish(events: readonly EventEnvelope[]): Promise<void>;
}

export interface OutboxRelayOptions {
  producer: string;
  batchSize?: number;
  intervalMs?: number;
  maxBackoffMs?: number;
  metrics?: Metrics;
}

/**
 * Polls the outbox and publishes at-least-once. Safe to run in several instances:
 * rows are claimed with FOR UPDATE SKIP LOCKED.
 */
export class OutboxRelay {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private failures = 0;
  private stopped = true;

  constructor(
    private readonly db: Kysely<KernelTables>,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
    private readonly opts: OutboxRelayOptions,
  ) {}

  /** Publish one batch. Returns the number of events published. */
  async tick(): Promise<number> {
    const batchSize = this.opts.batchSize ?? 100;
    return this.db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('outbox')
        .selectAll()
        .where('published_at', 'is', null)
        .orderBy('occurred_at')
        .orderBy('id')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()
        .execute();
      if (rows.length === 0) return 0;

      await this.publisher.publish(
        rows.map((r) => ({
          id: r.id,
          type: r.type,
          version: r.version,
          occurredAt: new Date(r.occurred_at).toISOString(),
          producer: this.opts.producer,
          aggregateId: r.aggregate_id,
          ...(r.correlation_id ? { correlationId: r.correlation_id } : {}),
          ...(r.causation_id ? { causationId: r.causation_id } : {}),
          ...(r.traceparent ? { traceparent: r.traceparent } : {}),
          payload: r.payload as Record<string, unknown>,
        })),
      );
      await trx
        .updateTable('outbox')
        .set((eb) => ({ published_at: new Date(), attempts: eb('attempts', '+', 1) }))
        .where(
          'id',
          'in',
          rows.map((r) => r.id),
        )
        .execute();
      this.opts.metrics?.eventsPublished.inc(rows.length);
      return rows.length;
    });
  }

  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      let delay = this.opts.intervalMs ?? 500;
      try {
        const n = await this.tick();
        this.failures = 0;
        if (n === (this.opts.batchSize ?? 100)) delay = 0; // drain backlog quickly
      } catch (err) {
        this.failures++;
        this.opts.metrics?.outboxPublishFailures.inc();
        delay = Math.min(
          (this.opts.intervalMs ?? 500) * 2 ** this.failures,
          this.opts.maxBackoffMs ?? 30_000,
        );
        this.logger.error({ err, failures: this.failures }, 'outbox relay failed');
      }
      if (!this.stopped) {
        this.timer = setTimeout(() => {
          this.running = loop();
        }, delay);
      }
    };
    this.running = loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
