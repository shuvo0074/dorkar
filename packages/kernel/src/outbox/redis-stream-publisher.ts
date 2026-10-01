import { eventStreamFor, type EventEnvelope } from '@dorkar/contracts';
import type { Redis } from 'ioredis';
import type { EventPublisher } from './relay';

/**
 * Publishes to one stream per producer (`events:<producer>`). Consumers use consumer groups
 * and filter by `type`. Streams are trimmed approximately; the outbox remains the durable record.
 */
export class RedisStreamPublisher implements EventPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly producer: string,
    private readonly maxLen = 1_000_000,
  ) {}

  async publish(events: readonly EventEnvelope[]): Promise<void> {
    const stream = eventStreamFor(this.producer);
    const pipeline = this.redis.pipeline();
    for (const e of events) {
      pipeline.xadd(
        stream,
        'MAXLEN',
        '~',
        this.maxLen,
        '*',
        'type',
        e.type,
        'event',
        JSON.stringify(e),
      );
    }
    const results = await pipeline.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0] as Error;
  }
}
