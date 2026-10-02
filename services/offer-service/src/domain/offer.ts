import {
  findContactInfo,
  OfferStatuses,
  type Condition,
  type DeliveryMode,
  type Money,
  type NeedMode,
  type NeedStatus,
  type OfferStatus,
} from '@dorkar/contracts';
import { AppError, Errors } from '@dorkar/kernel';
import { z } from 'zod';

// ---------------------------------------------------------------- entities

export type Party = 'BUYER' | 'SELLER';
export const OfferActions = ['ACCEPT', 'COUNTER', 'REJECT', 'WITHDRAW'] as const;
export type OfferAction = (typeof OfferActions)[number];

export const LIVE_STATUSES = [
  'SUBMITTED',
  'COUNTERED_BY_BUYER',
  'COUNTERED_BY_SELLER',
] as const satisfies readonly OfferStatus[];
export type LiveStatus = (typeof LIVE_STATUSES)[number];
export const isLive = (s: OfferStatus): s is LiveStatus =>
  (LIVE_STATUSES as readonly OfferStatus[]).includes(s);

export interface DeliveryTerms {
  method: DeliveryMode;
  feeAmount?: number | undefined;
  etaDays?: number | undefined;
}

export type ModeTerms = Record<string, unknown>;

/** Everything a proposal fixes beyond price and quantity; frozen into OfferAccepted. */
export interface OfferTerms {
  delivery: DeliveryTerms;
  mode: ModeTerms;
  condition: Condition | null;
  availabilityFrom: string | null;
}

export interface Offer {
  id: string;
  needId: string;
  buyerId: string;
  sellerId: string;
  listingId: string | null;
  status: OfferStatus;
  price: Money;
  quantity: number;
  condition: Condition | null;
  /** ISO date (YYYY-MM-DD). */
  availabilityFrom: string | null;
  deliveryTerms: DeliveryTerms;
  modeTerms: ModeTerms;
  description: string | null;
  attachmentMediaIds: string[];
  expiresAt: Date;
  currentRound: number;
  awaiting: Party;
  hidden: boolean;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface OfferRound {
  offerId: string;
  round: number;
  proposedBy: Party;
  price: Money;
  quantity: number;
  terms: OfferTerms;
  message: string | null;
  createdAt: Date;
}

export interface NeedSnapshot {
  needId: string;
  requesterId: string;
  mode: NeedMode;
  categoryId: string;
  title: string;
  quantity: number;
  maxOffers: number;
  expiresAt: Date;
  status: NeedStatus;
  acceptedQuantity: number;
}

export interface ListingSnapshot {
  listingId: string;
  sellerId: string;
  available: boolean;
}

export interface NegotiationSettings {
  maxRounds: number;
}

// ---------------------------------------------------------------- text rules

/** Offer text is shown to the other party: no phone numbers or emails (they talk through Dorkar). */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from your ${field}. You can talk through Dorkar.`,
      { rule: 'NO_CONTACT_INFO', field },
    );
  }
}

// ---------------------------------------------------------------- negotiation state machine

export const partyOf = (o: Pick<Offer, 'buyerId' | 'sellerId'>, actorId: string): Party | null =>
  actorId === o.buyerId ? 'BUYER' : actorId === o.sellerId ? 'SELLER' : null;

export const otherParty = (p: Party): Party => (p === 'BUYER' ? 'SELLER' : 'BUYER');

/** Who may perform each action on a live offer. */
const WHO: Readonly<Record<OfferAction, Party | 'AWAITED'>> = {
  ACCEPT: 'AWAITED',
  COUNTER: 'AWAITED',
  REJECT: 'BUYER',
  WITHDRAW: 'SELLER',
};

export type NegotiationView = Pick<
  Offer,
  'status' | 'awaiting' | 'currentRound' | 'expiresAt' | 'hidden'
>;

/**
 * Why `party` may not perform `action` now, or null when it may. The single source of truth for
 * both enforcement (`assertCanAct`) and the `actions` the API advertises (`availableActions`).
 */
export function refusal(
  o: NegotiationView,
  party: Party,
  action: OfferAction,
  now: Date,
  s: NegotiationSettings,
): AppError | null {
  if (!isLive(o.status)) {
    return new AppError(
      'INVALID_STATE_TRANSITION',
      `This offer is ${o.status.toLowerCase().replace(/_/g, ' ')}.`,
      { from: o.status, action },
    );
  }
  if (o.expiresAt.getTime() <= now.getTime()) {
    return new AppError('INVALID_STATE_TRANSITION', 'This offer has expired.', {
      from: o.status,
      action,
      reason: 'OFFER_EXPIRED',
    });
  }
  const who = WHO[action];
  if (who === 'AWAITED') {
    if (o.awaiting !== party) {
      return new AppError(
        'INVALID_STATE_TRANSITION',
        `It is the ${o.awaiting.toLowerCase()}'s turn to respond.`,
        { from: o.status, action, reason: 'NOT_YOUR_TURN', awaiting: o.awaiting },
      );
    }
  } else if (who !== party) {
    return Errors.forbidden(
      action === 'REJECT' ? 'Only the buyer can reject an offer.' : 'Only the seller can withdraw.',
    );
  }
  if (o.hidden && (action === 'ACCEPT' || action === 'COUNTER')) {
    return new AppError(
      'BUSINESS_RULE_VIOLATION',
      'This offer is under review and cannot be negotiated.',
      { rule: 'OFFER_HIDDEN' },
    );
  }
  if (action === 'COUNTER' && o.currentRound >= s.maxRounds) {
    return new AppError(
      'BUSINESS_RULE_VIOLATION',
      `Negotiation is limited to ${s.maxRounds} rounds. Accept or decline the latest terms.`,
      { rule: 'MAX_ROUNDS', maxRounds: s.maxRounds },
    );
  }
  return null;
}

export function assertCanAct(
  o: NegotiationView,
  party: Party,
  action: OfferAction,
  now: Date,
  s: NegotiationSettings,
): void {
  const err = refusal(o, party, action, now, s);
  if (err) throw err;
}

/** What the caller may do with this offer right now (the UI renders exactly these buttons). */
export function availableActions(
  o: NegotiationView,
  party: Party | null,
  now: Date,
  s: NegotiationSettings,
): OfferAction[] {
  if (!party) return [];
  return OfferActions.filter((a) => refusal(o, party, a, now, s) === null);
}

/** Status after a party's action on a live offer. */
export function nextStatus(action: OfferAction, by: Party): OfferStatus {
  switch (action) {
    case 'ACCEPT':
      return 'ACCEPTED';
    case 'REJECT':
      return 'REJECTED';
    case 'WITHDRAW':
      return 'WITHDRAWN';
    case 'COUNTER':
      return by === 'BUYER' ? 'COUNTERED_BY_BUYER' : 'COUNTERED_BY_SELLER';
  }
}

/** System transitions (no party): expiry of live offers, cancellation of accepted ones. */
export const SystemTransitions = {
  EXPIRE: { from: LIVE_STATUSES as readonly OfferStatus[], to: 'EXPIRED' as OfferStatus },
  CANCEL: { from: ['ACCEPTED'] as readonly OfferStatus[], to: 'CANCELLED' as OfferStatus },
} as const;

/** Every (status, party, action) combination on a fresh, unexpired offer — for tests and docs. */
export const transitionTable = (s: NegotiationSettings, now = new Date()) =>
  OfferStatuses.flatMap((status) =>
    (['BUYER', 'SELLER'] as const).flatMap((awaiting) =>
      (['BUYER', 'SELLER'] as const).flatMap((party) =>
        OfferActions.map((action) => ({
          status,
          awaiting,
          party,
          action,
          allowed:
            refusal(
              {
                status,
                awaiting,
                currentRound: 1,
                expiresAt: new Date(now.getTime() + 3_600_000),
                hidden: false,
              },
              party,
              action,
              now,
              s,
            ) === null,
        })),
      ),
    ),
  );

// ---------------------------------------------------------------- submission rules

export interface SubmitFacts {
  need: NeedSnapshot;
  sellerId: string;
  /** DB clock. */
  now: Date;
  quantity: number;
  /** Live + accepted offers already on the need. */
  activeOfferCount: number;
  sellerHasLiveOffer: boolean;
  listingId: string | null;
  listing: ListingSnapshot | null;
}

const rule = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new AppError('BUSINESS_RULE_VIOLATION', message, { rule: code, ...extra });

/** The need-level part of the submission rules (checked again under the lock). */
export function assertNeedTakesOffersFrom(need: NeedSnapshot, sellerId: string, now: Date): void {
  if (need.status !== 'OPEN') {
    throw rule('NEED_NOT_OPEN', 'This need is not accepting offers.', { needStatus: need.status });
  }
  if (need.expiresAt.getTime() <= now.getTime()) {
    throw rule('NEED_EXPIRED', 'This need has expired.');
  }
  if (need.requesterId === sellerId) {
    throw rule('OWN_NEED', 'You cannot make an offer on your own need.');
  }
}

/** Throws the first rule a new offer would break. */
export function assertCanSubmit(f: SubmitFacts): void {
  const { need } = f;
  assertNeedTakesOffersFrom(need, f.sellerId, f.now);
  if (f.sellerHasLiveOffer) {
    throw new AppError(
      'CONFLICT',
      'You already have an offer on this need. Update it by negotiating, or withdraw it first.',
      { rule: 'DUPLICATE_OFFER' },
    );
  }
  if (f.activeOfferCount >= need.maxOffers) {
    throw rule('OFFER_LIMIT', 'This need has received the maximum number of offers.', {
      maxOffers: need.maxOffers,
    });
  }
  assertQuantityAvailable(need, f.quantity);
  if (f.listingId) {
    if (!f.listing || f.listing.sellerId !== f.sellerId) {
      throw rule('LISTING_NOT_OWNED', 'You can only attach your own listings.');
    }
    if (!f.listing.available) {
      throw rule('LISTING_UNAVAILABLE', 'That listing is not available.');
    }
  }
}

export function assertQuantityAvailable(need: NeedSnapshot, quantity: number): void {
  const remaining = need.quantity - need.acceptedQuantity;
  if (quantity > remaining) {
    throw rule('QUANTITY_EXCEEDS_NEED', `The buyer needs at most ${remaining} more.`, {
      remaining,
    });
  }
}

/** Exclusive acceptance guard, evaluated under the need row lock. */
export function assertAcceptable(need: NeedSnapshot, quantity: number): void {
  if (need.acceptedQuantity + quantity > need.quantity) {
    throw new AppError(
      'NEED_QUANTITY_EXHAUSTED',
      'This need has already been fulfilled by another offer.',
      {
        rule: 'NEED_QUANTITY_EXHAUSTED',
        remaining: Math.max(0, need.quantity - need.acceptedQuantity),
      },
    );
  }
  if (need.status !== 'OPEN') {
    throw new AppError('INVALID_STATE_TRANSITION', 'This need is no longer open.', {
      reason: 'NEED_NOT_OPEN',
      needStatus: need.status,
    });
  }
}

/**
 * Full accept check under the need lock. An offer that lost the race was expired (NEED_FULFILLED)
 * by the winner in the same critical section; its caller is told the need is exhausted rather
 * than that the offer expired.
 */
export function assertCanAccept(
  offer: NegotiationView & Pick<Offer, 'quantity'>,
  party: Party,
  need: NeedSnapshot,
  now: Date,
  s: NegotiationSettings,
): void {
  const refused = refusal(offer, party, 'ACCEPT', now, s);
  if (refused) {
    if (offer.status === 'EXPIRED') assertAcceptable(need, offer.quantity);
    throw refused;
  }
  assertAcceptable(need, offer.quantity);
}

/** Need statuses that end every live offer on it. */
export const NEED_TERMINATING_STATUSES: readonly NeedStatus[] = [
  'CLOSED',
  'EXPIRED',
  'HIDDEN',
  'FULFILLED',
];

/** Offer lifetime: requested (or default) hours, capped by policy and by the need's own expiry. */
export function offerExpiry(
  now: Date,
  requestedHours: number | undefined,
  policy: { defaultTtlHours: number; maxTtlDays: number },
  needExpiresAt: Date,
): Date {
  const hours = requestedHours ?? policy.defaultTtlHours;
  if (hours > policy.maxTtlDays * 24) {
    throw Errors.validation(`An offer can stay open for at most ${policy.maxTtlDays} days.`, {
      field: 'expiresInHours',
    });
  }
  const ms = Math.min(now.getTime() + hours * 3_600_000, needExpiresAt.getTime());
  return new Date(ms);
}

// ---------------------------------------------------------------- mode terms

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const amount = z.number().int().min(0).max(100_000_000_000);

export const ModeTermsSchemas = {
  BUY: z.strictObject({ warrantyMonths: z.number().int().min(0).max(120).optional() }),
  RENT: z
    .strictObject({ startAt: isoDateTime, endAt: isoDateTime, depositAmount: amount.optional() })
    .refine((t) => new Date(t.endAt).getTime() > new Date(t.startAt).getTime(), {
      message: 'endAt must be after startAt',
      path: ['endAt'],
    }),
  BORROW: z.strictObject({ returnBy: isoDate, depositAmount: amount.optional() }),
  HIRE: z.strictObject({
    serviceDate: isoDate,
    durationHours: z.number().positive().max(720).optional(),
    scope: z.string().trim().min(3).max(1000),
  }),
  SOURCE: z.strictObject({
    leadTimeDays: z.number().int().min(0).max(365),
    sampleAvailable: z.boolean().optional(),
    specificationsConfirmed: z.boolean().optional(),
  }),
} satisfies Record<NeedMode, z.ZodType>;

/** Validates mode-specific terms against the need's mode (the HTTP layer cannot know it). */
export function parseModeTerms(mode: NeedMode, raw: unknown): ModeTerms {
  const r = ModeTermsSchemas[mode].safeParse(raw ?? {});
  if (!r.success) {
    throw Errors.validation(`These terms do not fit a ${mode} need.`, {
      field: 'modeTerms',
      mode,
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  const terms = r.data as ModeTerms;
  if (mode === 'HIRE') assertNoContactInfo('service scope', terms['scope'] as string);
  return terms;
}

/** The frozen agreement emitted with OfferAccepted. */
export const finalTerms = (round: Pick<OfferRound, 'terms'>): Record<string, unknown> => ({
  delivery: round.terms.delivery,
  mode: round.terms.mode,
  condition: round.terms.condition,
  availabilityFrom: round.terms.availabilityFrom,
});
