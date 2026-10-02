import { appendAudit, appendToOutbox } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type {
  Conversation,
  ConversationForParticipant,
  MessagingStore,
  MessagingUnitOfWork,
} from '../application/ports';
import type { Message } from '../domain/conversation';
import type { MessagingDB } from './db-schema';

type Executor = Kysely<MessagingDB> | Transaction<MessagingDB>;

const toMessage = (r: Selectable<MessagingDB['messages']>): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  seq: Number(r.seq),
  senderId: r.sender_id,
  clientId: r.client_id,
  body: r.body,
  mediaIds: r.media_ids,
  hidden: r.hidden,
  createdAt: r.created_at,
});

const toConversation = (r: Selectable<MessagingDB['conversations']>): Conversation => ({
  id: r.id,
  contextType: r.context_type,
  contextId: r.context_id,
  pair: { a: r.participant_a, b: r.participant_b },
  lastMessageAt: r.last_message_at,
  createdAt: r.created_at,
});

export function pgMessagingStore(db: Executor): MessagingStore {
  /** A conversation from one participant's side, with its last message and read marker. */
  const participantView = () =>
    db
      .selectFrom('conversation_participants as p')
      .innerJoin('conversations as c', 'c.id', 'p.conversation_id')
      .leftJoin('messages as lm', 'lm.id', 'c.last_message_id')
      .leftJoin('messages as lr', (j) =>
        j
          .onRef('lr.conversation_id', '=', 'p.conversation_id')
          .onRef('lr.seq', '=', 'p.last_read_seq'),
      )
      .select([
        'c.id',
        'c.context_type',
        'c.context_id',
        'c.participant_a',
        'c.participant_b',
        'c.last_message_at',
        'c.created_at',
        'p.account_id',
        'p.other_id',
        'p.unread_count',
        'p.activity_at',
        'lr.id as last_read_id',
        'lm.id as lm_id',
        'lm.sender_id as lm_sender_id',
        'lm.body as lm_body',
        'lm.hidden as lm_hidden',
        'lm.created_at as lm_created_at',
      ]);

  type ViewRow = Awaited<ReturnType<ReturnType<typeof participantView>['executeTakeFirstOrThrow']>>;
  const toView = (r: ViewRow): ConversationForParticipant => ({
    id: r.id,
    contextType: r.context_type,
    contextId: r.context_id,
    pair: { a: r.participant_a, b: r.participant_b },
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
    accountId: r.account_id,
    otherId: r.other_id,
    unreadCount: r.unread_count,
    activityAt: r.activity_at,
    lastReadMessageId: r.last_read_id,
    lastMessage:
      r.lm_id !== null &&
      r.lm_sender_id !== null &&
      r.lm_body !== null &&
      r.lm_hidden !== null &&
      r.lm_created_at !== null
        ? {
            id: r.lm_id,
            senderId: r.lm_sender_id,
            body: r.lm_body,
            hidden: r.lm_hidden,
            createdAt: r.lm_created_at,
          }
        : null,
  });

  const conversation = async (id: string) => {
    const r = await db
      .selectFrom('conversations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return r ? toConversation(r) : null;
  };

  const forParticipant = async (conversationId: string, accountId: string) => {
    const r = await participantView()
      .where('p.conversation_id', '=', conversationId)
      .where('p.account_id', '=', accountId)
      .executeTakeFirst();
    return r ? toView(r) : null;
  };

  const messageByClientId = async (conversationId: string, senderId: string, clientId: string) => {
    const r = await db
      .selectFrom('messages')
      .selectAll()
      .where('conversation_id', '=', conversationId)
      .where('sender_id', '=', senderId)
      .where('client_id', '=', clientId)
      .executeTakeFirst();
    return r ? toMessage(r) : null;
  };

  return {
    // ---------------------------------------------------------------- context projection
    async context(type, id) {
      const r = await db
        .selectFrom('conversation_contexts')
        .selectAll()
        .where('context_type', '=', type)
        .where('context_id', '=', id)
        .executeTakeFirst();
      return r
        ? {
            type: r.context_type,
            id: r.context_id,
            ownerId: r.owner_id,
            counterpartId: r.counterpart_id,
            available: r.available,
          }
        : null;
    },
    async upsertContext(f, occurredAt) {
      const row = {
        owner_id: f.ownerId,
        counterpart_id: f.counterpartId,
        available: f.available,
        last_event_at: occurredAt,
      };
      await db
        .insertInto('conversation_contexts')
        .values({ context_type: f.type, context_id: f.id, ...row })
        .onConflict((oc) =>
          oc
            .columns(['context_type', 'context_id'])
            .doUpdateSet({ ...row, updated_at: sql<Date>`now()` })
            .whereRef('conversation_contexts.last_event_at', '<=', 'excluded.last_event_at'),
        )
        .execute();
    },
    async setContextAvailable(type, id, ownerId, available, occurredAt) {
      await db
        .insertInto('conversation_contexts')
        .values({
          context_type: type,
          context_id: id,
          owner_id: ownerId,
          counterpart_id: null,
          available,
          last_event_at: occurredAt,
        })
        .onConflict((oc) =>
          oc
            .columns(['context_type', 'context_id'])
            .doUpdateSet({ available, last_event_at: occurredAt, updated_at: sql<Date>`now()` })
            .whereRef('conversation_contexts.last_event_at', '<=', 'excluded.last_event_at'),
        )
        .execute();
    },

    // ---------------------------------------------------------------- conversations
    async findByPair(type, contextId, pair) {
      const r = await db
        .selectFrom('conversations')
        .selectAll()
        .where('context_type', '=', type)
        .where('context_id', '=', contextId)
        .where('participant_a', '=', pair.a)
        .where('participant_b', '=', pair.b)
        .executeTakeFirst();
      return r ? toConversation(r) : null;
    },
    async createConversation(c) {
      const inserted = await db
        .insertInto('conversations')
        .values({
          id: c.id,
          context_type: c.contextType,
          context_id: c.contextId,
          participant_a: c.pair.a,
          participant_b: c.pair.b,
          last_message_id: null,
          last_message_at: null,
        })
        .onConflict((oc) =>
          oc.columns(['context_type', 'context_id', 'participant_a', 'participant_b']).doNothing(),
        )
        .returningAll()
        .executeTakeFirst();
      if (inserted) {
        await db
          .insertInto('conversation_participants')
          .values([
            {
              conversation_id: inserted.id,
              account_id: c.pair.a,
              other_id: c.pair.b,
              activity_at: inserted.created_at,
            },
            {
              conversation_id: inserted.id,
              account_id: c.pair.b,
              other_id: c.pair.a,
              activity_at: inserted.created_at,
            },
          ])
          .execute();
        return { conversation: toConversation(inserted), created: true };
      }
      // Lost the race (or it already existed): the winner has committed by now.
      const existing = await db
        .selectFrom('conversations')
        .selectAll()
        .where('context_type', '=', c.contextType)
        .where('context_id', '=', c.contextId)
        .where('participant_a', '=', c.pair.a)
        .where('participant_b', '=', c.pair.b)
        .executeTakeFirstOrThrow();
      return { conversation: toConversation(existing), created: false };
    },
    conversation,
    forParticipant,
    async listForParticipant(accountId, cursor, take) {
      let q = participantView().where('p.account_id', '=', accountId);
      if (cursor) {
        q = q.where((eb) =>
          eb(
            eb.refTuple('p.activity_at', 'p.conversation_id'),
            '<',
            eb.tuple(new Date(cursor.k), cursor.id),
          ),
        );
      }
      const rows = await q
        .orderBy('p.activity_at', 'desc')
        .orderBy('p.conversation_id', 'desc')
        .limit(take)
        .execute();
      return rows.map(toView);
    },
    async nextSeq(conversationId) {
      const r = await db
        .updateTable('conversations')
        .set((eb) => ({ last_seq: eb('last_seq', '+', 1) }))
        .where('id', '=', conversationId)
        .returning('last_seq')
        .executeTakeFirstOrThrow();
      return Number(r.last_seq);
    },

    // ---------------------------------------------------------------- messages
    async message(id) {
      const r = await db.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirst();
      return r ? toMessage(r) : null;
    },
    async messageInConversation(conversationId, messageId) {
      const r = await db
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', messageId)
        .where('conversation_id', '=', conversationId)
        .executeTakeFirst();
      return r ? toMessage(r) : null;
    },
    messageByClientId,
    async insertMessage(m) {
      const r = await db
        .insertInto('messages')
        .values({
          id: m.id,
          conversation_id: m.conversationId,
          seq: m.seq,
          sender_id: m.senderId,
          client_id: m.clientId,
          body: m.body,
          media_ids: m.mediaIds,
          moderation_case_id: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toMessage(r);
    },
    async recordSent(m, recipientId) {
      await db
        .updateTable('conversations')
        .set({ last_message_id: m.id, last_message_at: m.createdAt })
        .where('id', '=', m.conversationId)
        .execute();
      await db
        .updateTable('conversation_participants')
        .set((eb) => ({ activity_at: m.createdAt, unread_count: eb('unread_count', '+', 1) }))
        .where('conversation_id', '=', m.conversationId)
        .where('account_id', '=', recipientId)
        .execute();
      // Replying means the sender has seen everything before it (this seq is the newest).
      await db
        .updateTable('conversation_participants')
        .set({ activity_at: m.createdAt, last_read_seq: m.seq, unread_count: 0 })
        .where('conversation_id', '=', m.conversationId)
        .where('account_id', '=', m.senderId)
        .execute();
    },
    async messagesBefore(conversationId, beforeSeq, take) {
      let q = db.selectFrom('messages').selectAll().where('conversation_id', '=', conversationId);
      if (beforeSeq !== null) q = q.where('seq', '<', beforeSeq);
      const rows = await q.orderBy('seq', 'desc').limit(take).execute();
      return rows.map(toMessage);
    },
    async messagesAfter(conversationId, afterSeq, take) {
      const rows = await db
        .selectFrom('messages')
        .selectAll()
        .where('conversation_id', '=', conversationId)
        .where('seq', '>', afterSeq)
        .orderBy('seq', 'asc')
        .limit(take)
        .execute();
      return rows.map(toMessage);
    },
    async markRead(conversationId, accountId, seq) {
      // Row lock: a concurrent send's unread increment lands either before our recount (and is
      // counted) or after it (and adds on top), never lost.
      const cur = await db
        .selectFrom('conversation_participants')
        .select('last_read_seq')
        .where('conversation_id', '=', conversationId)
        .where('account_id', '=', accountId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const upTo = Math.max(Number(cur.last_read_seq), seq);
      const { n } = await db
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('conversation_id', '=', conversationId)
        .where('seq', '>', upTo)
        .where('sender_id', '<>', accountId)
        .executeTakeFirstOrThrow();
      const unreadCount = Number(n);
      await db
        .updateTable('conversation_participants')
        .set({ last_read_seq: upTo, unread_count: unreadCount })
        .where('conversation_id', '=', conversationId)
        .where('account_id', '=', accountId)
        .execute();
      const marker =
        upTo > 0
          ? await db
              .selectFrom('messages')
              .select('id')
              .where('conversation_id', '=', conversationId)
              .where('seq', '=', upTo)
              .executeTakeFirst()
          : undefined;
      return { lastReadMessageId: marker?.id ?? null, unreadCount };
    },
    async setHidden(messageId, hidden, caseId) {
      await db
        .updateTable('messages')
        .set({ hidden, moderation_case_id: caseId })
        .where('id', '=', messageId)
        .execute();
    },

    // ---------------------------------------------------------------- blocks
    async blockedEitherWay(x, y) {
      const r = await db
        .selectFrom('blocks')
        .select('blocker_id')
        .where((eb) =>
          eb.or([
            eb.and([eb('blocker_id', '=', x), eb('blocked_id', '=', y)]),
            eb.and([eb('blocker_id', '=', y), eb('blocked_id', '=', x)]),
          ]),
        )
        .limit(1)
        .executeTakeFirst();
      return !!r;
    },
    async block(blockerId, blockedId) {
      const inserted = await db
        .insertInto('blocks')
        .values({ blocker_id: blockerId, blocked_id: blockedId })
        .onConflict((oc) => oc.columns(['blocker_id', 'blocked_id']).doNothing())
        .returning(['blocked_id', 'created_at'])
        .executeTakeFirst();
      const row =
        inserted ??
        (await db
          .selectFrom('blocks')
          .select(['blocked_id', 'created_at'])
          .where('blocker_id', '=', blockerId)
          .where('blocked_id', '=', blockedId)
          .executeTakeFirstOrThrow());
      return {
        block: { blockedId: row.blocked_id, createdAt: row.created_at },
        created: !!inserted,
      };
    },
    async unblock(blockerId, blockedId) {
      const r = await db
        .deleteFrom('blocks')
        .where('blocker_id', '=', blockerId)
        .where('blocked_id', '=', blockedId)
        .executeTakeFirst();
      return Number(r.numDeletedRows) > 0;
    },
    async listBlocks(blockerId, cursor, take) {
      let q = db
        .selectFrom('blocks')
        .select(['blocked_id', 'created_at'])
        .where('blocker_id', '=', blockerId);
      if (cursor) {
        q = q.where((eb) =>
          eb(eb.refTuple('created_at', 'blocked_id'), '<', eb.tuple(new Date(cursor.k), cursor.id)),
        );
      }
      const rows = await q
        .orderBy('created_at', 'desc')
        .orderBy('blocked_id', 'desc')
        .limit(take)
        .execute();
      return rows.map((r) => ({ blockedId: r.blocked_id, createdAt: r.created_at }));
    },

    audit: (ctx, entry) => appendAudit(db, ctx, entry),
    outbox: (events) => appendToOutbox(db, events),
  };
}

export function pgMessagingUnitOfWork(db: Kysely<MessagingDB>): MessagingUnitOfWork {
  return {
    store: pgMessagingStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgMessagingStore(trx))),
  };
}
