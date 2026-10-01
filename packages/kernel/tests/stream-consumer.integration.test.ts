import { randomBytes } from 'node:crypto';
import { eventStreamFor, IdentityEvents, type EventEnvelope } from '@dorkar/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/crypto';
import { createEventFactory } from '../src/outbox/outbox';
import { RedisStreamPublisher } from '../src/outbox/redis-stream-publisher';
import {
  deadLetterStreamFor,
  RedisStreamConsumer,
  type EventHandler,
} from '../src/outbox/redis-stream-consumer';
import { createRedis } from '../src/redis';
import { captureLogger, TEST_REDIS_URL } from '../src/testing';

const { logger } = captureLogger('silent');
const bus = createRedis(TEST_REDIS_URL, { keyPrefix: null });
const streams: string[] = [];

afterAll(async () => {
  if (streams.length) await bus.del(...streams);
  bus.disconnect();
});

function setup(handler: EventHandler, opts: { maxDeliveries?: number; consumer?: string } = {}) {
  const producer = `ktest${randomBytes(4).toString('hex')}`;
  const group = 'g1';
  streams.push(eventStreamFor(producer), deadLetterStreamFor(producer, group));
  const make = (name: string) =>
    new RedisStreamConsumer(
      createRedis(TEST_REDIS_URL, { keyPrefix: null, commandTimeoutMs: null }),
      {
        producer,
        group,
        consumer: name,
        handler,
        logger,
        retryAfterMs: 20,
        maxDeliveries: opts.maxDeliveries ?? 3,
      },
    );
  const event = createEventFactory(producer);
  const publish = (n = 1) => {
    const events = Array.from({ length: n }, () => {
      const id = uuidv7();
      return event(IdentityEvents.AccountCreated, id, { accountId: id });
    });
    return new RedisStreamPublisher(bus, producer).publish(events).then(() => events);
  };
  return { producer, group, make, publish };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RedisStreamConsumer', () => {
  it('delivers published events and acks them', async () => {
    const seen: EventEnvelope[] = [];
    const { make, publish, producer, group } = setup(async (e) => void seen.push(e));
    const c = make('c1');
    await c.ensureGroup();
    const events = await publish(3);
    expect(await c.poll(10)).toBe(3);
    expect(seen.map((e) => e.id)).toEqual(events.map((e) => e.id));
    const summary = (await bus.xpending(eventStreamFor(producer), group)) as [number];
    expect(summary[0]).toBe(0);
    c['redis'].disconnect();
  });

  it('retries a failing handler and succeeds later', async () => {
    let calls = 0;
    const { make, publish } = setup(async () => {
      if (++calls < 2) throw new Error('transient');
    });
    const c = make('c1');
    await c.ensureGroup();
    await publish();
    await c.poll(10); // fails, stays pending
    await sleep(30);
    expect(await c.poll(10)).toBe(1); // re-claimed and handled
    expect(calls).toBe(2);
    c['redis'].disconnect();
  });

  it('dead-letters a message after maxDeliveries so it cannot block the group', async () => {
    let calls = 0;
    const { make, publish, producer, group } = setup(
      async () => {
        calls++;
        throw new Error('poison');
      },
      { maxDeliveries: 2 },
    );
    const c = make('c1');
    await c.ensureGroup();
    const [ev] = await publish();
    for (let i = 0; i < 4; i++) {
      await c.poll(10);
      await sleep(30);
    }
    expect(calls).toBe(2);
    const dlq = await bus.xrange(deadLetterStreamFor(producer, group), '-', '+');
    expect(dlq).toHaveLength(1);
    expect(dlq[0]![1].join(' ')).toContain(ev!.id);
    const summary = (await bus.xpending(eventStreamFor(producer), group)) as [number];
    expect(summary[0]).toBe(0);
    c['redis'].disconnect();
  });

  it('dead-letters malformed messages immediately', async () => {
    const seen: unknown[] = [];
    const { make, producer, group } = setup(async (e) => void seen.push(e));
    const c = make('c1');
    await c.ensureGroup();
    await bus.xadd(eventStreamFor(producer), '*', 'type', 'x', 'event', '{"not":"an envelope"}');
    await c.poll(10);
    expect(seen).toHaveLength(0);
    expect(await bus.xlen(deadLetterStreamFor(producer, group))).toBe(1);
    c['redis'].disconnect();
  });

  it('shares work across instances of the same service (consumer group)', async () => {
    const seen: string[] = [];
    const { make, publish } = setup(async (e) => void seen.push(e.id));
    const a = make('a');
    const b = make('b');
    await a.ensureGroup();
    await publish(10);
    await Promise.all([a.poll(10), b.poll(10)]);
    expect(new Set(seen).size).toBe(10);
    expect(seen).toHaveLength(10);
    a['redis'].disconnect();
    b['redis'].disconnect();
  });

  it('start/stop runs a background loop and stops promptly', async () => {
    const seen: string[] = [];
    const { make, publish } = setup(async (e) => void seen.push(e.id));
    const c = make('c1');
    await c.start();
    await publish(2);
    for (let i = 0; i < 50 && seen.length < 2; i++) await sleep(20);
    expect(seen).toHaveLength(2);
    const t = Date.now();
    await c.stop();
    expect(Date.now() - t).toBeLessThan(1_000);
  });
});
