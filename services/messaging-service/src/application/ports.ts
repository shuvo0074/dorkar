import type { ConversationContext, EventEnvelope } from '@dorkar/contracts';
import type { AuditEntry, Cursor, RequestContext } from '@dorkar/kernel';
import type { ContextFacts, Message, Pair } from '../domain/conversation';

export interface Conversation {
  id: string;
  contextType: ConversationContext;
  contextId: string;
  pair: Pair;
  lastMessageAt: Date | null;
  createdAt: Date;
}

/** A conversation as one participant sees it. */
export interface ConversationForParticipant extends Conversation {
  accountId: string;
  otherId: string;
  unreadCount: number;
  lastReadMessageId: string | null;
  activityAt: Date;
  lastMessage: Pick<Message, 'id' | 'senderId' | 'body' | 'hidden' | 'createdAt'> | null;
}

export interface NewMessage {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  clientId: string;
  body: string;
  mediaIds: string[];
}

export interface Block {
  blockedId: string;
  createdAt: Date;
}

/** Everything the use cases need from storage, bound to one executor (autocommit or a transaction). */
export interface MessagingStore {
  // ---- context projection
  context(type: ConversationContext, id: string): Promise<ContextFacts | null>;
  /** Applies the facts unless a newer event already did (out-of-order delivery). */
  upsertContext(facts: ContextFacts, occurredAt: Date): Promise<void>;
  /** Marks an open context unavailable, creating a placeholder if the publish is late. */
  setContextAvailable(
    type: ConversationContext,
    id: string,
    ownerId: string,
    available: boolean,
    occurredAt: Date,
  ): Promise<void>;

  // ---- conversations
  findByPair(
    type: ConversationContext,
    contextId: string,
    pair: Pair,
  ): Promise<Conversation | null>;
  /** Insert-if-missing on the unique (context, pair) index. Returns the row and whether it was new. */
  createConversation(c: {
    id: string;
    contextType: ConversationContext;
    contextId: string;
    pair: Pair;
  }): Promise<{ conversation: Conversation; created: boolean }>;
  conversation(id: string): Promise<Conversation | null>;
  forParticipant(
    conversationId: string,
    accountId: string,
  ): Promise<ConversationForParticipant | null>;
  listForParticipant(
    accountId: string,
    cursor: Cursor | null,
    take: number,
  ): Promise<ConversationForParticipant[]>;
  /** Locks the conversation row and allocates the next message sequence number. */
  nextSeq(conversationId: string): Promise<number>;

  // ---- messages
  message(id: string): Promise<Message | null>;
  messageInConversation(conversationId: string, messageId: string): Promise<Message | null>;
  messageByClientId(
    conversationId: string,
    senderId: string,
    clientId: string,
  ): Promise<Message | null>;
  insertMessage(m: NewMessage): Promise<Message>;
  /** Conversation pointers + recipient unread + sender read marker, after a send. */
  recordSent(m: Message, recipientId: string): Promise<void>;
  /** Newest first, strictly before the cursor's seq. */
  messagesBefore(
    conversationId: string,
    beforeSeq: number | null,
    take: number,
  ): Promise<Message[]>;
  /** Oldest first, strictly after `afterSeq`. */
  messagesAfter(conversationId: string, afterSeq: number, take: number): Promise<Message[]>;
  /** Monotonic read marker; recomputes the unread count. Returns the resulting state. */
  markRead(
    conversationId: string,
    accountId: string,
    seq: number,
  ): Promise<{ lastReadMessageId: string | null; unreadCount: number }>;
  setHidden(messageId: string, hidden: boolean, caseId: string): Promise<void>;

  // ---- blocks
  blockedEitherWay(x: string, y: string): Promise<boolean>;
  block(blockerId: string, blockedId: string): Promise<{ block: Block; created: boolean }>;
  unblock(blockerId: string, blockedId: string): Promise<boolean>;
  listBlocks(blockerId: string, cursor: Cursor | null, take: number): Promise<Block[]>;

  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
}

export interface MessagingUnitOfWork {
  readonly store: MessagingStore;
  transaction<T>(fn: (store: MessagingStore) => Promise<T>): Promise<T>;
}

/**
 * Wakes long-polling readers. Publish happens after commit (a woken reader must find the row);
 * subscribers re-read from the database, so a lost wake-up only costs latency, never data.
 */
export interface MessageNotifier {
  publish(conversationId: string, messageId: string): Promise<void>;
  /** Resolves once the subscription is live; call the returned function to stop listening. */
  subscribe(conversationId: string, onMessage: () => void): Promise<() => void>;
}

/** Lets the other side read private attachments (media-service read grants). */
export interface MediaAccess {
  grant(
    input: {
      ownerId: string;
      mediaIds: string[];
      accountIds: string[];
      purpose: 'MESSAGE' | 'DISPUTE';
    },
    ctx: Pick<RequestContext, 'requestId' | 'correlationId'>,
  ): Promise<void>;
}
