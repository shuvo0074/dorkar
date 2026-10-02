import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NotificationTypes, type Notification } from '../../src/domain/notification';
import { pushThrottleKey, renderPush } from '../../src/domain/push';

const PHONE = /(\+?880|\b0)1[3-9]\d{8}|[০-৯]{6,}/;
const money = { amount: 1_234_500, currency: 'BDT' as const };

const n = (type: Notification['type'], payload: Notification['payload'] = {}): Notification => ({
  id: randomUUID(),
  recipientId: randomUUID(),
  type,
  payload,
  readAt: null,
  createdAt: new Date(),
});

describe('push rendering', () => {
  it('every type has a short title/body, its type and an in-app path; no amounts or numbers', () => {
    const id = randomUUID();
    const payload = {
      needId: id,
      offerId: id,
      transactionId: id,
      auctionId: id,
      bookingId: id,
      loanId: id,
      disputeId: id,
      conversationId: id,
      price: money,
      amount: money,
      leadingAmount: money,
      to: 'HANDED_OVER',
      phone: '01712345678',
      note: 'free text',
    };
    for (const type of NotificationTypes) {
      const note = n(type, payload);
      const m = renderPush(note);
      expect(m.type).toBe(type);
      expect(m.notificationId).toBe(note.id);
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.title.length).toBeLessThanOrEqual(40);
      expect(m.body.length).toBeLessThanOrEqual(120);
      expect(m.path).toMatch(/^\/[a-z/-]+(\/[0-9a-f-]{36})?$/);
      const text = `${m.title} ${m.body}`;
      expect(text, type).not.toMatch(PHONE);
      expect(text, type).not.toContain('৳');
      expect(text, type).not.toContain('12,345');
      expect(text, type).not.toContain('free text');
    }
  });

  it('deep-links to the subject, falling back to the inbox for missing or malformed ids', () => {
    const auctionId = randomUUID();
    expect(renderPush(n('BID_PLACED', { auctionId })).path).toBe(`/auctions/${auctionId}`);
    expect(renderPush(n('NEW_MESSAGE', { conversationId: auctionId })).path).toBe(
      `/messages/${auctionId}`,
    );
    expect(renderPush(n('BID_PLACED', { auctionId: '../admin' })).path).toBe('/notifications');
    expect(renderPush(n('LOAN_OVERDUE')).path).toBe('/notifications');
  });

  it('words role-specific notifications for the role', () => {
    expect(renderPush(n('DISPUTE_OPENED', { role: 'RESPONDENT' })).body).toContain('respond');
    expect(renderPush(n('DISPUTE_OPENED', { role: 'OPENER' })).body).not.toContain('respond');
    expect(renderPush(n('TRANSACTION_UPDATED', { to: 'RETURNED' })).title).toBe('Item returned');
    expect(renderPush(n('NEW_MESSAGE', { count: 3 })).body).toBe('You have 3 new messages.');
  });

  it('throttles only bursty types, per recipient and conversation', () => {
    const conversationId = randomUUID();
    const msg = n('NEW_MESSAGE', { conversationId });
    expect(pushThrottleKey(msg)).toBe(`push-throttle:${msg.recipientId}:${conversationId}`);
    expect(pushThrottleKey(n('BID_PLACED', { conversationId }))).toBeNull();
  });
});
