import {
  AuctionStatuses,
  type AuctionKind,
  type AuctionStatus,
  type BidStatuses,
  type District,
  type Money,
  type NeedMode,
  type NeedStatus,
} from '@dorkar/contracts';
import { AppError, Errors } from '@dorkar/kernel';

// ---------------------------------------------------------------- entities

export type BidStatus = (typeof BidStatuses)[number];
export type SubjectType = 'LISTING' | 'NEED';

export interface Auction {
  id: string;
  kind: AuctionKind;
  ownerId: string;
  subjectType: SubjectType;
  subjectId: string;
  categoryId: string;
  title: string;
  district: District;
  /** FORWARD: BUY. REVERSE: the need's mode (SOURCE or BUY). */
  mode: NeedMode;
  quantity: number;
  /** FORWARD: opening price. REVERSE: ceiling. Total for `quantity`. */
  startPrice: Money;
  /** Never revealed to bidders. */
  reservePrice: Money | null;
  minIncrement: Money;
  startsAt: Date;
  endsAt: Date;
  antiSnipeSeconds: number;
  status: AuctionStatus;
  leadingBidId: string | null;
  leadingAmount: Money | null;
  /** Non-retracted bids. */
  bidCount: number;
  hidden: boolean;
  cancelReason: string | null;
  closedAt: Date | null;
  transactionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface Bid {
  id: string;
  /** Global placement order (assigned under the auction lock). */
  seq: number;
  auctionId: string;
  bidderId: string;
  /** Stable per-auction alias number ("Bidder 3"). */
  alias: number;
  amount: Money;
  status: BidStatus;
  placedAt: Date;
  retractedAt: Date | null;
}

export interface ListingSnapshot {
  listingId: string;
  sellerId: string;
  categoryId: string;
  kind: 'PRODUCT' | 'SERVICE' | 'RENTAL';
  title: string;
  district: District;
  price: Money;
  quantityAvailable: number;
  available: boolean;
}

export interface NeedSnapshot {
  needId: string;
  requesterId: string;
  mode: NeedMode;
  categoryId: string;
  title: string;
  district: District;
  budgetMax: Money | null;
  quantity: number;
  status: NeedStatus;
}

export const LIVE_STATUSES = [
  'SCHEDULED',
  'OPEN',
  'CLOSING',
] as const satisfies readonly AuctionStatus[];
export const isLive = (s: AuctionStatus) => (LIVE_STATUSES as readonly AuctionStatus[]).includes(s);

/** Bids that still compete (may lead, be re-elected, win or lose). */
export const ACTIVE_BID_STATUSES = ['LEADING', 'OUTBID'] as const satisfies readonly BidStatus[];

/** Need statuses that end the need's live reverse auctions. */
export const NEED_GONE_STATUSES: readonly NeedStatus[] = ['CLOSED', 'EXPIRED', 'HIDDEN'];

const money = (amount: number): Money => ({ amount, currency: 'BDT' });

const rule = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  new AppError('BUSINESS_RULE_VIOLATION', message, { rule: code, ...extra });

// ---------------------------------------------------------------- auction state machine

export const AuctionCommands = [
  'OPEN',
  'CANCEL',
  'ADMIN_CANCEL',
  'SUBJECT_GONE',
  'BEGIN_CLOSE',
  'AWARD',
  'NO_WINNER',
  'SETTLE',
] as const;
export type AuctionCommand = (typeof AuctionCommands)[number];

export const AuctionActors = ['OWNER', 'ADMIN', 'SYSTEM'] as const;
export type AuctionActor = (typeof AuctionActors)[number];

/** What the guards look at. `now` is the database clock. */
export type AuctionFacts = Pick<
  Auction,
  | 'kind'
  | 'status'
  | 'startsAt'
  | 'endsAt'
  | 'bidCount'
  | 'leadingBidId'
  | 'leadingAmount'
  | 'reservePrice'
> & { now: Date };

type Guard = (f: AuctionFacts) => AppError | null;

interface TransitionRule {
  from: readonly AuctionStatus[];
  to: AuctionStatus;
  actors: readonly AuctionActor[];
  guards: readonly Guard[];
}

/** Whether the leading bid meets the (secret) reserve. No leading bid → false. */
export function reserveMet(a: Pick<Auction, 'kind' | 'reservePrice' | 'leadingAmount'>): boolean {
  if (!a.leadingAmount) return false;
  if (!a.reservePrice) return true;
  return a.kind === 'FORWARD'
    ? a.leadingAmount.amount >= a.reservePrice.amount
    : a.leadingAmount.amount <= a.reservePrice.amount;
}

const hasWinner = (f: AuctionFacts) => f.leadingBidId !== null && reserveMet(f);

export const AuctionGuards = {
  startReached: ((f) =>
    f.startsAt.getTime() <= f.now.getTime()
      ? null
      : new AppError('INVALID_STATE_TRANSITION', 'This auction has not started yet.', {
          reason: 'NOT_STARTED',
        })) satisfies Guard,
  endReached: ((f) =>
    f.endsAt.getTime() <= f.now.getTime()
      ? null
      : new AppError('INVALID_STATE_TRANSITION', 'This auction has not ended yet.', {
          reason: 'NOT_ENDED',
        })) satisfies Guard,
  /** SCHEDULED can always be cancelled (no bids are possible yet); OPEN only without bids. */
  noBids: ((f) =>
    f.status !== 'OPEN' || f.bidCount === 0
      ? null
      : rule('AUCTION_HAS_BIDS', 'An auction cannot be cancelled once bids have been placed.', {
          bidCount: f.bidCount,
        })) satisfies Guard,
  winnerExists: ((f) =>
    hasWinner(f)
      ? null
      : new AppError('INVALID_STATE_TRANSITION', 'No bid meets the reserve.', {
          reason: 'NO_QUALIFYING_BID',
        })) satisfies Guard,
  noWinner: ((f) =>
    hasWinner(f)
      ? new AppError('INVALID_STATE_TRANSITION', 'A bid meets the reserve.', {
          reason: 'HAS_QUALIFYING_BID',
        })
      : null) satisfies Guard,
} as const;

/**
 * The auction lifecycle as one declarative table (03-lifecycles §3). Nothing else decides an
 * auction's status. Bids keep the status OPEN and are validated by `bidRefusal`.
 */
export const AUCTION_TRANSITIONS: Readonly<Record<AuctionCommand, TransitionRule>> = {
  OPEN: {
    from: ['SCHEDULED'],
    to: 'OPEN',
    actors: ['SYSTEM'],
    guards: [AuctionGuards.startReached],
  },
  CANCEL: {
    from: ['SCHEDULED', 'OPEN'],
    to: 'CANCELLED',
    actors: ['OWNER'],
    guards: [AuctionGuards.noBids],
  },
  ADMIN_CANCEL: { from: LIVE_STATUSES, to: 'CANCELLED', actors: ['ADMIN'], guards: [] },
  SUBJECT_GONE: { from: LIVE_STATUSES, to: 'CANCELLED', actors: ['SYSTEM'], guards: [] },
  BEGIN_CLOSE: {
    from: ['OPEN'],
    to: 'CLOSING',
    actors: ['SYSTEM'],
    guards: [AuctionGuards.endReached],
  },
  AWARD: {
    from: ['CLOSING'],
    to: 'AWARDED',
    actors: ['SYSTEM'],
    guards: [AuctionGuards.winnerExists],
  },
  NO_WINNER: {
    from: ['CLOSING'],
    to: 'NO_WINNER',
    actors: ['SYSTEM'],
    guards: [AuctionGuards.noWinner],
  },
  SETTLE: { from: ['AWARDED'], to: 'SETTLED', actors: ['SYSTEM'], guards: [] },
};

export type Decision = { ok: true; to: AuctionStatus } | { ok: false; error: AppError };

/** The single source of truth for status changes: enforcement and advertised `actions`. */
export function decide(f: AuctionFacts, command: AuctionCommand, actor: AuctionActor): Decision {
  const t = AUCTION_TRANSITIONS[command];
  if (!t.actors.includes(actor)) {
    return { ok: false, error: Errors.forbidden('You cannot do that to this auction.') };
  }
  if (!t.from.includes(f.status)) {
    return {
      ok: false,
      error: new AppError(
        'INVALID_STATE_TRANSITION',
        `This auction is ${f.status.toLowerCase().replace(/_/g, ' ')}.`,
        { from: f.status, command },
      ),
    };
  }
  for (const g of t.guards) {
    const err = g(f);
    if (err) return { ok: false, error: err };
  }
  return { ok: true, to: t.to };
}

export function transition(f: AuctionFacts, command: AuctionCommand, actor: AuctionActor) {
  const d = decide(f, command, actor);
  if (!d.ok) throw d.error;
  return d.to;
}

/** Outcome of the close: CLOSING → AWARDED when a bid meets the reserve, else NO_WINNER. */
export const closeOutcome = (f: AuctionFacts): 'AWARD' | 'NO_WINNER' =>
  hasWinner(f) ? 'AWARD' : 'NO_WINNER';

/** Every (status, command, actor) cell with fixed facts — for tests and docs. */
export const transitionTable = (facts: Omit<AuctionFacts, 'status'>) =>
  AuctionStatuses.flatMap((status) =>
    AuctionCommands.flatMap((command) =>
      AuctionActors.map((actor) => {
        const d = decide({ ...facts, status }, command, actor);
        return { status, command, actor, to: d.ok ? d.to : null };
      }),
    ),
  );

// ---------------------------------------------------------------- bid rules

export interface BidFacts {
  auction: Pick<
    Auction,
    | 'kind'
    | 'ownerId'
    | 'status'
    | 'endsAt'
    | 'hidden'
    | 'startPrice'
    | 'minIncrement'
    | 'leadingAmount'
    | 'leadingBidId'
  >;
  /** Bidder of the current leading bid, if any. */
  leaderId: string | null;
  bidderId: string;
  amount: Money;
  /** DB clock, read after taking the auction lock. */
  now: Date;
}

/** The amount a valid next bid must reach: FORWARD at least `minimum`, REVERSE at most `maximum`. */
export function nextBidBound(
  a: Pick<Auction, 'kind' | 'startPrice' | 'minIncrement' | 'leadingAmount'>,
): { minimum: Money; maximum: null } | { minimum: Money; maximum: Money } {
  if (a.kind === 'FORWARD') {
    const min = a.leadingAmount
      ? a.leadingAmount.amount + a.minIncrement.amount
      : a.startPrice.amount;
    return { minimum: money(min), maximum: null };
  }
  const max = a.leadingAmount
    ? a.leadingAmount.amount - a.minIncrement.amount
    : a.startPrice.amount;
  return { minimum: money(1), maximum: money(max) };
}

/** Whether bidding is possible at all right now (status, clock, visibility). */
export function biddingRefusal(
  a: Pick<Auction, 'status' | 'endsAt' | 'hidden'>,
  now: Date,
): AppError | null {
  if (a.hidden) {
    return rule('AUCTION_HIDDEN', 'This auction is under review and does not accept bids.');
  }
  if (a.status !== 'OPEN') {
    return new AppError(
      'INVALID_STATE_TRANSITION',
      a.status === 'SCHEDULED'
        ? 'This auction has not opened yet.'
        : `This auction is ${a.status.toLowerCase().replace(/_/g, ' ')}.`,
      { from: a.status, reason: 'AUCTION_NOT_OPEN' },
    );
  }
  if (now.getTime() >= a.endsAt.getTime()) {
    return new AppError('INVALID_STATE_TRANSITION', 'This auction has ended.', {
      from: a.status,
      reason: 'AUCTION_ENDED',
    });
  }
  return null;
}

/** Why this bid may not be placed, or null. Evaluated under the auction row lock. */
export function bidRefusal(f: BidFacts): AppError | null {
  const { auction: a } = f;
  const closed = biddingRefusal(a, f.now);
  if (closed) return closed;
  if (f.bidderId === a.ownerId) {
    return rule('OWN_AUCTION', 'You cannot bid on your own auction.');
  }
  if (f.leaderId === f.bidderId) {
    return rule('ALREADY_LEADING', 'You already have the leading bid.');
  }
  const bound = nextBidBound(a);
  if (a.kind === 'FORWARD') {
    if (f.amount.amount < bound.minimum.amount) {
      return rule(
        'BID_TOO_LOW',
        a.leadingAmount
          ? 'Your bid must beat the leading bid by at least the minimum increment.'
          : 'Your bid must be at least the opening price.',
        { minimum: bound.minimum },
      );
    }
    return null;
  }
  const maximum = bound.maximum!;
  if (f.amount.amount > maximum.amount) {
    return rule(
      'BID_TOO_HIGH',
      a.leadingAmount
        ? 'Your bid must undercut the leading bid by at least the minimum increment.'
        : 'Your bid must not exceed the ceiling price.',
      { maximum },
    );
  }
  if (f.amount.amount <= 0) {
    return rule('BID_TOO_LOW', 'A bid must be more than zero.', { minimum: money(1) });
  }
  return null;
}

export function assertBidAcceptable(f: BidFacts): void {
  const err = bidRefusal(f);
  if (err) throw err;
}

/** Anti-sniping: a bid in the last `antiSnipeSeconds` pushes the end to now + antiSnipeSeconds. */
export function extendedEndsAt(endsAt: Date, now: Date, antiSnipeSeconds: number): Date {
  if (antiSnipeSeconds <= 0) return endsAt;
  const window = antiSnipeSeconds * 1000;
  return now.getTime() > endsAt.getTime() - window ? new Date(now.getTime() + window) : endsAt;
}

/** The better of two amounts for this kind (higher forward, lower reverse). */
export const beats = (kind: AuctionKind, a: number, b: number) =>
  kind === 'FORWARD' ? a > b : a < b;

// ---------------------------------------------------------------- retraction

/** A retraction must leave at least this long before the end. */
export const RETRACT_MIN_REMAINING_MS = 10 * 60_000;

export function retractRefusal(f: {
  auction: Pick<Auction, 'status' | 'endsAt'>;
  bid: Pick<Bid, 'status' | 'placedAt'>;
  now: Date;
  windowSeconds: number;
}): AppError | null {
  if (f.bid.status !== 'LEADING' && f.bid.status !== 'OUTBID') {
    return new AppError(
      'INVALID_STATE_TRANSITION',
      `This bid is ${f.bid.status.toLowerCase()} and cannot be retracted.`,
      { from: f.bid.status, reason: 'BID_NOT_ACTIVE' },
    );
  }
  if (f.auction.status !== 'OPEN') {
    return new AppError('INVALID_STATE_TRANSITION', 'This auction is no longer open.', {
      from: f.auction.status,
      reason: 'AUCTION_NOT_OPEN',
    });
  }
  if (f.now.getTime() - f.bid.placedAt.getTime() > f.windowSeconds * 1000) {
    return rule(
      'RETRACT_WINDOW_CLOSED',
      `A bid can only be retracted within ${f.windowSeconds} seconds of placing it.`,
      { windowSeconds: f.windowSeconds },
    );
  }
  if (f.auction.endsAt.getTime() - f.now.getTime() <= RETRACT_MIN_REMAINING_MS) {
    return rule(
      'TOO_CLOSE_TO_END',
      'Bids cannot be retracted in the last 10 minutes of an auction.',
    );
  }
  return null;
}

// ---------------------------------------------------------------- creation

export interface CreateAuctionInput {
  kind: AuctionKind;
  subjectId: string;
  quantity?: number | undefined;
  startPrice?: Money | undefined;
  reservePrice?: Money | null | undefined;
  minIncrement: Money;
  startsAt?: Date | undefined;
  endsAt: Date;
  antiSnipeSeconds?: number | undefined;
}

export interface CreationSettings {
  defaultAntiSnipeSeconds: number;
  maxDurationDays: number;
}

export type AuctionDraft = Pick<
  Auction,
  | 'kind'
  | 'subjectType'
  | 'subjectId'
  | 'categoryId'
  | 'title'
  | 'district'
  | 'mode'
  | 'quantity'
  | 'startPrice'
  | 'reservePrice'
  | 'minIncrement'
  | 'startsAt'
  | 'endsAt'
  | 'antiSnipeSeconds'
>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const MAX_SCHEDULE_AHEAD_MS = 7 * DAY;
/** Tolerated client clock skew for `startsAt` in the past (treated as "now"). */
export const START_SKEW_MS = 5 * 60_000;

/**
 * Validates a new auction against its subject and returns the stored shape. Throws the first
 * rule broken. Subject facts come from this service's projections.
 */
export function draftAuction(
  ownerId: string,
  input: CreateAuctionInput,
  subject: { listing: ListingSnapshot | null; need: NeedSnapshot | null },
  now: Date,
  s: CreationSettings,
): AuctionDraft {
  let base: Pick<
    AuctionDraft,
    'subjectType' | 'categoryId' | 'title' | 'district' | 'mode' | 'quantity' | 'startPrice'
  >;

  if (input.kind === 'FORWARD') {
    const l = subject.listing;
    if (!l) throw Errors.notFound('Listing');
    if (l.sellerId !== ownerId) {
      throw rule('NOT_YOUR_LISTING', 'You can only auction your own listings.');
    }
    if (l.kind !== 'PRODUCT') {
      throw rule('LISTING_NOT_AUCTIONABLE', 'Only product listings can be auctioned.', {
        listingKind: l.kind,
      });
    }
    if (!l.available || l.quantityAvailable < 1) {
      throw rule('LISTING_UNAVAILABLE', 'That listing is not available.');
    }
    const quantity = input.quantity ?? 1;
    if (quantity > l.quantityAvailable) {
      throw rule('QUANTITY_EXCEEDS_STOCK', `Only ${l.quantityAvailable} in stock.`, {
        available: l.quantityAvailable,
      });
    }
    if (!input.startPrice) {
      throw Errors.validation('An opening price is required.', { field: 'startPrice' });
    }
    base = {
      subjectType: 'LISTING',
      categoryId: l.categoryId,
      title: l.title,
      district: l.district,
      mode: 'BUY',
      quantity,
      startPrice: input.startPrice,
    };
  } else {
    const n = subject.need;
    if (!n) throw Errors.notFound('Need');
    if (n.requesterId !== ownerId) {
      throw rule('NOT_YOUR_NEED', 'You can only run a sourcing auction on your own need.');
    }
    if (n.status !== 'OPEN') {
      throw rule('NEED_NOT_OPEN', 'Only an open need can be auctioned.', { needStatus: n.status });
    }
    if (n.mode !== 'SOURCE' && n.mode !== 'BUY') {
      throw rule('NEED_MODE_NOT_AUCTIONABLE', 'Only buying and sourcing needs can be auctioned.', {
        mode: n.mode,
      });
    }
    if (input.quantity !== undefined && input.quantity !== n.quantity) {
      throw rule(
        'QUANTITY_FIXED_BY_NEED',
        `The auction is for the need's quantity (${n.quantity}).`,
        {
          quantity: n.quantity,
        },
      );
    }
    const startPrice = input.startPrice ?? n.budgetMax;
    if (!startPrice) {
      throw rule('CEILING_REQUIRED', 'Set a ceiling price: the need has no maximum budget.');
    }
    base = {
      subjectType: 'NEED',
      categoryId: n.categoryId,
      title: n.title,
      district: n.district,
      mode: n.mode,
      quantity: n.quantity,
      startPrice,
    };
  }

  if (base.startPrice.amount < 1) {
    throw Errors.validation('The starting price must be more than zero.', { field: 'startPrice' });
  }
  const reservePrice = input.reservePrice ?? null;
  if (reservePrice) {
    if (input.kind === 'FORWARD' && reservePrice.amount < base.startPrice.amount) {
      throw rule('RESERVE_BELOW_START', 'The reserve cannot be below the opening price.');
    }
    if (input.kind === 'REVERSE' && reservePrice.amount > base.startPrice.amount) {
      throw rule('RESERVE_ABOVE_CEILING', 'The reserve cannot be above the ceiling price.');
    }
  }
  if (input.kind === 'REVERSE' && input.minIncrement.amount >= base.startPrice.amount) {
    throw rule('INCREMENT_TOO_LARGE', 'The minimum decrement must be below the ceiling price.');
  }

  // Schedule (DB clock).
  const requested = input.startsAt ?? now;
  if (requested.getTime() < now.getTime() - START_SKEW_MS) {
    throw Errors.validation('The start time is in the past.', { field: 'startsAt' });
  }
  const startsAt = requested.getTime() < now.getTime() ? now : requested;
  if (startsAt.getTime() > now.getTime() + MAX_SCHEDULE_AHEAD_MS) {
    throw Errors.validation('An auction can be scheduled at most 7 days ahead.', {
      field: 'startsAt',
    });
  }
  const duration = input.endsAt.getTime() - startsAt.getTime();
  if (duration < HOUR) {
    throw Errors.validation('An auction must run for at least one hour.', { field: 'endsAt' });
  }
  if (duration > s.maxDurationDays * DAY) {
    throw Errors.validation(`An auction can run for at most ${s.maxDurationDays} days.`, {
      field: 'endsAt',
    });
  }
  const antiSnipeSeconds = input.antiSnipeSeconds ?? s.defaultAntiSnipeSeconds;
  if (antiSnipeSeconds < 0 || antiSnipeSeconds > 600) {
    throw Errors.validation('Anti-sniping must be between 0 and 600 seconds.', {
      field: 'antiSnipeSeconds',
    });
  }

  return {
    ...base,
    kind: input.kind,
    subjectId: input.subjectId,
    reservePrice,
    minIncrement: input.minIncrement,
    startsAt,
    endsAt: input.endsAt,
    antiSnipeSeconds,
  };
}

// ---------------------------------------------------------------- caller view

export const AuctionActions = ['BID', 'CANCEL', 'ADMIN_CANCEL', 'RETRACT_BID'] as const;
export type AuctionAction = (typeof AuctionActions)[number];

/** Moderators and admins see hidden auctions. */
export interface Viewer {
  id: string | null;
  isStaff: boolean;
  canManage: boolean;
  canBid: boolean;
}

export const canSee = (a: Pick<Auction, 'hidden' | 'ownerId'>, v: Viewer) =>
  !a.hidden || v.isStaff || (v.id !== null && v.id === a.ownerId);

/** What the caller may do now; the UI renders exactly these. */
export function availableActions(
  a: Auction,
  v: Viewer,
  ctx: {
    now: Date;
    leaderId: string | null;
    myRetractable: Pick<Bid, 'status' | 'placedAt'> | null;
    retractWindowSeconds: number;
  },
): AuctionAction[] {
  const out: AuctionAction[] = [];
  const facts: AuctionFacts = { ...a, now: ctx.now };
  if (
    v.id &&
    v.canBid &&
    v.id !== a.ownerId &&
    v.id !== ctx.leaderId &&
    biddingRefusal(a, ctx.now) === null
  ) {
    out.push('BID');
  }
  if (v.id === a.ownerId && decide(facts, 'CANCEL', 'OWNER').ok) out.push('CANCEL');
  if (v.canManage && decide(facts, 'ADMIN_CANCEL', 'ADMIN').ok) out.push('ADMIN_CANCEL');
  if (
    ctx.myRetractable &&
    retractRefusal({
      auction: a,
      bid: ctx.myRetractable,
      now: ctx.now,
      windowSeconds: ctx.retractWindowSeconds,
    }) === null
  ) {
    out.push('RETRACT_BID');
  }
  return out;
}

export const bidderAlias = (n: number) => `Bidder ${n}`;
