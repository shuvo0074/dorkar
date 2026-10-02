import { findContactInfo, type ConversationContext } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

/** What messaging knows about a conversation's subject (projected from the owning service). */
export interface ContextFacts {
  type: ConversationContext;
  id: string;
  /** Seller (LISTING, OFFER, TRANSACTION) or lender (LEND_ITEM). */
  ownerId: string;
  /** The fixed other party (buyer) for OFFER/TRANSACTION; null when anyone may inquire. */
  counterpartId: string | null;
  /** LISTING: on sale; LEND_ITEM: active. Always true for OFFER/TRANSACTION. */
  available: boolean;
}

/** Participants stored in a canonical order so the pair is unordered for uniqueness. */
export interface Pair {
  a: string;
  b: string;
}

export const orderPair = (x: string, y: string): Pair => (x < y ? { a: x, b: y } : { a: y, b: x });

export const otherOf = (pair: Pair, me: string): string => (pair.a === me ? pair.b : pair.a);

export const isParticipant = (pair: Pair, accountId: string): boolean =>
  pair.a === accountId || pair.b === accountId;

export type PairResolution =
  | { kind: 'OK'; pair: Pair }
  /** A legitimate pair whose subject no longer accepts new conversations. */
  | { kind: 'UNAVAILABLE'; pair: Pair }
  /** The owner of an open context has nobody to talk to. */
  | { kind: 'SELF' }
  /** Unknown context, or the caller is not a party to it. */
  | { kind: 'NOT_PARTY' };

/**
 * Participants are derived from the context, never chosen by the caller:
 *  - LISTING / LEND_ITEM: the caller (an inquirer) and the seller/lender;
 *  - OFFER / TRANSACTION: the buyer and the seller, and the caller must be one of them.
 */
export function resolvePair(ctx: ContextFacts | null, callerId: string): PairResolution {
  if (!ctx) return { kind: 'NOT_PARTY' };
  if (ctx.counterpartId === null) {
    if (callerId === ctx.ownerId) return { kind: 'SELF' };
    const pair = orderPair(callerId, ctx.ownerId);
    return ctx.available ? { kind: 'OK', pair } : { kind: 'UNAVAILABLE', pair };
  }
  if (callerId !== ctx.ownerId && callerId !== ctx.counterpartId) return { kind: 'NOT_PARTY' };
  if (ctx.ownerId === ctx.counterpartId) return { kind: 'SELF' };
  const pair = orderPair(ctx.ownerId, ctx.counterpartId);
  return ctx.available ? { kind: 'OK', pair } : { kind: 'UNAVAILABLE', pair };
}

export const BODY_MAX = 2000;
export const MEDIA_MAX = 4;
export const PREVIEW_LENGTH = 120;

/** Dorkar promises phone numbers stay private: no phone numbers or emails in messages. */
export function assertNoContactInfo(body: string): void {
  const kind = findContactInfo(body);
  if (kind) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      kind === 'PHONE'
        ? 'Phone numbers cannot be shared in messages. Keep talking on Dorkar.'
        : 'Email addresses cannot be shared in messages. Keep talking on Dorkar.',
      { rule: 'CONTACT_INFO_NOT_ALLOWED', kind },
    );
  }
}

/** Generic on purpose: never reveals which side blocked the other. */
export const blockedError = () =>
  new AppError('FORBIDDEN', 'You cannot send messages in this conversation.');

export function assertNotSelfBlock(blockerId: string, blockedId: string): void {
  if (blockerId === blockedId) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'You cannot block yourself.', {
      rule: 'CANNOT_BLOCK_SELF',
    });
  }
}

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  clientId: string;
  body: string;
  mediaIds: string[];
  hidden: boolean;
  createdAt: Date;
}

/** What participants see: a message hidden by moderation keeps its place but loses its content. */
export interface VisibleMessage {
  id: string;
  conversationId: string;
  senderId: string;
  clientId: string;
  body: string | null;
  mediaIds: string[];
  removed: boolean;
  createdAt: Date;
}

export const visible = (m: Message): VisibleMessage => ({
  id: m.id,
  conversationId: m.conversationId,
  senderId: m.senderId,
  clientId: m.clientId,
  body: m.hidden ? null : m.body,
  mediaIds: m.hidden ? [] : m.mediaIds,
  removed: m.hidden,
  createdAt: m.createdAt,
});

export function preview(m: Pick<Message, 'body' | 'hidden'>): string | null {
  if (m.hidden) return null;
  const flat = m.body.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}

export const dedupe = <T>(xs: readonly T[]): T[] => [...new Set(xs)];
