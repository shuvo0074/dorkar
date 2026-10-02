import { ModerationTargets, type Permission } from '@dorkar/contracts';
import { AppError, Errors } from '@dorkar/kernel';

export type ModerationTarget = (typeof ModerationTargets)[number];
export { ModerationTargets };

export const ReportReasons = [
  'SCAM',
  'PROHIBITED_ITEM',
  'SPAM',
  'OFFENSIVE',
  'CONTACT_INFO',
  'FAKE',
  'HARASSMENT',
  'OTHER',
] as const;
export type ReportReason = (typeof ReportReasons)[number];

export const ReportStatuses = ['OPEN', 'RESOLVED', 'DISMISSED'] as const;
export type ReportStatus = (typeof ReportStatuses)[number];

export const CaseStatuses = ['OPEN', 'ACTIONED', 'DISMISSED'] as const;
export type CaseStatus = (typeof CaseStatuses)[number];

export const ActionKinds = ['HIDE', 'RESTORE', 'DISMISS', 'ASSIGN', 'NOTE'] as const;
export type ActionKind = (typeof ActionKinds)[number];

/** Decisions a moderator takes on a case (ASSIGN and NOTE do not change its outcome). */
export const DecisionActions = ['HIDE', 'RESTORE', 'DISMISS'] as const;
export type DecisionAction = (typeof DecisionActions)[number];

export interface ModerationCase {
  id: string;
  targetType: ModerationTarget;
  targetId: string;
  status: CaseStatus;
  reportCount: number;
  topReason: ReportReason;
  priority: number;
  assignedTo: string | null;
  targetHidden: boolean;
  openedAt: Date;
  closedAt: Date | null;
  version: number;
}

export interface Report {
  id: string;
  reporterId: string;
  targetType: ModerationTarget;
  targetId: string;
  reason: ReportReason;
  details: string | null;
  caseId: string;
  status: ReportStatus;
  createdAt: Date;
}

export interface ModerationAction {
  id: string;
  caseId: string;
  moderatorId: string;
  action: ActionKind;
  reason: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------- priority

/** Harm-weighted: fraud, illegal goods and harassment jump the queue. */
export const REASON_WEIGHTS: Readonly<Record<ReportReason, number>> = {
  SCAM: 50,
  PROHIBITED_ITEM: 50,
  HARASSMENT: 50,
  FAKE: 20,
  OFFENSIVE: 20,
  CONTACT_INFO: 10,
  SPAM: 10,
  OTHER: 5,
};
export const REPORT_COUNT_WEIGHT = 10;
/** Beyond this many reports, more reports no longer raise priority (blunts brigading). */
export const MAX_COUNTED_REPORTS = 20;

export function computePriority(topReason: ReportReason, reportCount: number): number {
  return (
    REASON_WEIGHTS[topReason] +
    REPORT_COUNT_WEIGHT * Math.min(Math.max(reportCount, 0), MAX_COUNTED_REPORTS)
  );
}

/** The more severe of two reasons; ties keep the current one. */
export const moreSevere = (current: ReportReason, incoming: ReportReason): ReportReason =>
  REASON_WEIGHTS[incoming] > REASON_WEIGHTS[current] ? incoming : current;

/** A new report joins the case: counts it, keeps the most severe reason, re-ranks. */
export function withReport(
  c: Pick<ModerationCase, 'reportCount' | 'topReason'>,
  reason: ReportReason,
): Pick<ModerationCase, 'reportCount' | 'topReason' | 'priority'> {
  const reportCount = c.reportCount + 1;
  const topReason = moreSevere(c.topReason, reason);
  return { reportCount, topReason, priority: computePriority(topReason, reportCount) };
}

// ---------------------------------------------------------------- reporting rules

export function assertNotSelfReport(
  reporterId: string,
  targetType: ModerationTarget,
  targetId: string,
): void {
  if (targetType === 'USER' && targetId === reporterId) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'You cannot report yourself.', {
      rule: 'CANNOT_REPORT_SELF',
    });
  }
}

// ---------------------------------------------------------------- decisions

export const DECISION_PERMISSIONS: Readonly<Record<DecisionAction, Permission>> = {
  HIDE: 'moderation:content:hide',
  RESTORE: 'moderation:content:restore',
  DISMISS: 'moderation:case:read',
};

export function assertPermitted(
  permissions: ReadonlySet<Permission>,
  action: DecisionAction,
): void {
  if (!permissions.has(DECISION_PERMISSIONS[action])) throw Errors.forbidden();
}

/** Conflict of interest: nobody moderates a case about themselves. */
export function assertNotOwnCase(
  moderatorId: string,
  c: Pick<ModerationCase, 'targetType' | 'targetId'>,
): void {
  if (c.targetType === 'USER' && c.targetId === moderatorId) {
    throw Errors.forbidden('You cannot moderate a case about yourself.');
  }
}

export interface Decision {
  status: CaseStatus;
  targetHidden: boolean;
  /** New status for the case's open reports, or null to leave them. */
  reports: ReportStatus | null;
  /** Owner-facing event to emit, or null. */
  event: 'HIDE' | 'RESTORE' | null;
}

/**
 * Case state machine.
 *   OPEN      --HIDE-->    ACTIONED (target hidden, reports RESOLVED, event HIDE)
 *   OPEN      --DISMISS--> DISMISSED (reports DISMISSED, no event)
 *   ACTIONED  --RESTORE--> ACTIONED (target visible again, event RESTORE) — only while hidden
 * Anything else is an invalid transition. USER targets cannot be hidden/restored here: account
 * suspension is identity's admin API.
 */
export function decide(
  c: Pick<ModerationCase, 'status' | 'targetHidden' | 'targetType'>,
  action: DecisionAction,
): Decision {
  if (c.targetType === 'USER' && (action === 'HIDE' || action === 'RESTORE')) {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      'Accounts are suspended through the account admin, not hidden here.',
      { rule: 'USE_ACCOUNT_ADMIN' },
    );
  }
  if (action === 'HIDE' && c.status === 'OPEN') {
    return { status: 'ACTIONED', targetHidden: true, reports: 'RESOLVED', event: 'HIDE' };
  }
  if (action === 'DISMISS' && c.status === 'OPEN') {
    return { status: 'DISMISSED', targetHidden: false, reports: 'DISMISSED', event: null };
  }
  if (action === 'RESTORE' && c.status === 'ACTIONED' && c.targetHidden) {
    return { status: 'ACTIONED', targetHidden: false, reports: null, event: 'RESTORE' };
  }
  throw new AppError('INVALID_STATE_TRANSITION', `Cannot ${action} a case that is ${c.status}.`, {
    from: c.status,
    action,
  });
}

export function assertAssignable(c: Pick<ModerationCase, 'status'>): void {
  if (c.status !== 'OPEN') {
    throw new AppError('INVALID_STATE_TRANSITION', `Cannot assign a case that is ${c.status}.`, {
      from: c.status,
      action: 'ASSIGN',
    });
  }
}
