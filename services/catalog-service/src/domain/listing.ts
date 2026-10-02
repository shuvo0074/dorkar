import {
  findContactInfo,
  validateAttributes,
  type AttributeSchema,
  type AttributeValues,
  type Condition,
  type DeliveryMode,
  type District,
  type Money,
  type NeedMode,
} from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

export const ListingKinds = ['PRODUCT', 'SERVICE', 'RENTAL'] as const;
export type ListingKind = (typeof ListingKinds)[number];

export const PriceUnits = ['TOTAL', 'PER_UNIT', 'PER_HOUR', 'PER_DAY'] as const;
export type PriceUnit = (typeof PriceUnits)[number];

export const ListingStatuses = [
  'DRAFT',
  'PUBLISHED',
  'PAUSED',
  'SOLD_OUT',
  'WITHDRAWN',
  'HIDDEN',
] as const;
export type ListingStatus = (typeof ListingStatuses)[number];

/** States a moderator can hide from, and therefore the states a restore returns to. */
export const HideableStatuses = ['PUBLISHED', 'PAUSED', 'SOLD_OUT'] as const;
export type HideableStatus = (typeof HideableStatuses)[number];

/** States in which the owner may still edit content. */
export const EditableStatuses: readonly ListingStatus[] = ['DRAFT', 'PUBLISHED', 'PAUSED'];

export interface ListingContent {
  categoryId: string;
  kind: ListingKind;
  condition: Condition | null;
  title: string;
  description: string;
  price: Money;
  priceUnit: PriceUnit;
  quantityAvailable: number;
  attributes: AttributeValues;
  district: District;
  area: string | null;
  deliveryModes: DeliveryMode[];
  mediaIds: string[];
}

export interface Listing extends ListingContent {
  id: string;
  sellerId: string;
  status: ListingStatus;
  /** While HIDDEN: the state a restore returns to. */
  hiddenFrom: HideableStatus | null;
  /**
   * SOLD_OUT (or HIDDEN from SOLD_OUT) only because deals reserved the last unit, not by the
   * owner: releasing stock makes it available again.
   */
  stockSoldOut: boolean;
  hiddenReason: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

// ------------------------------------------------------------------ state machine

export const ListingActions = [
  'publish',
  'pause',
  'resume',
  'markSoldOut',
  'withdraw',
  'hide',
  'restore',
  'sellOut',
  'restock',
] as const;
export type ListingAction = (typeof ListingActions)[number];

/** System actions driven by stock reservations, never exposed to owners or moderators. */
export const StockActions = ['sellOut', 'restock'] as const;
export type StockAction = (typeof StockActions)[number];

/** Owner actions; `hide`/`restore` belong to moderators. */
export const OwnerActions = ['publish', 'pause', 'resume', 'markSoldOut', 'withdraw'] as const;
export type OwnerAction = (typeof OwnerActions)[number];

const RULES: Record<
  Exclude<ListingAction, 'restore' | 'restock'>,
  { from: readonly ListingStatus[]; to: ListingStatus }
> = {
  publish: { from: ['DRAFT'], to: 'PUBLISHED' },
  pause: { from: ['PUBLISHED'], to: 'PAUSED' },
  resume: { from: ['PAUSED'], to: 'PUBLISHED' },
  markSoldOut: { from: ['PUBLISHED', 'PAUSED'], to: 'SOLD_OUT' },
  // WITHDRAWN is the only terminal state.
  withdraw: { from: ['DRAFT', 'PUBLISHED', 'PAUSED', 'SOLD_OUT', 'HIDDEN'], to: 'WITHDRAWN' },
  hide: { from: HideableStatuses, to: 'HIDDEN' },
  // Stock reached zero on a live listing.
  sellOut: { from: ['PUBLISHED'], to: 'SOLD_OUT' },
};

export interface Transition {
  from: ListingStatus;
  to: ListingStatus;
  /** Set when entering HIDDEN, cleared otherwise. */
  hiddenFrom: HideableStatus | null;
  /** Whether the resulting state is a stock-driven sell-out (kept across hide/restore). */
  stockSoldOut: boolean;
}

type StateFacts = Pick<Listing, 'status' | 'hiddenFrom'> & { stockSoldOut?: boolean };

export function canTransition(l: StateFacts, action: ListingAction): boolean {
  if (action === 'restore') return l.status === 'HIDDEN' && l.hiddenFrom !== null;
  // Only a sell-out caused by reservations is undone by released stock.
  if (action === 'restock') return l.status === 'SOLD_OUT' && !!l.stockSoldOut;
  return RULES[action].from.includes(l.status);
}

/** The next state for `action`, or 409 INVALID_STATE_TRANSITION. */
export function transition(l: StateFacts, action: ListingAction): Transition {
  if (!canTransition(l, action)) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      `A ${l.status.toLowerCase().replace('_', ' ')} listing cannot ${action === 'markSoldOut' ? 'be marked sold out' : action}.`,
      { from: l.status, action },
    );
  }
  const keep = !!l.stockSoldOut;
  if (action === 'restore') {
    return { from: l.status, to: l.hiddenFrom!, hiddenFrom: null, stockSoldOut: keep };
  }
  if (action === 'restock') {
    return { from: l.status, to: 'PUBLISHED', hiddenFrom: null, stockSoldOut: false };
  }
  const to = RULES[action].to;
  return {
    from: l.status,
    to,
    hiddenFrom: to === 'HIDDEN' ? (l.status as HideableStatus) : null,
    stockSoldOut: action === 'sellOut' || (action === 'hide' && keep),
  };
}

// ------------------------------------------------------------------ stock reservations

export const ReservationStatuses = ['ACTIVE', 'RELEASED', 'CONSUMED'] as const;
export type ReservationStatus = (typeof ReservationStatuses)[number];

export interface StockReservation {
  transactionId: string;
  listingId: string;
  requestedQuantity: number;
  /** Units actually taken; below `requestedQuantity` (even 0) when stock ran out. */
  quantity: number;
  status: ReservationStatus;
}

/** Transaction states that give reserved stock back, and the one that uses it up. */
export const RELEASING_STATES = ['CANCELLED', 'EXPIRED', 'REFUNDED'] as const;
export const CONSUMING_STATE = 'COMPLETED';

/**
 * What a stock change does to a listing. The quantity changes first; then at most one status
 * transition, or (for HIDDEN listings) a silent change of the state a restore returns to.
 */
export interface StockPlan {
  quantity: number;
  action: StockAction | null;
  /** New `hiddenFrom` for a HIDDEN listing; undefined leaves it. */
  hiddenFrom?: HideableStatus;
  stockSoldOut: boolean;
  /** A live listing's quantity changed without a transition: emit ListingUpdated. */
  announce: boolean;
}

type StockFacts = Pick<Listing, 'status' | 'hiddenFrom' | 'stockSoldOut' | 'quantityAvailable'>;

/** Only products bought outright consume stock; rentals and services never do. */
export const consumesStock = (kind: ListingKind, mode: NeedMode) =>
  kind === 'PRODUCT' && mode === 'BUY';

/** Reserve up to `requested` units: whatever is left, possibly none. */
export function planReserve(
  l: StockFacts,
  requested: number,
): { reserved: number; plan: StockPlan } {
  const available = Math.max(l.quantityAvailable, 0);
  const reserved = Math.min(Math.max(requested, 0), available);
  const quantity = available - reserved;
  const plan: StockPlan = {
    quantity,
    action: null,
    stockSoldOut: l.stockSoldOut,
    announce: false,
  };
  if (reserved === 0) return { reserved, plan };
  if (l.status === 'PUBLISHED') {
    if (quantity === 0) plan.action = 'sellOut';
    else plan.announce = true;
  } else if (l.status === 'HIDDEN' && l.hiddenFrom === 'PUBLISHED' && quantity === 0) {
    // Restoring it later must not put a listing with no stock back on sale.
    plan.hiddenFrom = 'SOLD_OUT';
    plan.stockSoldOut = true;
  }
  return { reserved, plan };
}

/**
 * Give `units` back. A stock-driven sell-out becomes available again; withdrawn, paused,
 * owner-sold-out and hidden listings keep their state.
 */
export function planRelease(l: StockFacts, units: number): StockPlan {
  const plan: StockPlan = {
    quantity: Math.max(l.quantityAvailable, 0) + Math.max(units, 0),
    action: null,
    stockSoldOut: l.stockSoldOut,
    announce: false,
  };
  if (units <= 0) return { ...plan, quantity: l.quantityAvailable };
  if (l.status === 'SOLD_OUT' && l.stockSoldOut) plan.action = 'restock';
  else if (l.status === 'PUBLISHED') plan.announce = true;
  else if (l.status === 'HIDDEN' && l.hiddenFrom === 'SOLD_OUT' && l.stockSoldOut) {
    plan.hiddenFrom = 'PUBLISHED';
    plan.stockSoldOut = false;
  }
  return plan;
}

export type AvailabilityEffect =
  | { kind: 'AVAILABLE' }
  | { kind: 'UNAVAILABLE'; reason: 'WITHDRAWN' | 'PAUSED' | 'SOLD_OUT' | 'HIDDEN' }
  | { kind: 'NONE' };

/**
 * What consumers (matching, demand) must learn from a transition: it became available
 * (ListingPublished) or stopped being offered (ListingUnavailable). Drafts were never offered.
 */
export function availabilityEffect(t: Pick<Transition, 'from' | 'to'>): AvailabilityEffect {
  if (t.to === 'PUBLISHED') return { kind: 'AVAILABLE' };
  if (t.from === 'DRAFT') return { kind: 'NONE' };
  switch (t.to) {
    case 'PAUSED':
    case 'SOLD_OUT':
    case 'WITHDRAWN':
    case 'HIDDEN':
      return { kind: 'UNAVAILABLE', reason: t.to };
    default:
      return { kind: 'NONE' };
  }
}

// ------------------------------------------------------------------ content and publish rules

/** The need mode a listing serves: products are bought, rentals rented, services hired. */
const KIND_MODE: Readonly<Record<ListingKind, NeedMode>> = {
  PRODUCT: 'BUY',
  RENTAL: 'RENT',
  SERVICE: 'HIRE',
};
export const modeForKind = (kind: ListingKind): NeedMode => KIND_MODE[kind];

const violation = (rule: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError('BUSINESS_RULE_VIOLATION', message, { rule, ...details });

/** Public text must not leak contact details (phone numbers stay private on Dorkar). */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw violation(
      'NO_CONTACT_INFO',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from the ${field}. Buyers contact you through Dorkar.`,
      { field },
    );
  }
}

/** Rules that hold for any listing, draft or not. */
export function assertContentRules(c: ListingContent): void {
  assertNoContactInfo('title', c.title);
  assertNoContactInfo('description', c.description);
  assertNoContactInfo('area', c.area);
  if (c.kind === 'SERVICE' && c.condition !== null) {
    throw violation('CONDITION_NOT_APPLICABLE', 'Services have no condition.');
  }
}

export interface CategoryFacts {
  active: boolean;
  modes: readonly NeedMode[];
  attributeSchema: AttributeSchema;
}

export function assertCategoryAccepts(category: CategoryFacts, kind: ListingKind): void {
  if (!category.active) throw violation('CATEGORY_INACTIVE', 'This category is not available.');
  const mode = modeForKind(kind);
  if (!category.modes.includes(mode)) {
    throw violation(
      'CATEGORY_MODE_NOT_ALLOWED',
      `This category does not accept ${kind.toLowerCase()} listings.`,
      {
        mode,
        allowedModes: category.modes,
      },
    );
  }
}

/** Drafts may be incomplete, but what is there must be well-formed (unknown keys rejected). */
export function validateDraftAttributes(schema: AttributeSchema, input: unknown): AttributeValues {
  const r = validateAttributes(schema, input, { partial: true });
  if (!r.ok) {
    throw new AppError('VALIDATION_FAILED', 'Some attributes are invalid.', {
      in: 'body.attributes',
      issues: r.issues,
    });
  }
  return r.value;
}

/** Everything a listing needs before buyers can see it. Throws the first broken rule. */
export function assertPublishable(c: ListingContent, category: CategoryFacts): void {
  assertCategoryAccepts(category, c.kind);
  assertContentRules(c);
  if (c.price.amount <= 0) throw violation('PRICE_REQUIRED', 'Set a price above zero.');
  if (c.quantityAvailable < 1)
    throw violation('QUANTITY_REQUIRED', 'Set at least one available unit.');
  const r = validateAttributes(category.attributeSchema, c.attributes);
  if (!r.ok) {
    throw violation('INVALID_ATTRIBUTES', 'Complete the required details for this category.', {
      issues: r.issues,
    });
  }
}
