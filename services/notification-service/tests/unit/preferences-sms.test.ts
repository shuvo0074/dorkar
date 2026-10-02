import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  channelsFor,
  defaultPreference,
  effectivePreferences,
  isDefaultPreference,
  NotificationTypes,
  type ChannelPreference,
  type Notification,
  type NotificationType,
} from '../../src/domain/notification';
import { afterFailure, formatTaka, renderSms, retryDelayMs } from '../../src/domain/sms';

describe('preferences', () => {
  it('defaults: in-app on for all; SMS only for offer received/accepted and new deals', () => {
    const smsOn = NotificationTypes.filter((t) => defaultPreference(t).sms);
    expect(smsOn.sort()).toEqual(['OFFER_ACCEPTED', 'OFFER_RECEIVED', 'TRANSACTION_CREATED']);
    expect(NotificationTypes.every((t) => defaultPreference(t).inApp)).toBe(true);
  });

  it('overrides win; every type is always present', () => {
    const overrides = new Map<NotificationType, ChannelPreference>([
      ['OFFER_RECEIVED', { inApp: true, sms: false }],
      ['REVIEW_RECEIVED', { inApp: false, sms: true }],
    ]);
    const eff = effectivePreferences(overrides);
    expect(eff.map((p) => p.type)).toEqual([...NotificationTypes]);
    expect(eff.find((p) => p.type === 'OFFER_RECEIVED')).toEqual({
      type: 'OFFER_RECEIVED',
      inApp: true,
      sms: false,
    });
    expect(eff.find((p) => p.type === 'REVIEW_RECEIVED')).toMatchObject({
      inApp: false,
      sms: true,
    });
    expect(eff.find((p) => p.type === 'OFFER_ACCEPTED')).toMatchObject({ inApp: true, sms: true });
  });

  it('knows when a setting equals the default (so it need not be stored)', () => {
    expect(isDefaultPreference('OFFER_RECEIVED', { inApp: true, sms: true })).toBe(true);
    expect(isDefaultPreference('NEED_MATCHED', { inApp: true, sms: true })).toBe(false);
  });

  it('maps preferences to out-of-band channels', () => {
    expect(channelsFor({ inApp: true, sms: true })).toEqual(['SMS']);
    expect(channelsFor({ inApp: true, sms: false })).toEqual([]);
  });
});

const PHONE = /(\+?880|\b0)1[3-9]\d{8}|[০-৯]{6,}/;

const n = (type: NotificationType, payload: Notification['payload'] = {}): Notification => ({
  id: randomUUID(),
  recipientId: randomUUID(),
  type,
  payload,
  readAt: null,
  createdAt: new Date(),
});

describe('SMS text', () => {
  it('formats taka with South Asian grouping', () => {
    expect(formatTaka({ amount: 125_000_00, currency: 'BDT' })).toBe('৳1,25,000');
    expect(formatTaka({ amount: 99_950, currency: 'BDT' })).toBe('৳999.50');
  });

  it('renders every type with a short own-domain link and no phone numbers', () => {
    const price = { amount: 1_200_00, currency: 'BDT' as const };
    for (const type of NotificationTypes) {
      const note = n(type, { price, amount: price, to: 'DELIVERY_PENDING', status: 'VERIFIED' });
      const text = renderSms(note, 'https://dorkar.com.bd/');
      expect(text).toMatch(/^Dorkar: /);
      expect(text.endsWith(` dorkar.com.bd/n/${note.id}`)).toBe(true);
      expect(text).not.toMatch(PHONE);
      expect(text).not.toMatch(/https?:/);
      expect(text.length).toBeLessThan(160);
    }
  });

  it('includes the amount and a readable state', () => {
    const price = { amount: 1_200_00, currency: 'BDT' as const };
    expect(renderSms(n('OFFER_RECEIVED', { price }), 'https://dorkar.com.bd')).toContain('৳1,200');
    expect(
      renderSms(n('TRANSACTION_UPDATED', { to: 'DELIVERY_PENDING' }), 'https://x.bd'),
    ).toContain('now delivery pending');
  });

  it('ignores anything in the payload that is not a known fact (no names or numbers leak)', () => {
    const text = renderSms(
      n('OFFER_ACCEPTED', { buyerName: 'Rahim', phone: '01712345678' }),
      'https://dorkar.com.bd',
    );
    expect(text).not.toContain('Rahim');
    expect(text).not.toMatch(PHONE);
  });
});

describe('SMS retry policy', () => {
  it('backs off exponentially and caps at an hour', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(retryDelayMs(20)).toBe(60 * 60_000);
  });

  it('fails permanently after the last attempt', () => {
    expect(afterFailure(1, 5)).toEqual({ status: 'PENDING', retryInMs: 30_000 });
    expect(afterFailure(4, 5)).toMatchObject({ status: 'PENDING' });
    expect(afterFailure(5, 5)).toEqual({ status: 'FAILED' });
  });
});
