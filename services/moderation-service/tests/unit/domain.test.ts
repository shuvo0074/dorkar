import { permissionsFor, type Permission } from '@dorkar/contracts';
import { describe, expect, it } from 'vitest';
import {
  assertAssignable,
  assertNotOwnCase,
  assertNotSelfReport,
  assertPermitted,
  CaseStatuses,
  computePriority,
  decide,
  DecisionActions,
  MAX_COUNTED_REPORTS,
  moreSevere,
  REASON_WEIGHTS,
  withReport,
  type CaseStatus,
  type DecisionAction,
} from '../../src/domain/moderation';

const ME = '0192f0c4-0000-7000-8000-000000000001';
const OTHER = '0192f0c4-0000-7000-8000-000000000002';

describe('priority', () => {
  it('weighs scams, prohibited items and harassment above other reasons', () => {
    for (const severe of ['SCAM', 'PROHIBITED_ITEM', 'HARASSMENT'] as const) {
      for (const mild of ['SPAM', 'OFFENSIVE', 'CONTACT_INFO', 'FAKE', 'OTHER'] as const) {
        expect(computePriority(severe, 1)).toBeGreaterThan(computePriority(mild, 1));
      }
    }
  });

  it('rises with report count, capped against brigading', () => {
    expect(computePriority('SPAM', 2)).toBeGreaterThan(computePriority('SPAM', 1));
    expect(computePriority('SPAM', MAX_COUNTED_REPORTS + 50)).toBe(
      computePriority('SPAM', MAX_COUNTED_REPORTS),
    );
    expect(computePriority('OTHER', 0)).toBe(REASON_WEIGHTS.OTHER);
  });

  it('enough reports outrank a single severe one', () => {
    expect(computePriority('SPAM', 6)).toBeGreaterThan(computePriority('SCAM', 1));
  });

  it('keeps the most severe reason; ties keep the current', () => {
    expect(moreSevere('SPAM', 'SCAM')).toBe('SCAM');
    expect(moreSevere('SCAM', 'SPAM')).toBe('SCAM');
    expect(moreSevere('SCAM', 'HARASSMENT')).toBe('SCAM');
  });

  it('a new report bumps count, reason and priority', () => {
    const first = withReport({ reportCount: 0, topReason: 'SPAM' }, 'SPAM');
    expect(first).toEqual({
      reportCount: 1,
      topReason: 'SPAM',
      priority: computePriority('SPAM', 1),
    });
    const second = withReport(first, 'SCAM');
    expect(second).toEqual({
      reportCount: 2,
      topReason: 'SCAM',
      priority: computePriority('SCAM', 2),
    });
    expect(second.priority).toBeGreaterThan(first.priority);
  });
});

describe('reporting rules', () => {
  it('forbids reporting yourself, but not your id under another target type', () => {
    expect(() => assertNotSelfReport(ME, 'USER', ME)).toThrow(/yourself/);
    expect(() => assertNotSelfReport(ME, 'USER', OTHER)).not.toThrow();
    expect(() => assertNotSelfReport(ME, 'LISTING', ME)).not.toThrow();
  });
});

describe('case state machine', () => {
  type Row = [CaseStatus, boolean, DecisionAction, string];
  // [status, targetHidden, action, outcome] for a non-USER target — every combination.
  const table: Row[] = [
    ['OPEN', false, 'HIDE', 'ACTIONED/hidden/RESOLVED/HIDE'],
    ['OPEN', false, 'DISMISS', 'DISMISSED/visible/DISMISSED/-'],
    ['OPEN', false, 'RESTORE', '409'],
    ['OPEN', true, 'HIDE', 'ACTIONED/hidden/RESOLVED/HIDE'],
    ['OPEN', true, 'DISMISS', 'DISMISSED/visible/DISMISSED/-'],
    ['OPEN', true, 'RESTORE', '409'],
    ['ACTIONED', true, 'RESTORE', 'ACTIONED/visible/-/RESTORE'],
    ['ACTIONED', true, 'HIDE', '409'],
    ['ACTIONED', true, 'DISMISS', '409'],
    ['ACTIONED', false, 'RESTORE', '409'],
    ['ACTIONED', false, 'HIDE', '409'],
    ['ACTIONED', false, 'DISMISS', '409'],
    ['DISMISSED', false, 'HIDE', '409'],
    ['DISMISSED', false, 'RESTORE', '409'],
    ['DISMISSED', false, 'DISMISS', '409'],
    ['DISMISSED', true, 'HIDE', '409'],
    ['DISMISSED', true, 'RESTORE', '409'],
    ['DISMISSED', true, 'DISMISS', '409'],
  ];

  const outcome = (status: CaseStatus, targetHidden: boolean, action: DecisionAction) => {
    try {
      const d = decide({ status, targetHidden, targetType: 'LISTING' }, action);
      return `${d.status}/${d.targetHidden ? 'hidden' : 'visible'}/${d.reports ?? '-'}/${d.event ?? '-'}`;
    } catch (err) {
      return String((err as { status?: number }).status);
    }
  };

  it('covers every status × hidden × action', () => {
    expect(table).toHaveLength(CaseStatuses.length * 2 * DecisionActions.length);
  });

  it.each(table)('%s (hidden=%s) + %s → %s', (status, hidden, action, expected) => {
    expect(outcome(status, hidden, action)).toBe(expected);
  });

  it('USER targets cannot be hidden or restored here, only dismissed', () => {
    for (const status of CaseStatuses) {
      for (const action of ['HIDE', 'RESTORE'] as const) {
        expect(() => decide({ status, targetHidden: false, targetType: 'USER' }, action)).toThrow(
          expect.objectContaining({ details: { rule: 'USE_ACCOUNT_ADMIN' } }),
        );
      }
    }
    expect(decide({ status: 'OPEN', targetHidden: false, targetType: 'USER' }, 'DISMISS')).toEqual({
      status: 'DISMISSED',
      targetHidden: false,
      reports: 'DISMISSED',
      event: null,
    });
  });

  it('only open cases can be assigned', () => {
    expect(() => assertAssignable({ status: 'OPEN' })).not.toThrow();
    expect(() => assertAssignable({ status: 'ACTIONED' })).toThrow();
    expect(() => assertAssignable({ status: 'DISMISSED' })).toThrow();
  });
});

describe('permissions per action', () => {
  const allowed = (perms: Permission[], action: DecisionAction) => {
    try {
      assertPermitted(new Set(perms), action);
      return true;
    } catch {
      return false;
    }
  };

  it('maps each decision to its permission', () => {
    expect(allowed(['moderation:content:hide'], 'HIDE')).toBe(true);
    expect(allowed(['moderation:case:read'], 'HIDE')).toBe(false);
    expect(allowed(['moderation:content:hide'], 'RESTORE')).toBe(false);
    expect(allowed(['moderation:content:restore'], 'RESTORE')).toBe(true);
    expect(allowed(['moderation:case:read'], 'DISMISS')).toBe(true);
    expect(allowed(['moderation:content:hide'], 'DISMISS')).toBe(false);
  });

  it('moderators can do everything; support and members nothing', () => {
    for (const action of DecisionActions) {
      expect(allowed([...permissionsFor(['MODERATOR'])], action)).toBe(true);
      expect(allowed([...permissionsFor(['ADMIN'])], action)).toBe(true);
      expect(allowed([...permissionsFor(['SUPPORT'])], action)).toBe(false);
      expect(allowed([...permissionsFor(['MEMBER'])], action)).toBe(false);
    }
  });

  it('nobody moderates a case about themselves', () => {
    expect(() => assertNotOwnCase(ME, { targetType: 'USER', targetId: ME })).toThrow(/yourself/);
    expect(() => assertNotOwnCase(ME, { targetType: 'USER', targetId: OTHER })).not.toThrow();
    expect(() => assertNotOwnCase(ME, { targetType: 'LISTING', targetId: ME })).not.toThrow();
  });
});
