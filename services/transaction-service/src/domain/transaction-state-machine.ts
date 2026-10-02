import type { DisputeReason, NeedMode, TransactionState } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import {
  DELIVERY_MODES,
  PRE_AGREED_SOURCES,
  RETURN_MODES,
  type SourceType,
  type TransactionPolicy,
} from './transaction';

/**
 * The transaction lifecycle as one declarative table: (from, command) → to, who may run it,
 * which deal modes it applies to, and the guards that must pass. Nothing else decides a
 * transaction's state. The table knows nothing about payment or delivery providers; those react
 * to the outcome in the application.
 *
 * BUY/HIRE/SOURCE deals are delivered (CONFIRMED → DELIVERY_PENDING → DELIVERED → COMPLETED);
 * RENT/BORROW deals are handed over and come back (CONFIRMED → HANDED_OVER → RETURN_REPORTED →
 * RETURNED → COMPLETED). Everything else (confirmation, cancellation, disputes, resolution) is
 * shared.
 */

export const TransactionCommands = [
  'confirm',
  'auto-confirm',
  'cancel',
  'expire',
  'arrange-delivery',
  'mark-delivered',
  'confirm-receipt',
  'hand-over',
  'report-return',
  'confirm-return',
  'complete',
  'auto-complete',
  'dispute',
  'resolve-release',
  'resolve-cancel',
  'resolve-refund',
  'withdraw-dispute',
] as const;
export type TransactionCommand = (typeof TransactionCommands)[number];

export const ActorRoles = ['BUYER', 'SELLER', 'ADMIN', 'SYSTEM'] as const;
export type ActorRole = (typeof ActorRoles)[number];

/** Everything the guards look at. `now` is the database clock. */
export interface TransitionFacts {
  state: TransactionState;
  mode: NeedMode;
  sourceType: SourceType;
  buyerConfirmedAt: Date | null;
  sellerConfirmedAt: Date | null;
  createdAt: Date;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  preDisputeState: TransactionState | null;
  /** Whether the payment provider can move money back (never for cash). */
  refundable: boolean;
  now: Date;
  policy: TransactionPolicy;
}

export interface GuardFailure {
  code: 'INVALID_STATE_TRANSITION' | 'BUSINESS_RULE_VIOLATION';
  rule: string;
  message: string;
}

export type Guard = (f: TransitionFacts, role: ActorRole) => GuardFailure | null;

export interface TransitionRule {
  from: TransactionState;
  command: TransactionCommand;
  /** Target state; a function when the outcome depends on the facts (two-party confirmation). */
  to: TransactionState | ((f: TransitionFacts, role: ActorRole) => TransactionState);
  actors: readonly ActorRole[];
  /** Deal modes the rule applies to; every mode when absent. */
  modes?: readonly NeedMode[];
  guards: readonly Guard[];
}

// ---------------------------------------------------------------- guards (pure)

const ms = (d: Date) => d.getTime();

export const Guards = {
  notYetConfirmedByActor: ((f, role) => {
    const at =
      role === 'BUYER' ? f.buyerConfirmedAt : role === 'SELLER' ? f.sellerConfirmedAt : null;
    return at
      ? {
          code: 'INVALID_STATE_TRANSITION',
          rule: 'ALREADY_CONFIRMED',
          message: 'You have already confirmed this transaction.',
        }
      : null;
  }) satisfies Guard,

  withinConfirmTtl: ((f) =>
    ms(f.now) < ms(f.createdAt) + f.policy.confirmTtlMs
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'CONFIRMATION_WINDOW_CLOSED',
          message: 'The time to confirm this transaction has passed.',
        }) satisfies Guard,

  confirmTtlElapsed: ((f) =>
    ms(f.now) >= ms(f.createdAt) + f.policy.confirmTtlMs
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'CONFIRMATION_WINDOW_OPEN',
          message: 'The confirmation window is still open.',
        }) satisfies Guard,

  /** Bookings and loans were agreed by both parties in their own service. */
  preAgreedSource: ((f) =>
    PRE_AGREED_SOURCES.includes(f.sourceType)
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'CONFIRMATION_REQUIRED',
          message: 'Both parties must confirm this transaction.',
        }) satisfies Guard,

  withinDisputeWindow: ((f) =>
    f.deliveredAt === null || ms(f.now) <= ms(f.deliveredAt) + f.policy.disputeWindowMs
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'DISPUTE_WINDOW_CLOSED',
          message: 'The time to raise a dispute for this delivery has passed.',
        }) satisfies Guard,

  completionWindowElapsed: ((f) =>
    f.deliveredAt !== null && ms(f.now) >= ms(f.deliveredAt) + f.policy.autoCompleteMs
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'COMPLETION_WINDOW_OPEN',
          message: 'The buyer can still confirm receipt or dispute.',
        }) satisfies Guard,

  /** The owner/lender may claim damage only for a while after confirming the return. */
  withinDamageClaimWindow: ((f) =>
    f.returnedAt !== null && ms(f.now) <= ms(f.returnedAt) + f.policy.returnCompleteMs
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'DAMAGE_CLAIM_WINDOW_CLOSED',
          message: 'The time to raise a damage claim for this return has passed.',
        }) satisfies Guard,

  returnWindowElapsed: ((f) =>
    f.returnedAt !== null && ms(f.now) >= ms(f.returnedAt) + f.policy.returnCompleteMs
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'COMPLETION_WINDOW_OPEN',
          message: 'The owner can still raise a damage claim.',
        }) satisfies Guard,

  refundable: ((f) =>
    f.refundable
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'REFUND_NOT_SUPPORTED',
          message: 'This payment method cannot be refunded through Dorkar.',
        }) satisfies Guard,

  hasPreDisputeState: ((f) =>
    f.preDisputeState !== null && f.preDisputeState !== 'DISPUTED'
      ? null
      : {
          code: 'INVALID_STATE_TRANSITION',
          rule: 'NO_PRE_DISPUTE_STATE',
          message: 'The state before the dispute is unknown.',
        }) satisfies Guard,
};

/** Both parties must confirm; the first confirmation keeps the transaction CREATED. */
const afterConfirmation = (f: TransitionFacts, role: ActorRole): TransactionState => {
  const other = role === 'BUYER' ? f.sellerConfirmedAt : f.buyerConfirmedAt;
  return other ? 'CONFIRMED' : 'CREATED';
};

/** A withdrawn dispute puts the deal back where it was. */
const beforeDispute = (f: TransitionFacts): TransactionState => f.preDisputeState!;

const PARTIES = ['BUYER', 'SELLER'] as const;
const DELIVERY = DELIVERY_MODES;
const RETURN = RETURN_MODES;

// ---------------------------------------------------------------- the table

export const TRANSITIONS: readonly TransitionRule[] = [
  // ---- agreement (every mode)
  {
    from: 'CREATED',
    command: 'confirm',
    to: afterConfirmation,
    actors: PARTIES,
    guards: [Guards.notYetConfirmedByActor, Guards.withinConfirmTtl],
  },
  {
    from: 'CREATED',
    command: 'auto-confirm',
    to: 'CONFIRMED',
    actors: ['SYSTEM'],
    guards: [Guards.preAgreedSource],
  },
  { from: 'CREATED', command: 'cancel', to: 'CANCELLED', actors: PARTIES, guards: [] },
  { from: 'CONFIRMED', command: 'cancel', to: 'CANCELLED', actors: PARTIES, guards: [] },
  {
    from: 'CREATED',
    command: 'expire',
    to: 'EXPIRED',
    actors: ['SYSTEM'],
    guards: [Guards.confirmTtlElapsed],
  },

  // ---- delivery (BUY / HIRE / SOURCE)
  {
    from: 'CONFIRMED',
    command: 'arrange-delivery',
    to: 'DELIVERY_PENDING',
    actors: PARTIES,
    modes: DELIVERY,
    guards: [],
  },
  {
    from: 'DELIVERY_PENDING',
    command: 'mark-delivered',
    to: 'DELIVERED',
    actors: ['SELLER'],
    modes: DELIVERY,
    guards: [],
  },
  {
    from: 'DELIVERED',
    command: 'confirm-receipt',
    to: 'COMPLETED',
    actors: ['BUYER'],
    modes: DELIVERY,
    guards: [],
  },
  {
    from: 'DELIVERED',
    command: 'auto-complete',
    to: 'COMPLETED',
    actors: ['SYSTEM'],
    modes: DELIVERY,
    guards: [Guards.completionWindowElapsed],
  },
  {
    from: 'DELIVERY_PENDING',
    command: 'dispute',
    to: 'DISPUTED',
    actors: PARTIES,
    modes: DELIVERY,
    guards: [Guards.withinDisputeWindow],
  },
  {
    from: 'DELIVERED',
    command: 'dispute',
    to: 'DISPUTED',
    actors: PARTIES,
    modes: DELIVERY,
    guards: [Guards.withinDisputeWindow],
  },

  // ---- hand-over and return (RENT / BORROW); SELLER = owner/lender, BUYER = renter/borrower
  {
    from: 'CONFIRMED',
    command: 'hand-over',
    to: 'HANDED_OVER',
    actors: ['SELLER'],
    modes: RETURN,
    guards: [],
  },
  {
    from: 'HANDED_OVER',
    command: 'report-return',
    to: 'RETURN_REPORTED',
    actors: ['BUYER'],
    modes: RETURN,
    guards: [],
  },
  {
    from: 'RETURN_REPORTED',
    command: 'confirm-return',
    to: 'RETURNED',
    actors: ['SELLER'],
    modes: RETURN,
    guards: [],
  },
  // The owner simply got it back without the renter reporting it first.
  {
    from: 'HANDED_OVER',
    command: 'confirm-return',
    to: 'RETURNED',
    actors: ['SELLER'],
    modes: RETURN,
    guards: [],
  },
  {
    from: 'RETURNED',
    command: 'complete',
    to: 'COMPLETED',
    actors: ['SELLER'],
    modes: RETURN,
    guards: [],
  },
  {
    from: 'RETURNED',
    command: 'auto-complete',
    to: 'COMPLETED',
    actors: ['SYSTEM'],
    modes: RETURN,
    guards: [Guards.returnWindowElapsed],
  },
  {
    from: 'HANDED_OVER',
    command: 'dispute',
    to: 'DISPUTED',
    actors: PARTIES,
    modes: RETURN,
    guards: [],
  },
  {
    from: 'RETURN_REPORTED',
    command: 'dispute',
    to: 'DISPUTED',
    actors: PARTIES,
    modes: RETURN,
    guards: [],
  },
  // Damage claim: only the owner/lender, only within the window after the return.
  {
    from: 'RETURNED',
    command: 'dispute',
    to: 'DISPUTED',
    actors: ['SELLER'],
    modes: RETURN,
    guards: [Guards.withinDamageClaimWindow],
  },

  // ---- dispute outcomes, decided by the dispute service (ADR-0009)
  { from: 'DISPUTED', command: 'resolve-release', to: 'COMPLETED', actors: ['ADMIN'], guards: [] },
  { from: 'DISPUTED', command: 'resolve-cancel', to: 'CANCELLED', actors: ['ADMIN'], guards: [] },
  {
    from: 'DISPUTED',
    command: 'resolve-refund',
    to: 'REFUNDED',
    actors: ['ADMIN'],
    guards: [Guards.refundable],
  },
  {
    from: 'DISPUTED',
    command: 'withdraw-dispute',
    to: beforeDispute,
    actors: ['SYSTEM'],
    guards: [Guards.hasPreDisputeState],
  },
];

export const TERMINAL_STATES: ReadonlySet<TransactionState> = new Set([
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'EXPIRED',
]);

export interface Decision {
  from: TransactionState;
  to: TransactionState;
}

const appliesTo = (r: TransitionRule, mode: NeedMode) => !r.modes || r.modes.includes(mode);

/**
 * Decides a transition or throws: 403 when the role can never run the command, 422
 * (`NOT_FOR_MODE`) when the command does not exist for the deal's mode (no hand-over on a
 * purchase, no delivery on a rental), 409 when the current state does not allow it, and the
 * guard's code when a guard fails.
 */
export function decide(f: TransitionFacts, command: TransactionCommand, role: ActorRole): Decision {
  const rules = TRANSITIONS.filter((r) => r.command === command);
  if (!rules.some((r) => r.actors.includes(role))) {
    throw new AppError('FORBIDDEN', 'You are not allowed to perform this action.', { command });
  }
  const forMode = rules.filter((r) => appliesTo(r, f.mode));
  if (!forMode.length) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `This action does not apply to ${f.mode.toLowerCase()} deals.`,
      { rule: 'NOT_FOR_MODE', command, mode: f.mode },
    );
  }
  const rule = forMode.find((r) => r.from === f.state);
  if (!rule) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      `Cannot ${command.replace(/-/g, ' ')} a transaction that is ${f.state.toLowerCase().replace(/_/g, ' ')}.`,
      { from: f.state, command },
    );
  }
  if (!rule.actors.includes(role)) {
    throw new AppError('FORBIDDEN', 'You are not allowed to perform this action.', { command });
  }
  for (const guard of rule.guards) {
    const failure = guard(f, role);
    if (failure) throw new AppError(failure.code, failure.message, { rule: failure.rule });
  }
  return { from: f.state, to: typeof rule.to === 'function' ? rule.to(f, role) : rule.to };
}

/** Commands `role` can run right now (used to drive UI buttons). */
export function availableCommands(f: TransitionFacts, role: ActorRole): TransactionCommand[] {
  return TRANSITIONS.filter(
    (r) =>
      r.from === f.state &&
      appliesTo(r, f.mode) &&
      r.actors.includes(role) &&
      r.guards.every((g) => g(f, role) === null),
  ).map((r) => r.command);
}

/** Field changes that accompany a transition (timestamps are taken from the DB clock). */
export interface TransitionPatch {
  buyerConfirmedAt?: true;
  sellerConfirmedAt?: true;
  deliveredAt?: true;
  handedOverAt?: true;
  returnReportedAt?: true;
  returnedAt?: true;
  completedAt?: true;
  cancelReason?: string;
  disputeReason?: string;
  disputeCategory?: DisputeReason;
  preDisputeState?: TransactionState;
}

export function transitionPatch(
  command: TransactionCommand,
  role: ActorRole,
  d: Decision,
  input: { reason?: string | null; category?: DisputeReason | undefined } = {},
): TransitionPatch {
  const p: TransitionPatch = {};
  const reason = input.reason ?? null;
  if (command === 'confirm') {
    if (role === 'BUYER') p.buyerConfirmedAt = true;
    if (role === 'SELLER') p.sellerConfirmedAt = true;
  }
  if (command === 'auto-confirm') {
    p.buyerConfirmedAt = true;
    p.sellerConfirmedAt = true;
  }
  if (command === 'mark-delivered') p.deliveredAt = true;
  if (command === 'hand-over') p.handedOverAt = true;
  if (command === 'report-return') p.returnReportedAt = true;
  if (command === 'confirm-return') p.returnedAt = true;
  if (d.to === 'COMPLETED') p.completedAt = true;
  if ((command === 'cancel' || command === 'resolve-cancel') && reason) p.cancelReason = reason;
  if (command === 'dispute') {
    p.preDisputeState = d.from;
    p.disputeCategory = input.category ?? 'OTHER';
    if (reason) p.disputeReason = reason;
  }
  return p;
}
