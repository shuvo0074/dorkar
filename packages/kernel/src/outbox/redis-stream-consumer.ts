import { EventEnvelopeSchema, eventStreamFor, type EventEnvelope } from '@dorkar/contracts';
import type { Redis } from 'ioredis';
import type { Logger } from '../logger';

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export interface RedisStreamConsumerOptions {
  /** Producer whose stream to read (`events:<producer>`). */
  producer: string;
  /** Consumer group: one per consuming *service*; instances of that service share it. */
  group: string;
  /** Unique per process (e.g. hostname + pid). */
  consumer: string;
  handler: EventHandler;
  logger: Logger;
  batchSize?: number;
  blockMs?: number;
  /** A message pending this long (handler crashed or failed) is retried. */
  retryAfterMs?: number;
  /** After this many deliveries the message goes to the dead-letter stream. */
  maxDeliveries?: number;
}

export const deadLetterStreamFor = (producer: string, group: string) =>
  `dlq:${eventStreamFor(producer)}:${group}`;

type StreamEntry = [id: string, fields: string[]];
type ReadReply = Array<[stream: string, entries: StreamEntry[]]> | null;
type PendingReply = Array<[id: string, consumer: string, idleMs: number, deliveries: number]>;

/**
 * At-least-once consumer over a Redis Stream consumer group.
 *
 *  - Messages are ACKed only after the handler succeeds; failures stay pending and are
 *    re-claimed after `retryAfterMs` (by this or any other instance of the service).
 *  - After `maxDeliveries`, or if the message is malformed, it is moved to a dead-letter stream
 *    and ACKed, so one poison message cannot block the group.
 *  - Handlers MUST be idempotent (use the event `id`; DB-backed consumers record it in `inbox`).
 *
 * Needs a dedicated connection without a command timeout (it issues blocking reads).
 */
export class RedisStreamConsumer {
  private stopped = true;
  private loop: Promise<void> | null = null;
  private readonly stream: string;
  private readonly dlq: string;

  constructor(
    private readonly redis: Redis,
    private readonly opts: RedisStreamConsumerOptions,
  ) {
    this.stream = eventStreamFor(opts.producer);
    this.dlq = deadLetterStreamFor(opts.producer, opts.group);
  }

  async ensureGroup(): Promise<void> {
    try {
      // From the beginning of the retained stream: a new consumer service sees past events.
      await this.redis.xgroup('CREATE', this.stream, this.opts.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('BUSYGROUP'))) throw err;
    }
  }

  /** One iteration: retry stale pending messages, then read new ones. Returns messages handled. */
  async poll(blockMs = this.opts.blockMs ?? 5_000): Promise<number> {
    let handled = await this.retryPending();
    const reply = (await this.redis.xreadgroup(
      'GROUP',
      this.opts.group,
      this.opts.consumer,
      'COUNT',
      this.opts.batchSize ?? 50,
      'BLOCK',
      blockMs,
      'STREAMS',
      this.stream,
      '>',
    )) as ReadReply;
    for (const [, entries] of reply ?? []) {
      for (const entry of entries) {
        await this.handle(entry);
        handled++;
      }
    }
    return handled;
  }

  async start(): Promise<void> {
    await this.ensureGroup();
    this.stopped = false;
    this.loop = (async () => {
      let backoff = 0;
      while (!this.stopped) {
        try {
          await this.poll();
          backoff = 0;
        } catch (err) {
          if (this.stopped) break;
          backoff = Math.min(backoff ? backoff * 2 : 250, 10_000);
          this.opts.logger.error({ err, stream: this.stream }, 'event consumer poll failed');
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Unblock a pending XREADGROUP; unacked messages are simply redelivered later.
    this.redis.disconnect();
    await this.loop;
  }

  private async retryPending(): Promise<number> {
    const retryAfterMs = this.opts.retryAfterMs ?? 30_000;
    const pending = (await this.redis.xpending(
      this.stream,
      this.opts.group,
      'IDLE',
      retryAfterMs,
      '-',
      '+',
      this.opts.batchSize ?? 50,
    )) as PendingReply;
    let handled = 0;
    for (const [id, , , deliveries] of pending) {
      const claimed = (await this.redis.xclaim(
        this.stream,
        this.opts.group,
        this.opts.consumer,
        retryAfterMs,
        id,
      )) as StreamEntry[];
      const entry = claimed[0];
      if (!entry) continue; // claimed by another instance meanwhile
      if (deliveries >= (this.opts.maxDeliveries ?? 5)) {
        await this.deadLetter(entry, `exceeded ${deliveries} deliveries`);
      } else {
        await this.handle(entry);
      }
      handled++;
    }
    return handled;
  }

  private async handle([id, fields]: StreamEntry): Promise<void> {
    const raw = fieldValue(fields, 'event');
    let event: EventEnvelope;
    try {
      event = EventEnvelopeSchema.parse(JSON.parse(raw ?? 'null'));
    } catch {
      await this.deadLetter([id, fields], 'malformed event');
      return;
    }
    try {
      await this.opts.handler(event);
      await this.redis.xack(this.stream, this.opts.group, id);
    } catch (err) {
      // Left pending → retried after retryAfterMs, dead-lettered after maxDeliveries.
      this.opts.logger.warn(
        { err, eventId: event.id, type: event.type, correlationId: event.correlationId },
        'event handler failed; will retry',
      );
    }
  }

  private async deadLetter([id, fields]: StreamEntry, reason: string): Promise<void> {
    await this.redis
      .multi()
      .xadd(this.dlq, '*', ...fields, 'sourceId', id, 'reason', reason)
      .xack(this.stream, this.opts.group, id)
      .exec();
    this.opts.logger.error({ streamId: id, stream: this.stream, reason }, 'event dead-lettered');
  }
}

function fieldValue(fields: string[], name: string): string | undefined {
  for (let i = 0; i < fields.length; i += 2) if (fields[i] === name) return fields[i + 1];
  return undefined;
}
