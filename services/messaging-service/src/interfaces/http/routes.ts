import { ConversationContexts, PageQuerySchema, pageSchema } from '@dorkar/contracts';
import { ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { MessagingService } from '../../application/messaging-service';
import type { Conversation, ConversationForParticipant } from '../../application/ports';
import { BODY_MAX, MEDIA_MAX, preview, visible, type Message } from '../../domain/conversation';

const iso = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});
const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  422: ErrorResponse,
  429: ErrorResponse,
};

const ContextDto = z.object({ type: z.enum(ConversationContexts), id: z.uuid() });

/** A message as participants see it: moderation-hidden messages keep their slot, not their content. */
const MessageDto = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  senderId: z.uuid(),
  /** The sender's idempotency key, so a client can reconcile its optimistic copy. */
  clientId: z.uuid(),
  body: z.string().nullable(),
  mediaIds: z.array(z.uuid()),
  removed: z.boolean(),
  createdAt: iso,
});

const ConversationDto = z.object({
  id: z.uuid(),
  context: ContextDto,
  otherParticipantId: z.uuid(),
  unreadCount: z.number().int(),
  lastReadMessageId: z.uuid().nullable(),
  lastMessage: z
    .object({
      id: z.uuid(),
      senderId: z.uuid(),
      /** Null when the message was removed by moderation. */
      preview: z.string().nullable(),
      removed: z.boolean(),
      createdAt: iso,
    })
    .nullable(),
  lastMessageAt: iso.nullable(),
  createdAt: iso,
});

/** Moderator view: full content even when hidden. */
const AdminMessageDto = z.object({
  id: z.uuid(),
  senderId: z.uuid(),
  body: z.string(),
  mediaIds: z.array(z.uuid()),
  hidden: z.boolean(),
  createdAt: iso,
});

const toMessage = (m: Message): z.output<typeof MessageDto> => visible(m);

const toConversation = (c: ConversationForParticipant): z.output<typeof ConversationDto> => ({
  id: c.id,
  context: { type: c.contextType, id: c.contextId },
  otherParticipantId: c.otherId,
  unreadCount: c.unreadCount,
  lastReadMessageId: c.lastReadMessageId,
  lastMessage: c.lastMessage
    ? {
        id: c.lastMessage.id,
        senderId: c.lastMessage.senderId,
        preview: preview(c.lastMessage),
        removed: c.lastMessage.hidden,
        createdAt: c.lastMessage.createdAt,
      }
    : null,
  lastMessageAt: c.lastMessageAt,
  createdAt: c.createdAt,
});

const toAdminMessage = (m: Message): z.output<typeof AdminMessageDto> => ({
  id: m.id,
  senderId: m.senderId,
  body: m.body,
  mediaIds: m.mediaIds,
  hidden: m.hidden,
  createdAt: m.createdAt,
});

const toAdminConversation = (c: Conversation) => ({
  id: c.id,
  context: { type: c.contextType, id: c.contextId },
  participantIds: [c.pair.a, c.pair.b],
});

const IdParams = z.strictObject({ id: z.uuid() });

export interface MessagingRouteDeps {
  messaging: MessagingService;
  runtime: ServiceRuntime<never>;
  longPollMaxSeconds: number;
}

export const messagingRoutes: FastifyPluginAsyncZod<MessagingRouteDeps> = async (
  app,
  { messaging, runtime, longPollMaxSeconds },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  const ConversationResponse = z.object({ data: ConversationDto });

  // ---------------------------------------------------------------- conversations

  app.post(
    '/api/v1/conversations',
    {
      preHandler: authenticate,
      schema: {
        tags: ['messaging'],
        summary:
          'Open (or reopen) the conversation about a listing, offer, transaction or lend item',
        description:
          'Participants are derived from the context: an inquirer and the seller/lender for ' +
          'LISTING and LEND_ITEM; the buyer and the seller for OFFER and TRANSACTION. Idempotent: ' +
          '201 when created, 200 when it already exists. Callers who are not a party get 404.',
        ...secured,
        body: z.strictObject({ contextType: z.enum(ConversationContexts), contextId: z.uuid() }),
        response: { 200: ConversationResponse, 201: ConversationResponse, ...errors },
      },
    },
    async (req, reply) => {
      const { conversation, created } = await messaging.getOrCreate(req.body, req.ctx);
      void reply.code(created ? 201 : 200);
      return ok(toConversation(conversation));
    },
  );

  app.get(
    '/api/v1/conversations',
    {
      preHandler: authenticate,
      schema: {
        tags: ['messaging'],
        summary: 'My conversations, most recent activity first',
        ...secured,
        querystring: z.strictObject(PageQuerySchema.shape),
        response: { 200: pageSchema(ConversationDto), ...errors },
      },
    },
    async (req) => {
      const { items, nextCursor } = await messaging.listMine(req.query, req.ctx);
      return { data: items.map(toConversation), page: { nextCursor } };
    },
  );

  app.get(
    '/api/v1/conversations/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['messaging'],
        summary: 'A conversation (participants only; others get 404)',
        ...secured,
        params: IdParams,
        response: { 200: ConversationResponse, ...errors },
      },
    },
    async (req) => ok(toConversation(await messaging.get(req.params.id, req.ctx))),
  );

  // ---------------------------------------------------------------- messages

  const MessageResponse = z.object({ data: MessageDto });

  app.post(
    '/api/v1/conversations/:id/messages',
    {
      preHandler: requirePermission('message:send'),
      schema: {
        tags: ['messaging'],
        summary: 'Send a message',
        description:
          'Retries with the same clientId return the original message (200). Phone numbers and ' +
          'emails are rejected (422, rule CONTACT_INFO_NOT_ALLOWED). Refused with 403 when either ' +
          'participant has blocked the other.',
        ...secured,
        params: IdParams,
        body: z.strictObject({
          body: z.string().trim().min(1).max(BODY_MAX),
          mediaIds: z.array(z.uuid()).max(MEDIA_MAX).optional(),
          clientId: z.uuid(),
        }),
        response: { 200: MessageResponse, 201: MessageResponse, ...errors },
      },
    },
    async (req, reply) => {
      const { message, created } = await messaging.send(req.params.id, req.body, req.ctx);
      void reply.code(created ? 201 : 200);
      return ok(toMessage(message));
    },
  );

  app.get(
    '/api/v1/conversations/:id/messages',
    {
      preHandler: authenticate,
      schema: {
        tags: ['messaging'],
        summary: 'Message history, or long-poll for new messages',
        description:
          'History: newest first, continue with `before=<nextCursor>`. Long poll: ' +
          '`after=<messageId>&wait=<seconds>` returns newer messages oldest first as soon as there ' +
          `are any, or [] after the wait (at most ${longPollMaxSeconds}s).`,
        ...secured,
        params: IdParams,
        querystring: z
          .strictObject({
            limit: z.coerce.number().int().min(1).max(100).default(30),
            before: z.string().max(200).optional(),
            after: z.uuid().optional(),
            wait: z.coerce.number().int().min(0).max(longPollMaxSeconds).optional(),
          })
          .refine((q) => !(q.before && q.after), {
            message: 'Use either before or after, not both.',
          })
          .refine((q) => q.wait === undefined || q.after !== undefined, {
            message: 'wait requires after.',
          }),
        response: { 200: pageSchema(MessageDto), ...errors },
      },
    },
    async (req, reply) => {
      const q = req.query;
      if (q.after) {
        // Stop waiting as soon as the client goes away.
        const abort = new AbortController();
        const onClose = () => abort.abort();
        reply.raw.once('close', onClose);
        try {
          const items = await messaging.poll(
            req.params.id,
            { afterMessageId: q.after, waitSeconds: q.wait ?? 0, limit: q.limit },
            req.ctx,
            abort.signal,
          );
          return { data: items.map(toMessage), page: { nextCursor: null } };
        } finally {
          reply.raw.off('close', onClose);
        }
      }
      const { items, nextCursor } = await messaging.history(
        req.params.id,
        { before: q.before, limit: q.limit },
        req.ctx,
      );
      return { data: items.map(toMessage), page: { nextCursor } };
    },
  );

  app.post(
    '/api/v1/conversations/:id/read',
    {
      preHandler: authenticate,
      schema: {
        tags: ['messaging'],
        summary: 'Mark messages read up to one (never moves backwards)',
        ...secured,
        params: IdParams,
        body: z.strictObject({ upToMessageId: z.uuid() }),
        response: {
          200: z.object({
            data: z.object({
              lastReadMessageId: z.uuid().nullable(),
              unreadCount: z.number().int(),
            }),
          }),
          ...errors,
        },
      },
    },
    async (req) => ok(await messaging.markRead(req.params.id, req.body.upToMessageId, req.ctx)),
  );

  // ---------------------------------------------------------------- blocking

  const BlockDto = z.object({ userId: z.uuid(), blockedAt: iso });
  const BlockResponse = z.object({ data: BlockDto });

  app.post(
    '/api/v1/me/blocked-users',
    {
      preHandler: authenticate,
      schema: {
        tags: ['messaging'],
        summary: 'Block a user (neither of you can message the other)',
        ...secured,
        body: z.strictObject({ userId: z.uuid() }),
        response: { 200: BlockResponse, 201: BlockResponse, ...errors },
      },
    },
    async (req, reply) => {
      const { block, created } = await messaging.block(req.body.userId, req.ctx);
      void reply.code(created ? 201 : 200);
      return ok({ userId: block.blockedId, blockedAt: block.createdAt });
    },
  );

  app.delete(
    '/api/v1/me/blocked-users/:userId',
    {
      preHandler: authenticate,
      schema: {
        tags: ['messaging'],
        summary: 'Unblock a user (idempotent)',
        ...secured,
        params: z.strictObject({ userId: z.uuid() }),
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      await messaging.unblock(req.params.userId, req.ctx);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/api/v1/me/blocked-users',
    {
      preHandler: authenticate,
      schema: {
        tags: ['messaging'],
        summary: 'Users I have blocked',
        ...secured,
        querystring: z.strictObject(PageQuerySchema.shape),
        response: { 200: pageSchema(BlockDto), ...errors },
      },
    },
    async (req) => {
      const { items, nextCursor } = await messaging.listBlocks(req.query, req.ctx);
      return {
        data: items.map((b) => ({ userId: b.blockedId, blockedAt: b.createdAt })),
        page: { nextCursor },
      };
    },
  );

  // ---------------------------------------------------------------- moderation

  app.get(
    '/api/v1/admin/messages/:id',
    {
      preHandler: requirePermission('moderation:case:read'),
      schema: {
        tags: ['admin'],
        summary: 'Review a reported message with up to 10 messages either side (audited)',
        ...secured,
        params: IdParams,
        response: {
          200: z.object({
            data: z.object({
              message: AdminMessageDto,
              conversation: z.object({
                id: z.uuid(),
                context: ContextDto,
                participantIds: z.array(z.uuid()),
              }),
              before: z.array(AdminMessageDto),
              after: z.array(AdminMessageDto),
            }),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const r = await messaging.adminRead(req.params.id, req.ctx);
      return ok({
        message: toAdminMessage(r.message),
        conversation: toAdminConversation(r.conversation),
        before: r.before.map(toAdminMessage),
        after: r.after.map(toAdminMessage),
      });
    },
  );

  // moderation-service checks that a reported message exists and who sent it. No body.
  app.get(
    '/internal/v1/messages/:id',
    {
      preHandler: runtime.internalOnly,
      schema: {
        hide: true,
        params: IdParams,
        response: {
          200: z.object({
            data: z.object({
              id: z.uuid(),
              conversationId: z.uuid(),
              senderId: z.uuid(),
              participantIds: z.array(z.uuid()),
              hidden: z.boolean(),
              createdAt: iso,
            }),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const { message, participantIds } = await messaging.internalFacts(req.params.id);
      return ok({
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        participantIds,
        hidden: message.hidden,
        createdAt: message.createdAt,
      });
    },
  );
};
