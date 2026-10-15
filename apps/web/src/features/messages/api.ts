import { api, query, type Page } from '../../lib/http';

export type ContextType = 'LISTING' | 'OFFER' | 'TRANSACTION' | 'LEND_ITEM';

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string;
  body: string | null;
  mediaIds: string[];
  removed: boolean;
  createdAt: string;
}

export interface Conversation {
  id: string;
  context: { type: ContextType; id: string };
  otherParticipantId: string;
  unreadCount: number;
  lastReadMessageId: string | null;
  lastMessage: {
    id: string;
    senderId: string;
    preview: string | null;
    removed: boolean;
    createdAt: string;
  } | null;
  lastMessageAt: string | null;
  createdAt: string;
}

const enc = encodeURIComponent;
const one = <T>(p: Promise<{ data: T }>) => p.then((r) => r.data);

export const chatApi = {
  open: (contextType: ContextType, contextId: string) =>
    one(
      api<{ data: Conversation }>('/api/v1/conversations', {
        method: 'POST',
        body: { contextType, contextId },
      }),
    ),
  list: (cursor?: string) =>
    api<Page<Conversation>>(`/api/v1/conversations${query({ cursor, limit: 30 })}`),
  get: (id: string) => one(api<{ data: Conversation }>(`/api/v1/conversations/${enc(id)}`)),
  history: (id: string, before?: string) =>
    api<Page<Message>>(`/api/v1/conversations/${enc(id)}/messages${query({ before, limit: 30 })}`),
  /** Long poll: resolves with messages after `after` (oldest first) or [] after `wait` seconds. */
  poll: (id: string, after: string, signal: AbortSignal) =>
    api<Page<Message>>(`/api/v1/conversations/${enc(id)}/messages${query({ after, wait: 8 })}`, {
      signal,
    }).then((r) => r.data),
  send: (id: string, body: string, clientId: string) =>
    one(
      api<{ data: Message }>(`/api/v1/conversations/${enc(id)}/messages`, {
        method: 'POST',
        body: { body, clientId },
      }),
    ),
  read: (id: string, upToMessageId: string) =>
    api(`/api/v1/conversations/${enc(id)}/read`, { method: 'POST', body: { upToMessageId } }),
  block: (userId: string) => api('/api/v1/me/blocked-users', { method: 'POST', body: { userId } }),
  blocked: (cursor?: string) =>
    api<Page<{ userId: string; blockedAt: string }>>(
      `/api/v1/me/blocked-users${query({ cursor, limit: 50 })}`,
    ),
  unblock: (userId: string) =>
    api<void>(`/api/v1/me/blocked-users/${enc(userId)}`, { method: 'DELETE' }),
};
