import {
  MessagingEvents,
  type CatalogEvents,
  type ConversationContext,
  type LendingEvents,
  type ModerationEvents,
  type OfferEvents,
  type TransactionEvents,
} from '@dorkar/contracts';
import {
  AppError,
  decodeCursor,
  Errors,
  paginate,
  uuidv7,
  type Logger,
  type RateLimiter,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { z } from 'zod';
import {
  assertNoContactInfo,
  assertNotSelfBlock,
  blockedError,
  dedupe,
  resolvePair,
  type Message,
} from '../domain/conversation';
import type {
  Block,
  Conversation,
  ConversationForParticipant,
  MediaAccess,
  MessageNotifier,
  MessagingStore,
  MessagingUnitOfWork,
} from './ports';

type Payload<D extends { schema: z.ZodType }> = z.output<D['schema']>;

export interface MessagingSettings {
  sendPerMinute: number;
  longPollMaxSeconds: number;
}

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

const seqCursor = (raw: string | undefined): number | null => {
  const c = decodeCursor(raw);
  if (!c) return null;
  if (typeof c.k !== 'number' || !Number.isSafeInteger(c.k)) {
    throw Errors.validation('Invalid cursor.');
  }
  return c.k;
};

/** Messaging use cases. Each mutation writes its state and its outbox event in one transaction. */
export class MessagingService {
  constructor(
    private readonly uow: MessagingUnitOfWork,
    private readonly event: ServiceRuntime<never>['event'],
    private readonly limiter: RateLimiter,
    private readonly notifier: MessageNotifier,
    private readonly settings: MessagingSettings,
    private readonly logger: Logger,
    private readonly media: MediaAccess,
  ) {}

  // ------------------------------------------------------------------ conversations

  /** Idempotent: returns the existing conversation for (context, pair) or creates it. */
  async getOrCreate(
    input: { contextType: ConversationContext; contextId: string },
    ctx: RequestContext,
  ): Promise<{ conversation: ConversationForParticipant; created: boolean }> {
    const actor = requireActor(ctx);
    const facts = await this.uow.store.context(input.contextType, input.contextId);
    const r = resolvePair(facts, actor.id);
    if (r.kind === 'NOT_PARTY') throw Errors.notFound('Conversation context');
    if (r.kind === 'SELF') {
      throw new AppError(
        'BUSINESS_RULE_VIOLATION',
        'You cannot start a conversation with yourself.',
        {
          rule: 'CANNOT_MESSAGE_SELF',
        },
      );
    }
    const existing = await this.uow.store.findByPair(input.contextType, input.contextId, r.pair);
    if (existing) {
      return {
        conversation: await this.view(this.uow.store, existing.id, actor.id),
        created: false,
      };
    }
    // Existing conversations survive the listing going away; new ones need it available.
    if (r.kind === 'UNAVAILABLE') throw Errors.notFound('Conversation context');

    return this.uow.transaction(async (s) => {
      const { conversation, created } = await s.createConversation({
        id: uuidv7(),
        contextType: input.contextType,
        contextId: input.contextId,
        pair: r.pair,
      });
      if (created) {
        await s.audit(ctx, {
          action: 'conversation.created',
          targetType: 'CONVERSATION',
          targetId: conversation.id,
          metadata: { contextType: input.contextType, contextId: input.contextId },
        });
      }
      return { conversation: await this.view(s, conversation.id, actor.id), created };
    });
  }

  async get(conversationId: string, ctx: RequestContext): Promise<ConversationForParticipant> {
    const actor = requireActor(ctx);
    return this.view(this.uow.store, conversationId, actor.id);
  }

  async listMine(
    q: { cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<{ items: ConversationForParticipant[]; nextCursor: string | null }> {
    const actor = requireActor(ctx);
    const cursor = decodeCursor(q.cursor);
    if (cursor && typeof cursor.k !== 'string') throw Errors.validation('Invalid cursor.');
    const rows = await this.uow.store.listForParticipant(actor.id, cursor, q.limit + 1);
    return paginate(rows, q.limit, (c) => ({ k: c.activityAt.toISOString(), id: c.id }));
  }

  // ------------------------------------------------------------------ messages

  async send(
    conversationId: string,
    input: { body: string; mediaIds?: string[] | undefined; clientId: string },
    ctx: RequestContext,
  ): Promise<{ message: Message; created: boolean }> {
    const actor = requireActor(ctx);
    const conv = await this.view(this.uow.store, conversationId, actor.id);

    // A retry returns the original message, whatever it carries now, and costs no quota.
    const prior = await this.uow.store.messageByClientId(conv.id, actor.id, input.clientId);
    if (prior) return { message: prior, created: false };

    assertNoContactInfo(input.body);
    if (await this.uow.store.blockedEitherWay(actor.id, conv.otherId)) throw blockedError();

    const rl = await this.limiter.consume([
      { key: `msg:send:${actor.id}`, limit: this.settings.sendPerMinute, windowMs: 60_000 },
    ]);
    if (!rl.allowed) throw Errors.rateLimited(rl.retryAfterMs);

    // Outside the DB transaction (network): refuses media the sender doesn't own.
    const mediaIds = dedupe(input.mediaIds ?? []);
    await this.media.grant(
      { ownerId: actor.id, mediaIds, accountIds: [conv.otherId], purpose: 'MESSAGE' },
      ctx,
    );

    const result = await this.uow.transaction(async (s) => {
      const seq = await s.nextSeq(conv.id); // serializes sends in this conversation
      // Re-check under the lock: a concurrent retry with the same clientId may have won.
      const raced = await s.messageByClientId(conv.id, actor.id, input.clientId);
      if (raced) return { message: raced, created: false };
      const message = await s.insertMessage({
        id: uuidv7(),
        conversationId: conv.id,
        seq,
        senderId: actor.id,
        clientId: input.clientId,
        body: input.body,
        mediaIds,
      });
      await s.recordSent(message, conv.otherId);
      await s.outbox(
        this.event(
          MessagingEvents.MessageSent,
          conv.id,
          {
            messageId: message.id,
            conversationId: conv.id,
            contextType: conv.contextType,
            contextId: conv.contextId,
            senderId: actor.id,
            recipientIds: [conv.otherId],
          },
          ctx,
        ),
      );
      return { message, created: true };
    });

    if (result.created) {
      // After commit, so a woken long-poller finds the row. Best effort: pollers also time out.
      this.notifier.publish(conv.id, result.message.id).catch((err: unknown) => {
        this.logger.warn({ err: (err as Error).message }, 'message wake-up publish failed');
      });
    }
    return result;
  }

  /** Newest first, keyset on the per-conversation sequence. */
  async history(
    conversationId: string,
    q: { before?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<{ items: Message[]; nextCursor: string | null }> {
    const actor = requireActor(ctx);
    const conv = await this.view(this.uow.store, conversationId, actor.id);
    const before = seqCursor(q.before);
    const rows = await this.uow.store.messagesBefore(conv.id, before, q.limit + 1);
    return paginate(rows, q.limit, (m) => ({ k: m.seq, id: m.id }));
  }

  /**
   * Long poll: messages newer than `afterMessageId` (oldest first). Returns at once when there
   * are some; otherwise waits up to `waitSeconds` for a wake-up, then re-reads (maybe []).
   */
  async poll(
    conversationId: string,
    q: { afterMessageId: string; waitSeconds: number; limit: number },
    ctx: RequestContext,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const actor = requireActor(ctx);
    const conv = await this.view(this.uow.store, conversationId, actor.id);
    const anchor = await this.uow.store.messageInConversation(conv.id, q.afterMessageId);
    if (!anchor) throw Errors.notFound('Message');
    const read = () => this.uow.store.messagesAfter(conv.id, anchor.seq, q.limit);

    const first = await read();
    const waitMs = Math.min(q.waitSeconds, this.settings.longPollMaxSeconds) * 1000;
    if (first.length > 0 || waitMs <= 0 || signal?.aborted) return first;

    let wake!: () => void;
    const woken = new Promise<void>((resolve) => (wake = resolve));
    const unsubscribe = await this.notifier.subscribe(conv.id, () => wake());
    const timer = setTimeout(() => wake(), waitMs);
    const onAbort = () => wake();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // A message committed between the first read and the subscription has already published.
      const again = await read();
      if (again.length > 0) return again;
      await woken;
      if (signal?.aborted) return [];
      return await read();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    }
  }

  async markRead(
    conversationId: string,
    upToMessageId: string,
    ctx: RequestContext,
  ): Promise<{ lastReadMessageId: string | null; unreadCount: number }> {
    const actor = requireActor(ctx);
    const conv = await this.view(this.uow.store, conversationId, actor.id);
    return this.uow.transaction(async (s) => {
      const m = await s.messageInConversation(conv.id, upToMessageId);
      if (!m) throw Errors.notFound('Message');
      return s.markRead(conv.id, actor.id, m.seq);
    });
  }

  // ------------------------------------------------------------------ blocking

  async block(userId: string, ctx: RequestContext): Promise<{ block: Block; created: boolean }> {
    const actor = requireActor(ctx);
    assertNotSelfBlock(actor.id, userId);
    return this.uow.transaction(async (s) => {
      const r = await s.block(actor.id, userId);
      if (r.created) {
        await s.audit(ctx, { action: 'user.blocked', targetType: 'USER', targetId: userId });
      }
      return r;
    });
  }

  async unblock(userId: string, ctx: RequestContext): Promise<void> {
    const actor = requireActor(ctx);
    await this.uow.transaction(async (s) => {
      if (await s.unblock(actor.id, userId)) {
        await s.audit(ctx, { action: 'user.unblocked', targetType: 'USER', targetId: userId });
      }
    });
  }

  async listBlocks(
    q: { cursor?: string | undefined; limit: number },
    ctx: RequestContext,
  ): Promise<{ items: Block[]; nextCursor: string | null }> {
    const actor = requireActor(ctx);
    const cursor = decodeCursor(q.cursor);
    if (cursor && typeof cursor.k !== 'string') throw Errors.validation('Invalid cursor.');
    const rows = await this.uow.store.listBlocks(actor.id, cursor, q.limit + 1);
    return paginate(rows, q.limit, (b) => ({ k: b.createdAt.toISOString(), id: b.blockedId }));
  }

  // ------------------------------------------------------------------ moderation

  /**
   * Reviewing a report: the message (full content, even if hidden) and up to `around` messages
   * either side. Every read is audited.
   */
  async adminRead(
    messageId: string,
    ctx: RequestContext,
    around = 10,
  ): Promise<{
    message: Message;
    conversation: Conversation;
    before: Message[];
    after: Message[];
  }> {
    requireActor(ctx);
    const message = await this.uow.store.message(messageId);
    if (!message) throw Errors.notFound('Message');
    return this.uow.transaction(async (s) => {
      const [newestFirst, after] = await Promise.all([
        s.messagesBefore(message.conversationId, message.seq, around),
        s.messagesAfter(message.conversationId, message.seq, around),
      ]);
      const conversation = await this.anyView(s, message.conversationId);
      await s.audit(ctx, {
        action: 'message.read.admin',
        actorType: 'ADMIN',
        targetType: 'MESSAGE',
        targetId: message.id,
        metadata: { conversationId: message.conversationId },
      });
      return { message, conversation, before: newestFirst.reverse(), after };
    });
  }

  /** For the moderation service: does the reported message exist, and who sent it. */
  async internalFacts(
    messageId: string,
  ): Promise<{ message: Message; participantIds: [string, string] }> {
    const message = await this.uow.store.message(messageId);
    if (!message) throw Errors.notFound('Message');
    const conv = await this.anyView(this.uow.store, message.conversationId);
    return { message, participantIds: [conv.pair.a, conv.pair.b] };
  }

  // ------------------------------------------------------------------ event handlers (inbox trx)

  async onListing(
    s: MessagingStore,
    p: Payload<(typeof CatalogEvents)['ListingPublished']>,
    occurredAt: Date,
  ): Promise<void> {
    await s.upsertContext(
      {
        type: 'LISTING',
        id: p.listingId,
        ownerId: p.sellerId,
        counterpartId: null,
        available: p.quantityAvailable > 0,
      },
      occurredAt,
    );
  }

  async onListingUnavailable(
    s: MessagingStore,
    p: Payload<(typeof CatalogEvents)['ListingUnavailable']>,
    occurredAt: Date,
  ): Promise<void> {
    await s.setContextAvailable('LISTING', p.listingId, p.sellerId, false, occurredAt);
  }

  async onLendItem(
    s: MessagingStore,
    p: Payload<(typeof LendingEvents)['LendItemPublished']>,
    occurredAt: Date,
  ): Promise<void> {
    await s.upsertContext(
      {
        type: 'LEND_ITEM',
        id: p.itemId,
        ownerId: p.lenderId,
        counterpartId: null,
        available: p.active,
      },
      occurredAt,
    );
  }

  async onOfferSubmitted(
    s: MessagingStore,
    p: Payload<(typeof OfferEvents)['OfferSubmitted']>,
    occurredAt: Date,
  ): Promise<void> {
    await s.upsertContext(
      {
        type: 'OFFER',
        id: p.offerId,
        ownerId: p.sellerId,
        counterpartId: p.buyerId,
        available: true,
      },
      occurredAt,
    );
  }

  async onTransactionCreated(
    s: MessagingStore,
    p: Payload<(typeof TransactionEvents)['TransactionCreated']>,
    occurredAt: Date,
  ): Promise<void> {
    await s.upsertContext(
      {
        type: 'TRANSACTION',
        id: p.transactionId,
        ownerId: p.sellerId,
        counterpartId: p.buyerId,
        available: true,
      },
      occurredAt,
    );
  }

  async onContentModerated(
    s: MessagingStore,
    p: Payload<(typeof ModerationEvents)['ContentModerated']>,
  ): Promise<void> {
    if (p.targetType !== 'MESSAGE') return;
    await s.setHidden(p.targetId, p.action === 'HIDE', p.caseId);
  }

  // ------------------------------------------------------------------ helpers

  /** Participants only; everyone else gets the same 404 as for a missing conversation. */
  private async view(
    s: MessagingStore,
    conversationId: string,
    accountId: string,
  ): Promise<ConversationForParticipant> {
    const c = await s.forParticipant(conversationId, accountId);
    if (!c) throw Errors.notFound('Conversation');
    return c;
  }

  private async anyView(s: MessagingStore, conversationId: string): Promise<Conversation> {
    const c = await s.conversation(conversationId);
    if (!c) throw Errors.notFound('Conversation');
    return c;
  }
}
