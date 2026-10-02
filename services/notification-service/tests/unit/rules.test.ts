import { randomUUID } from 'node:crypto';
import {
  DemandEvents,
  MatchingEvents,
  NeedStatuses,
  OfferEvents,
  OfferStatuses,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
  VerificationKinds,
  VerificationStatuses,
} from '@dorkar/contracts';
import { describe, expect, it } from 'vitest';
import { notificationRules, notificationsFor } from '../../src/domain/rules';

const buyer = randomUUID();
const seller = randomUUID();
const offerId = randomUUID();
const needId = randomUUID();
const price = { amount: 125_000, currency: 'BDT' as const };
const offer = { offerId, needId, buyerId: buyer, sellerId: seller };
const tx = {
  transactionId: randomUUID(),
  needId,
  sourceType: 'OFFER' as const,
  sourceId: offerId,
  buyerId: buyer,
  sellerId: seller,
};

const who = (xs: { recipientId: string; type: string }[]) =>
  xs.map(
    (x) =>
      `${x.recipientId === buyer ? 'buyer' : x.recipientId === seller ? 'seller' : x.recipientId}:${x.type}`,
  );

describe('event → notification rules', () => {
  it('registers one rule per consumed event, each from another producer', () => {
    const types = notificationRules.map((r) => r.def.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types).toHaveLength(10);
    expect(types.every((t) => !t.startsWith('notification.'))).toBe(true);
  });

  it('MatchFound → seller NEED_MATCHED with ids only', () => {
    const matchId = randomUUID();
    const out = notificationsFor(MatchingEvents.MatchFound, {
      matchId,
      needId,
      requesterId: buyer,
      sellerId: seller,
      listingId: null,
      score: 0.8,
    });
    expect(out).toEqual([
      { recipientId: seller, type: 'NEED_MATCHED', payload: { needId, matchId } },
    ]);
  });

  it('OfferSubmitted → buyer OFFER_RECEIVED with price', () => {
    const out = notificationsFor(OfferEvents.OfferSubmitted, { ...offer, price, quantity: 1 });
    expect(out).toEqual([
      { recipientId: buyer, type: 'OFFER_RECEIVED', payload: { offerId, needId, price } },
    ]);
  });

  it('OfferCountered → the other party', () => {
    const base = { ...offer, round: 2, price, quantity: 1 };
    expect(who(notificationsFor(OfferEvents.OfferCountered, { ...base, by: 'BUYER' }))).toEqual([
      'seller:OFFER_COUNTERED',
    ]);
    expect(who(notificationsFor(OfferEvents.OfferCountered, { ...base, by: 'SELLER' }))).toEqual([
      'buyer:OFFER_COUNTERED',
    ]);
  });

  it('OfferAccepted → seller', () => {
    const out = notificationsFor(OfferEvents.OfferAccepted, {
      ...offer,
      listingId: null,
      mode: 'BUY',
      price,
      quantity: 1,
      terms: { address: 'House 1, Road 2' },
    });
    expect(who(out)).toEqual(['seller:OFFER_ACCEPTED']);
    expect(JSON.stringify(out)).not.toContain('House'); // terms never copied
  });

  it('OfferStatusChanged: REJECTED → seller; EXPIRED by need → OFFER_CLOSED; others → nothing', () => {
    const table = OfferStatuses.flatMap((to) =>
      ['NEED_CLOSED', 'TIMEOUT'].map((reason) => ({
        to,
        reason,
        out: who(
          notificationsFor(OfferEvents.OfferStatusChanged, {
            ...offer,
            from: 'SUBMITTED',
            to,
            reason,
          }),
        ),
      })),
    );
    for (const { to, reason, out } of table) {
      const expected =
        to === 'REJECTED'
          ? ['seller:OFFER_REJECTED']
          : to === 'EXPIRED' && reason === 'NEED_CLOSED'
            ? ['seller:OFFER_CLOSED']
            : [];
      expect(out, `${to}/${reason}`).toEqual(expected);
    }
  });

  it('TransactionCreated → buyer and seller, each told their role', () => {
    const out = notificationsFor(TransactionEvents.TransactionCreated, {
      ...tx,
      amount: price,
      quantity: 1,
      mode: 'BUY',
    });
    expect(who(out)).toEqual(['buyer:TRANSACTION_CREATED', 'seller:TRANSACTION_CREATED']);
    expect(out.map((o) => o.payload['role'])).toEqual(['BUYER', 'SELLER']);
  });

  it('TransactionStateChanged → both parties except the actor', () => {
    const base = { ...tx, from: 'CREATED' as const, to: 'CONFIRMED' as const };
    const of = (actorId: string | null) =>
      who(notificationsFor(TransactionEvents.TransactionStateChanged, { ...base, actorId }));
    expect(of(seller)).toEqual(['buyer:TRANSACTION_UPDATED']);
    expect(of(buyer)).toEqual(['seller:TRANSACTION_UPDATED']);
    expect(of(null)).toEqual(['buyer:TRANSACTION_UPDATED', 'seller:TRANSACTION_UPDATED']);
    const [n] = notificationsFor(TransactionEvents.TransactionStateChanged, {
      ...base,
      actorId: null,
    });
    expect(n?.payload).toEqual({
      transactionId: tx.transactionId,
      from: 'CREATED',
      to: 'CONFIRMED',
    });
  });

  it('NeedStatusChanged: EXPIRED and FULFILLING notify the requester; others do not', () => {
    for (const to of NeedStatuses) {
      const out = who(
        notificationsFor(DemandEvents.NeedStatusChanged, {
          needId,
          requesterId: buyer,
          from: 'OPEN',
          to,
          reason: 'x',
        }),
      );
      expect(out, to).toEqual(
        to === 'EXPIRED'
          ? ['buyer:NEED_EXPIRED']
          : to === 'FULFILLING'
            ? ['buyer:NEED_FULFILLING']
            : [],
      );
    }
  });

  it('ReviewCreated → subject, not author', () => {
    const out = notificationsFor(ReputationEvents.ReviewCreated, {
      reviewId: randomUUID(),
      transactionId: tx.transactionId,
      authorId: buyer,
      subjectId: seller,
      rating: 5,
    });
    expect(who(out)).toEqual(['seller:REVIEW_RECEIVED']);
  });

  it('VerificationStatusChanged: only NID decisions', () => {
    for (const kind of VerificationKinds) {
      for (const status of VerificationStatuses) {
        const out = who(
          notificationsFor(VerificationEvents.VerificationStatusChanged, {
            accountId: buyer,
            kind,
            status,
          }),
        );
        const notify = kind === 'NID' && (status === 'VERIFIED' || status === 'REJECTED');
        expect(out, `${kind}/${status}`).toEqual(notify ? ['buyer:VERIFICATION_UPDATED'] : []);
      }
    }
  });

  it('payloads hold only ids and plain facts (no free text beyond enums/reasons)', () => {
    const out = notificationsFor(OfferEvents.OfferSubmitted, { ...offer, price, quantity: 3 });
    expect(Object.keys(out[0]!.payload).sort()).toEqual(['needId', 'offerId', 'price']);
  });
});
