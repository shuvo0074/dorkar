import type { Logger, Redis } from '@dorkar/kernel';
import type { MessageNotifier } from '../application/ports';

const channelFor = (conversationId: string) => `messaging:conversation:${conversationId}`;

/**
 * Redis pub/sub wake-ups for long polls. One dedicated subscriber connection per process,
 * shared by every waiting request: a channel is subscribed while at least one request listens
 * on it and unsubscribed when the last one leaves. Commands on one connection run in order, so
 * an unsubscribe followed by a re-subscribe of the same channel is safe.
 *
 * `publisher` must be a non-prefixed connection (pub/sub channels are not key-prefixed the same
 * way across clients); the subscriber is created lazily so idle processes hold no extra socket.
 */
export class RedisMessageNotifier implements MessageNotifier {
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly ready = new Map<string, Promise<unknown>>();

  constructor(
    private readonly publisher: Redis,
    private readonly createSubscriber: () => Redis,
    private readonly logger: Logger,
  ) {}

  async publish(conversationId: string, messageId: string): Promise<void> {
    await this.publisher.publish(channelFor(conversationId), messageId);
  }

  async subscribe(conversationId: string, onMessage: () => void): Promise<() => void> {
    const sub = this.connection();
    const channel = channelFor(conversationId);
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      this.ready.set(
        channel,
        sub.subscribe(channel).catch((err: unknown) => {
          // Fail open: the poll still times out and re-reads the database.
          this.logger.warn({ err: (err as Error).message }, 'message channel subscribe failed');
        }),
      );
    }
    set.add(onMessage);
    await this.ready.get(channel);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(onMessage);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.ready.delete(channel);
        sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  /** Number of channels with live listeners (for tests and diagnostics). */
  get activeChannels(): number {
    return this.listeners.size;
  }

  close(): void {
    this.listeners.clear();
    this.ready.clear();
    this.subscriber?.disconnect();
    this.subscriber = null;
  }

  private connection(): Redis {
    if (!this.subscriber) {
      const sub = this.createSubscriber();
      sub.on('message', (channel: string) => {
        for (const fn of this.listeners.get(channel) ?? []) fn();
      });
      this.subscriber = sub;
    }
    return this.subscriber;
  }
}
