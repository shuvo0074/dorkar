import { NeedStatuses, type NeedStatus } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

/**
 * The Need lifecycle (docs/architecture/03-lifecycles.md §1). The only place that decides which
 * status follows which; application code calls `transition` and persists the result with a
 * status/version guard.
 */
export const NeedActions = [
  'publish', // DRAFT → OPEN (owner, policy checks passed)
  'pause', // OPEN → PAUSED (owner)
  'resume', // PAUSED → OPEN (owner, not past expires_at)
  'close', // OPEN | PAUSED → CLOSED (owner)
  'expire', // OPEN | PAUSED → EXPIRED (job, expires_at reached)
  'renew', // EXPIRED → OPEN (owner, within max renewals)
  'fulfil', // OPEN → FULFILLING (accepted_quantity ≥ quantity)
  'reopen', // FULFILLING → OPEN (accepted_quantity dropped below quantity)
  'complete', // FULFILLING → FULFILLED (all accepted offers' transactions completed)
  'hide', // any visible status → HIDDEN (moderator)
  'restore', // HIDDEN → the status it had before (moderator)
] as const;
export type NeedAction = (typeof NeedActions)[number];

/** Statuses a moderator can hide: everything the public (or the owner) can see, except drafts. */
export const VISIBLE_STATUSES: readonly NeedStatus[] = [
  'OPEN',
  'PAUSED',
  'FULFILLING',
  'FULFILLED',
  'CLOSED',
  'EXPIRED',
];

/** Statuses that count toward the per-user open-need limit. */
export const ACTIVE_STATUSES: readonly NeedStatus[] = ['OPEN', 'PAUSED', 'FULFILLING'];

const TABLE: Readonly<Record<NeedAction, { from: readonly NeedStatus[]; to: NeedStatus | null }>> =
  {
    publish: { from: ['DRAFT'], to: 'OPEN' },
    pause: { from: ['OPEN'], to: 'PAUSED' },
    resume: { from: ['PAUSED'], to: 'OPEN' },
    close: { from: ['OPEN', 'PAUSED'], to: 'CLOSED' },
    expire: { from: ['OPEN', 'PAUSED'], to: 'EXPIRED' },
    renew: { from: ['EXPIRED'], to: 'OPEN' },
    fulfil: { from: ['OPEN'], to: 'FULFILLING' },
    reopen: { from: ['FULFILLING'], to: 'OPEN' },
    complete: { from: ['FULFILLING'], to: 'FULFILLED' },
    hide: { from: VISIBLE_STATUSES, to: 'HIDDEN' },
    restore: { from: ['HIDDEN'], to: null }, // back to the status before hiding
  };

export interface TransitionFacts {
  /** DB clock at decision time. */
  now: Date;
  expiresAt: Date | null;
  renewals: number;
  maxRenewals: number;
  /** For `restore`. */
  statusBeforeHidden: NeedStatus | null;
}

export const canTransition = (from: NeedStatus, action: NeedAction): boolean =>
  TABLE[action].from.includes(from);

/**
 * Returns the next status or throws: 409 INVALID_STATE_TRANSITION when the action is not allowed
 * from `from`, 422 for guards (expired, renewal limit).
 */
export function transition(from: NeedStatus, action: NeedAction, f: TransitionFacts): NeedStatus {
  const rule = TABLE[action];
  if (!rule.from.includes(from)) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      `A ${from.toLowerCase()} need cannot ${action}.`,
      {
        from,
        action,
      },
    );
  }
  if (action === 'resume' && f.expiresAt && f.expiresAt.getTime() <= f.now.getTime()) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'This need has expired. Renew it instead.', {
      rule: 'NEED_EXPIRED',
    });
  }
  if (action === 'renew' && f.renewals >= f.maxRenewals) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      `A need can be renewed at most ${f.maxRenewals} times. Post a new need instead.`,
      { rule: 'MAX_RENEWALS_REACHED', maxRenewals: f.maxRenewals },
    );
  }
  if (action === 'restore') {
    const prev = f.statusBeforeHidden;
    return prev && prev !== 'HIDDEN' && prev !== 'DRAFT' ? prev : 'CLOSED';
  }
  return rule.to!;
}

/** Every (status, action) pair, for exhaustive tests and docs. */
export const transitionTable = (): Array<{
  from: NeedStatus;
  action: NeedAction;
  allowed: boolean;
}> =>
  NeedStatuses.flatMap((from) =>
    NeedActions.map((action) => ({ from, action, allowed: canTransition(from, action) })),
  );
