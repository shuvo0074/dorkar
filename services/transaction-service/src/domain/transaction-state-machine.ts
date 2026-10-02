import type { TransactionState } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import type { TransactionPolicy } from './transaction';

/**
 * The transaction lifecycle as one declarative table: (from, command) → to, who may run it,
 * and the guards that must pass. Nothing else decides a transaction's state. The table knows
 * nothing about payment or delivery providers; those react to the outcome in the application.
 */

export const TransactionCommands = [
  'confirm',
  'cancel',
  'expire',
  'arrange-delivery',
  'mark-delivered',
  'confirm-receipt',
  'auto-complete',
  'dispute',
  'resolve-release',
  'resolve-cancel',
] as const;
export type TransactionCommand = (typeof TransactionCommands)[number];

export const ActorRoles = ['BUYER', 'SELLER', 'ADMIN', 'SYSTEM'] as const;
export type ActorRole = (typeof ActorRoles)[number];

/** Everything the guards look at. `now` is the database clock. */
export interface TransitionFacts {
  state: TransactionState;
  buyerConfirmedAt: Date | null;
  sellerConfirmedAt: Date | null;
  createdAt: Date;
  deliveredAt: Date | null;
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
};

/** Both parties must confirm; the first confirmation keeps the transaction CREATED. */
const afterConfirmation = (f: TransitionFacts, role: ActorRole): TransactionState => {
  const other = role === 'BUYER' ? f.sellerConfirmedAt : f.buyerConfirmedAt;
  return other ? 'CONFIRMED' : 'CREATED';
};

const PARTIES = ['BUYER', 'SELLER'] as const;

// ---------------------------------------------------------------- the table

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    from: 'CREATED',
    command: 'confirm',
    to: afterConfirmation,
    actors: PARTIES,
    guards: [Guards.notYetConfirmedByActor, Guards.withinConfirmTtl],
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
  {
    from: 'CONFIRMED',
    command: 'arrange-delivery',
    to: 'DELIVERY_PENDING',
    actors: PARTIES,
    guards: [],
  },
  {
    from: 'DELIVERY_PENDING',
    command: 'mark-delivered',
    to: 'DELIVERED',
    actors: ['SELLER'],
    guards: [],
  },
  { from: 'DELIVERED', command: 'confirm-receipt', to: 'COMPLETED', actors: ['BUYER'], guards: [] },
  {
    from: 'DELIVERED',
    command: 'auto-complete',
    to: 'COMPLETED',
    actors: ['SYSTEM'],
    guards: [Guards.completionWindowElapsed],
  },
  {
    from: 'DELIVERY_PENDING',
    command: 'dispute',
    to: 'DISPUTED',
    actors: PARTIES,
    guards: [Guards.withinDisputeWindow],
  },
  {
    from: 'DELIVERED',
    command: 'dispute',
    to: 'DISPUTED',
    actors: PARTIES,
    guards: [Guards.withinDisputeWindow],
  },
  { from: 'DISPUTED', command: 'resolve-release', to: 'COMPLETED', actors: ['ADMIN'], guards: [] },
  { from: 'DISPUTED', command: 'resolve-cancel', to: 'CANCELLED', actors: ['ADMIN'], guards: [] },
  // DISPUTED → REFUNDED is reserved for non-cash providers (resolution = REFUND).
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

/**
 * Decides a transition or throws: 403 when the role can never run the command, 409 when the
 * current state does not allow it, and the guard's code when a guard fails.
 */
export function decide(f: TransitionFacts, command: TransactionCommand, role: ActorRole): Decision {
  const rules = TRANSITIONS.filter((r) => r.command === command);
  if (!rules.some((r) => r.actors.includes(role))) {
    throw new AppError('FORBIDDEN', 'You are not allowed to perform this action.', { command });
  }
  const rule = rules.find((r) => r.from === f.state);
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
      r.from === f.state && r.actors.includes(role) && r.guards.every((g) => g(f, role) === null),
  ).map((r) => r.command);
}

/** Field changes that accompany a transition (timestamps are taken from the DB clock). */
export interface TransitionPatch {
  buyerConfirmedAt?: true;
  sellerConfirmedAt?: true;
  deliveredAt?: true;
  completedAt?: true;
  cancelReason?: string;
  disputeReason?: string;
}

export function transitionPatch(
  command: TransactionCommand,
  role: ActorRole,
  to: TransactionState,
  reason: string | null,
): TransitionPatch {
  const p: TransitionPatch = {};
  if (command === 'confirm') {
    if (role === 'BUYER') p.buyerConfirmedAt = true;
    if (role === 'SELLER') p.sellerConfirmedAt = true;
  }
  if (command === 'mark-delivered') p.deliveredAt = true;
  if (to === 'COMPLETED') p.completedAt = true;
  if ((command === 'cancel' || command === 'resolve-cancel') && reason) p.cancelReason = reason;
  if (command === 'dispute' && reason) p.disputeReason = reason;
  return p;
}
