import type { BookingStatus, TransactionState } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

/**
 * The booking lifecycle as one declarative table: (from, command) → to, who may run it and the
 * guards that must pass. Up to CONFIRMED rental decides; afterwards the transaction owns the deal
 * and rental only mirrors it (actor TRANSACTION), so those rules accept any earlier post-confirm
 * status: the transaction is authoritative.
 */

export const BookingCommands = [
  'confirm',
  'approve',
  'decline',
  'cancel',
  'expire',
  'mirror-handed-over',
  'mirror-returned',
  'mirror-completed',
  'mirror-cancelled',
] as const;
export type BookingCommand = (typeof BookingCommands)[number];

export const ActorRoles = ['RENTER', 'OWNER', 'SYSTEM', 'TRANSACTION'] as const;
export type ActorRole = (typeof ActorRoles)[number];

/** Everything the guards look at. `now` is the database clock. */
export interface TransitionFacts {
  status: BookingStatus;
  holdExpiresAt: Date | null;
  now: Date;
}

export interface GuardFailure {
  code: 'INVALID_STATE_TRANSITION' | 'BUSINESS_RULE_VIOLATION';
  rule: string;
  message: string;
}

export type Guard = (f: TransitionFacts) => GuardFailure | null;

export interface TransitionRule {
  from: BookingStatus;
  command: BookingCommand;
  to: BookingStatus;
  actors: readonly ActorRole[];
  guards: readonly Guard[];
}

const lapsed = (f: TransitionFacts) =>
  f.holdExpiresAt !== null && f.now.getTime() >= f.holdExpiresAt.getTime();

export const Guards = {
  holdOpen: ((f) =>
    lapsed(f)
      ? {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'HOLD_EXPIRED',
          message: 'The time to confirm this booking has passed.',
        }
      : null) satisfies Guard,
  approvalOpen: ((f) =>
    lapsed(f)
      ? {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'APPROVAL_WINDOW_CLOSED',
          message: 'The time to answer this booking request has passed.',
        }
      : null) satisfies Guard,
  holdLapsed: ((f) =>
    lapsed(f)
      ? null
      : {
          code: 'BUSINESS_RULE_VIOLATION',
          rule: 'HOLD_OPEN',
          message: 'This booking is still waiting for an answer.',
        }) satisfies Guard,
};

const mirror = (
  froms: readonly BookingStatus[],
  command: BookingCommand,
  to: BookingStatus,
): TransitionRule[] =>
  froms.map((from) => ({ from, command, to, actors: ['TRANSACTION'], guards: [] }));

// ---------------------------------------------------------------- the table

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    from: 'HELD',
    command: 'confirm',
    to: 'CONFIRMED',
    actors: ['RENTER'],
    guards: [Guards.holdOpen],
  },
  {
    from: 'PENDING_APPROVAL',
    command: 'approve',
    to: 'CONFIRMED',
    actors: ['OWNER'],
    guards: [Guards.approvalOpen],
  },
  {
    from: 'PENDING_APPROVAL',
    command: 'decline',
    to: 'DECLINED',
    actors: ['OWNER'],
    guards: [],
  },
  { from: 'HELD', command: 'cancel', to: 'CANCELLED', actors: ['RENTER'], guards: [] },
  { from: 'PENDING_APPROVAL', command: 'cancel', to: 'CANCELLED', actors: ['RENTER'], guards: [] },
  {
    from: 'HELD',
    command: 'expire',
    to: 'EXPIRED',
    actors: ['SYSTEM'],
    guards: [Guards.holdLapsed],
  },
  {
    from: 'PENDING_APPROVAL',
    command: 'expire',
    to: 'EXPIRED',
    actors: ['SYSTEM'],
    guards: [Guards.holdLapsed],
  },
  ...mirror(['CONFIRMED'], 'mirror-handed-over', 'ACTIVE'),
  ...mirror(['CONFIRMED', 'ACTIVE'], 'mirror-returned', 'RETURNED'),
  ...mirror(['CONFIRMED', 'ACTIVE', 'RETURNED'], 'mirror-completed', 'CLOSED'),
  ...mirror(['CONFIRMED', 'ACTIVE', 'RETURNED'], 'mirror-cancelled', 'CANCELLED'),
];

export const TERMINAL_STATUSES: ReadonlySet<BookingStatus> = new Set([
  'CLOSED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED',
]);

export interface Decision {
  from: BookingStatus;
  to: BookingStatus;
}

/**
 * Decides a transition or throws: 403 when the role can never run the command, 409 when the
 * current status does not allow it, and the guard's code when a guard fails.
 */
export function decide(f: TransitionFacts, command: BookingCommand, role: ActorRole): Decision {
  const rules = TRANSITIONS.filter((r) => r.command === command);
  if (!rules.some((r) => r.actors.includes(role))) {
    throw new AppError('FORBIDDEN', 'You are not allowed to perform this action.', { command });
  }
  const rule = rules.find((r) => r.from === f.status);
  if (!rule) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      `Cannot ${command.replace(/-/g, ' ')} a booking that is ${f.status.toLowerCase().replace(/_/g, ' ')}.`,
      { from: f.status, command },
    );
  }
  if (!rule.actors.includes(role)) {
    throw new AppError('FORBIDDEN', 'You are not allowed to perform this action.', { command });
  }
  for (const guard of rule.guards) {
    const failure = guard(f);
    if (failure) throw new AppError(failure.code, failure.message, { rule: failure.rule });
  }
  return { from: f.status, to: rule.to };
}

/** Commands `role` can run right now (drives UI buttons). */
export function availableCommands(f: TransitionFacts, role: ActorRole): BookingCommand[] {
  return TRANSITIONS.filter(
    (r) => r.from === f.status && r.actors.includes(role) && r.guards.every((g) => g(f) === null),
  ).map((r) => r.command);
}

/** The mirror command for a transaction state, or null when the booking status does not move. */
export function mirrorCommandFor(to: TransactionState): BookingCommand | null {
  switch (to) {
    case 'HANDED_OVER':
      return 'mirror-handed-over';
    case 'RETURNED':
      return 'mirror-returned';
    case 'COMPLETED':
      return 'mirror-completed';
    case 'CANCELLED':
    case 'EXPIRED':
    case 'REFUNDED':
      return 'mirror-cancelled';
    default:
      return null;
  }
}
