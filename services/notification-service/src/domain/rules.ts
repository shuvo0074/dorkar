import {
  DemandEvents,
  MatchingEvents,
  OfferEvents,
  ReputationEvents,
  TransactionEvents,
  VerificationEvents,
} from '@dorkar/contracts';
import type { EventDefinition } from '@dorkar/kernel';
import type { z } from 'zod';
import type { NotificationIntent } from './notification';

/** One consumed event and who it notifies, about what. Pure: no I/O, no clock. */
export interface NotificationRule {
  readonly def: EventDefinition<z.ZodType>;
  /** Receives the payload already validated against `def.schema`. */
  map(payload: unknown): NotificationIntent[];
}

const rule = <S extends z.ZodType>(
  def: EventDefinition<S>,
  map: (p: z.output<S>) => NotificationIntent[],
): NotificationRule => ({ def, map: (p) => map(p as z.output<S>) });

export const notificationRules: readonly NotificationRule[] = [
  rule(MatchingEvents.MatchFound, (p) => [
    {
      recipientId: p.sellerId,
      type: 'NEED_MATCHED',
      payload: { needId: p.needId, matchId: p.matchId },
    },
  ]),

  rule(OfferEvents.OfferSubmitted, (p) => [
    {
      recipientId: p.buyerId,
      type: 'OFFER_RECEIVED',
      payload: { offerId: p.offerId, needId: p.needId, price: p.price },
    },
  ]),

  rule(OfferEvents.OfferCountered, (p) => [
    {
      // The counter goes to whoever did not make it.
      recipientId: p.by === 'BUYER' ? p.sellerId : p.buyerId,
      type: 'OFFER_COUNTERED',
      payload: {
        offerId: p.offerId,
        needId: p.needId,
        by: p.by,
        round: p.round,
        price: p.price,
      },
    },
  ]),

  rule(OfferEvents.OfferAccepted, (p) => [
    {
      recipientId: p.sellerId,
      type: 'OFFER_ACCEPTED',
      payload: { offerId: p.offerId, needId: p.needId, price: p.price },
    },
  ]),

  rule(OfferEvents.OfferStatusChanged, (p) => {
    if (p.to === 'REJECTED') {
      return [
        {
          recipientId: p.sellerId,
          type: 'OFFER_REJECTED',
          payload: { offerId: p.offerId, needId: p.needId },
        },
      ];
    }
    // The need went away (closed, expired, fulfilled elsewhere): tell the seller their offer is moot.
    if (p.to === 'EXPIRED' && p.reason.startsWith('NEED_')) {
      return [
        {
          recipientId: p.sellerId,
          type: 'OFFER_CLOSED',
          payload: { offerId: p.offerId, needId: p.needId, reason: p.reason },
        },
      ];
    }
    return [];
  }),

  rule(TransactionEvents.TransactionCreated, (p) =>
    (['BUYER', 'SELLER'] as const).map((role) => ({
      recipientId: role === 'BUYER' ? p.buyerId : p.sellerId,
      type: 'TRANSACTION_CREATED' as const,
      payload: { transactionId: p.transactionId, amount: p.amount, mode: p.mode, role },
    })),
  ),

  rule(TransactionEvents.TransactionStateChanged, (p) =>
    [p.buyerId, p.sellerId]
      .filter((id) => id !== p.actorId) // the actor already knows
      .map((recipientId) => ({
        recipientId,
        type: 'TRANSACTION_UPDATED' as const,
        payload: { transactionId: p.transactionId, from: p.from, to: p.to },
      })),
  ),

  rule(DemandEvents.NeedStatusChanged, (p) => {
    if (p.to === 'EXPIRED') {
      return [{ recipientId: p.requesterId, type: 'NEED_EXPIRED', payload: { needId: p.needId } }];
    }
    if (p.to === 'FULFILLING') {
      return [
        { recipientId: p.requesterId, type: 'NEED_FULFILLING', payload: { needId: p.needId } },
      ];
    }
    return [];
  }),

  rule(ReputationEvents.ReviewCreated, (p) => [
    {
      recipientId: p.subjectId,
      type: 'REVIEW_RECEIVED',
      payload: { reviewId: p.reviewId, transactionId: p.transactionId, rating: p.rating },
    },
  ]),

  rule(VerificationEvents.VerificationStatusChanged, (p) =>
    p.kind === 'NID' && (p.status === 'VERIFIED' || p.status === 'REJECTED')
      ? [
          {
            recipientId: p.accountId,
            type: 'VERIFICATION_UPDATED',
            payload: { kind: p.kind, status: p.status },
          },
        ]
      : [],
  ),
];

/** Typed entry point (tests, replays): the intents an event produces. */
export function notificationsFor<S extends z.ZodType>(
  def: EventDefinition<S>,
  payload: z.input<S>,
): NotificationIntent[] {
  const r = notificationRules.find((x) => x.def.type === def.type);
  return r ? r.map(def.schema.parse(payload)) : [];
}
