import type { LoanStatus, TransactionState } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import type { Requirements } from './lend-item';

export interface Loan {
  id: string;
  itemId: string;
  lenderId: string;
  borrowerId: string;
  /** Snapshot of the item when requested (the item may be edited later). */
  itemTitle: string;
  categoryId: string;
  startAt: Date;
  returnBy: Date;
  message: string | null;
  depositAmount: number | null;
  status: LoanStatus;
  transactionId: string | null;
  declineReason: string | null;
  /** When the item first came back (borrower reported or lender confirmed). */
  returnedAt: Date | null;
  overdueNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface LoanTransition {
  id: string;
  loanId: string;
  from: LoanStatus | null;
  to: LoanStatus;
  command: string;
  actorId: string | null;
  actorRole: ActorRole;
  reason: string | null;
  at: Date;
}

// ---------------------------------------------------------------- eligibility (trust gate)

/** The borrower's own signals, from the reputation and verification projections. */
export interface BorrowerFacts {
  nidVerified: boolean;
  completedCount: number;
  ratingAverage: number | null;
  ratingCount: number;
}

export const UNKNOWN_BORROWER: BorrowerFacts = {
  nidVerified: false,
  completedCount: 0,
  ratingAverage: null,
  ratingCount: 0,
};

export type RequirementKey = keyof Requirements;

/** Which of the item's requirements the borrower does not meet (empty = eligible). */
export function unmetRequirements(req: Requirements, b: BorrowerFacts): RequirementKey[] {
  const failed: RequirementKey[] = [];
  if (req.nidVerified && !b.nidVerified) failed.push('nidVerified');
  if (b.completedCount < req.minCompletedDeals) failed.push('minCompletedDeals');
  if (
    req.minRating !== null &&
    (b.ratingAverage === null || b.ratingCount === 0 || b.ratingAverage < req.minRating)
  ) {
    failed.push('minRating');
  }
  return failed;
}

/** 422 listing only the keys that failed; never the borrower's (or anyone's) actual values. */
export function assertEligible(req: Requirements, b: BorrowerFacts): void {
  const failed = unmetRequirements(req, b);
  if (failed.length > 0) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      'You do not meet this lender’s requirements yet.',
      { rule: 'BORROWER_NOT_ELIGIBLE', failed },
    );
  }
}

// ---------------------------------------------------------------- request rules

const DAY_MS = 86_400_000;
/** Requests may start a little in the past (clock skew, "right now"). */
export const START_GRACE_MS = 60 * 60_000;

export interface LoanWindow {
  startAt: Date;
  returnBy: Date;
}

export function assertLoanWindow(w: LoanWindow, maxLoanDays: number, now: Date): void {
  const rule = (name: string, message: string, extra: Record<string, unknown> = {}) =>
    new AppError('BUSINESS_RULE_VIOLATION', message, { rule: name, ...extra });
  if (w.returnBy.getTime() <= w.startAt.getTime()) {
    throw rule('INVALID_LOAN_PERIOD', 'The return date must be after the start.');
  }
  if (w.startAt.getTime() < now.getTime() - START_GRACE_MS) {
    throw rule('LOAN_START_IN_PAST', 'The loan cannot start in the past.');
  }
  if (w.returnBy.getTime() - w.startAt.getTime() > maxLoanDays * DAY_MS) {
    throw rule('LOAN_TOO_LONG', `This item can be borrowed for at most ${maxLoanDays} days.`, {
      maxLoanDays,
    });
  }
}

export function assertCanRequest(item: { lenderId: string; active: boolean }, borrowerId: string) {
  if (item.lenderId === borrowerId) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'You cannot borrow your own item.', {
      rule: 'OWN_ITEM',
    });
  }
  if (!item.active) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'This item is not available to borrow.', {
      rule: 'ITEM_NOT_AVAILABLE',
    });
  }
}

// ---------------------------------------------------------------- state machine

/**
 * Lending decides agreement (approve/decline/cancel/expire). After approval the transaction
 * owns the lifecycle; lending mirrors it with `sync` (ADR-0008).
 */
export const LoanCommands = ['approve', 'decline', 'cancel', 'expire'] as const;
export type LoanCommand = (typeof LoanCommands)[number];

export const ActorRoles = ['LENDER', 'BORROWER', 'SYSTEM'] as const;
export type ActorRole = (typeof ActorRoles)[number];

export interface TransitionFacts {
  status: LoanStatus;
  returnBy: Date;
  /** Database clock. */
  now: Date;
  itemAvailable: boolean;
}

export interface TransitionRule {
  from: LoanStatus;
  command: LoanCommand;
  to: LoanStatus;
  actors: readonly ActorRole[];
  guards: readonly ((f: TransitionFacts) => AppError | null)[];
}

export const Guards = {
  itemAvailable: (f: TransitionFacts) =>
    f.itemAvailable
      ? null
      : new AppError('BUSINESS_RULE_VIOLATION', 'This item is no longer available to lend.', {
          rule: 'ITEM_NOT_AVAILABLE',
        }),
  periodNotOver: (f: TransitionFacts) =>
    f.returnBy.getTime() > f.now.getTime()
      ? null
      : new AppError('BUSINESS_RULE_VIOLATION', 'The requested period has already ended.', {
          rule: 'LOAN_PERIOD_PASSED',
        }),
};

export const TRANSITIONS: readonly TransitionRule[] = [
  {
    from: 'REQUESTED',
    command: 'approve',
    to: 'APPROVED',
    actors: ['LENDER'],
    guards: [Guards.itemAvailable, Guards.periodNotOver],
  },
  { from: 'REQUESTED', command: 'decline', to: 'DECLINED', actors: ['LENDER'], guards: [] },
  { from: 'REQUESTED', command: 'cancel', to: 'CANCELLED', actors: ['BORROWER'], guards: [] },
  { from: 'REQUESTED', command: 'expire', to: 'EXPIRED', actors: ['SYSTEM'], guards: [] },
];

export interface Decision {
  from: LoanStatus;
  to: LoanStatus;
}

/** 403 when the role can never run the command, 409 when the state forbids it, guard errors. */
export function decide(f: TransitionFacts, command: LoanCommand, role: ActorRole): Decision {
  const rules = TRANSITIONS.filter((r) => r.command === command);
  if (!rules.some((r) => r.actors.includes(role))) {
    throw new AppError('FORBIDDEN', 'You are not allowed to perform this action.', { command });
  }
  const rule = rules.find((r) => r.from === f.status);
  if (!rule) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      `Cannot ${command} a loan that is ${f.status.toLowerCase().replace(/_/g, ' ')}.`,
      { from: f.status, command },
    );
  }
  for (const guard of rule.guards) {
    const failure = guard(f);
    if (failure) throw failure;
  }
  return { from: f.status, to: rule.to };
}

export function availableCommands(f: TransitionFacts, role: ActorRole): LoanCommand[] {
  return TRANSITIONS.filter(
    (r) => r.from === f.status && r.actors.includes(role) && r.guards.every((g) => !g(f)),
  ).map((r) => r.command);
}

// ---------------------------------------------------------------- transaction mirror

/** Loan states that exist only because a transaction does. */
export const DEAL_STATUSES: ReadonlySet<LoanStatus> = new Set([
  'APPROVED',
  'LENT',
  'RETURN_REPORTED',
  'RETURNED',
  'DISPUTED',
]);

/** Statuses that hold the item's calendar (the EXCLUDE constraint's predicate). */
export const BLOCKING_STATUSES = ['APPROVED', 'LENT', 'RETURN_REPORTED'] as const;

/** The loan status a transaction state corresponds to (null: not part of the BORROW flow). */
export function loanStatusFor(tx: TransactionState): LoanStatus | null {
  switch (tx) {
    case 'CREATED':
    case 'CONFIRMED':
      return 'APPROVED';
    case 'HANDED_OVER':
      return 'LENT';
    case 'RETURN_REPORTED':
      return 'RETURN_REPORTED';
    case 'RETURNED':
      return 'RETURNED';
    case 'COMPLETED':
      return 'CLOSED';
    case 'CANCELLED':
    case 'EXPIRED':
    case 'REFUNDED':
      return 'CANCELLED';
    case 'DISPUTED':
      return 'DISPUTED';
    case 'DELIVERY_PENDING':
    case 'DELIVERED':
      return null;
  }
}

/**
 * The transaction is authoritative: any deal-state loan follows it. Loans that never reached
 * agreement or are already closed/cancelled are left alone; so are no-op changes.
 */
export function mirrorTarget(current: LoanStatus, tx: TransactionState): LoanStatus | null {
  if (!DEAL_STATUSES.has(current)) return null;
  const to = loanStatusFor(tx);
  return to && to !== current ? to : null;
}

/** Returned (borrower reported or lender confirmed): stamps `returnedAt` the first time. */
export const marksReturn = (to: LoanStatus) => to === 'RETURN_REPORTED' || to === 'RETURNED';
