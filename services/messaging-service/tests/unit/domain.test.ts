import { randomUUID } from 'node:crypto';
import type { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  assertNoContactInfo,
  assertNotSelfBlock,
  isParticipant,
  orderPair,
  otherOf,
  preview,
  resolvePair,
  visible,
  type ContextFacts,
  type Message,
} from '../../src/domain/conversation';

const seller = randomUUID();
const buyer = randomUUID();
const outsider = randomUUID();

const open = (type: 'LISTING' | 'LEND_ITEM', available = true): ContextFacts => ({
  type,
  id: randomUUID(),
  ownerId: seller,
  counterpartId: null,
  available,
});
const deal = (type: 'OFFER' | 'TRANSACTION'): ContextFacts => ({
  type,
  id: randomUUID(),
  ownerId: seller,
  counterpartId: buyer,
  available: true,
});

describe('participant derivation', () => {
  it.each(['LISTING', 'LEND_ITEM'] as const)('%s: any inquirer talks to the owner', (type) => {
    expect(resolvePair(open(type), buyer)).toEqual({ kind: 'OK', pair: orderPair(buyer, seller) });
    expect(resolvePair(open(type), outsider)).toEqual({
      kind: 'OK',
      pair: orderPair(outsider, seller),
    });
  });

  it.each(['LISTING', 'LEND_ITEM'] as const)(
    '%s: the owner cannot open one with themselves',
    (type) => {
      expect(resolvePair(open(type), seller)).toEqual({ kind: 'SELF' });
    },
  );

  it.each(['LISTING', 'LEND_ITEM'] as const)(
    '%s: unavailable subjects take no new inquiries',
    (type) => {
      expect(resolvePair(open(type, false), buyer).kind).toBe('UNAVAILABLE');
    },
  );

  it.each(['OFFER', 'TRANSACTION'] as const)(
    '%s: buyer and seller only, from either side',
    (type) => {
      const ctx = deal(type);
      const pair = orderPair(buyer, seller);
      expect(resolvePair(ctx, buyer)).toEqual({ kind: 'OK', pair });
      expect(resolvePair(ctx, seller)).toEqual({ kind: 'OK', pair });
      expect(resolvePair(ctx, outsider)).toEqual({ kind: 'NOT_PARTY' });
    },
  );

  it('unknown contexts are not found', () => {
    expect(resolvePair(null, buyer)).toEqual({ kind: 'NOT_PARTY' });
  });

  it('pairs are unordered', () => {
    expect(orderPair(buyer, seller)).toEqual(orderPair(seller, buyer));
    const p = orderPair(buyer, seller);
    expect(p.a < p.b).toBe(true);
    expect(otherOf(p, buyer)).toBe(seller);
    expect(otherOf(p, seller)).toBe(buyer);
    expect(isParticipant(p, outsider)).toBe(false);
  });
});

describe('message rules', () => {
  const rule = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as AppError).details?.['rule'];
    }
    return null;
  };

  it.each([
    'call me 01712345678',
    'নম্বর ০১৭১২-৩৪৫৬৭৮',
    '+880 1712 345 678',
    'mail rahim@example.com',
  ])('rejects contact info: %s', (body) => {
    expect(rule(() => assertNoContactInfo(body))).toBe('CONTACT_INFO_NOT_ALLOWED');
  });

  it('allows ordinary text with numbers', () => {
    expect(rule(() => assertNoContactInfo('Is it 2 years old? Price 15000 ok?'))).toBeNull();
  });

  it('cannot block yourself', () => {
    expect(rule(() => assertNotSelfBlock(buyer, buyer))).toBe('CANNOT_BLOCK_SELF');
    expect(rule(() => assertNotSelfBlock(buyer, seller))).toBeNull();
  });

  const msg = (over: Partial<Message> = {}): Message => ({
    id: randomUUID(),
    conversationId: randomUUID(),
    seq: 1,
    senderId: buyer,
    clientId: randomUUID(),
    body: 'Hello there',
    mediaIds: [randomUUID()],
    hidden: false,
    createdAt: new Date(),
    ...over,
  });

  it('hidden messages lose their content but keep their slot', () => {
    const v = visible(msg({ hidden: true }));
    expect(v).toMatchObject({ body: null, mediaIds: [], removed: true });
    expect(visible(msg()).removed).toBe(false);
  });

  it('previews are single-line, truncated, and null when hidden', () => {
    expect(preview(msg({ body: 'a\n\nb' }))).toBe('a b');
    expect(preview(msg({ body: 'x'.repeat(500) }))!.length).toBe(120);
    expect(preview(msg({ hidden: true }))).toBeNull();
  });
});
