import { NeedStatuses, type NeedStatus } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  NeedActions,
  transition,
  transitionTable,
  type NeedAction,
  type TransitionFacts,
} from '../../src/domain/need-state-machine';

const now = new Date('2026-10-02T10:00:00Z');
const facts = (over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  now,
  expiresAt: new Date('2026-10-10T00:00:00Z'),
  renewals: 0,
  maxRenewals: 2,
  statusBeforeHidden: null,
  ...over,
});

/** The complete allowed table (03-lifecycles §1). Everything else must be refused. */
const ALLOWED: Record<NeedAction, Partial<Record<NeedStatus, NeedStatus>>> = {
  publish: { DRAFT: 'OPEN' },
  pause: { OPEN: 'PAUSED' },
  resume: { PAUSED: 'OPEN' },
  close: { OPEN: 'CLOSED', PAUSED: 'CLOSED' },
  expire: { OPEN: 'EXPIRED', PAUSED: 'EXPIRED' },
  renew: { EXPIRED: 'OPEN' },
  fulfil: { OPEN: 'FULFILLING' },
  reopen: { FULFILLING: 'OPEN' },
  complete: { FULFILLING: 'FULFILLED' },
  hide: {
    OPEN: 'HIDDEN',
    PAUSED: 'HIDDEN',
    FULFILLING: 'HIDDEN',
    FULFILLED: 'HIDDEN',
    CLOSED: 'HIDDEN',
    EXPIRED: 'HIDDEN',
  },
  restore: { HIDDEN: 'OPEN' }, // with statusBeforeHidden = OPEN below
};

describe('need state machine', () => {
  const cases = NeedStatuses.flatMap((from) => NeedActions.map((action) => ({ from, action })));

  it('covers every (status, action) pair', () => {
    expect(transitionTable()).toHaveLength(NeedStatuses.length * NeedActions.length);
  });

  it.each(cases)('$action from $from', ({ from, action }) => {
    const expected = ALLOWED[action][from];
    const f = facts({ statusBeforeHidden: 'OPEN' });
    if (expected) {
      expect(transition(from, action, f)).toBe(expected);
    } else {
      let err: unknown;
      try {
        transition(from, action, f);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('INVALID_STATE_TRANSITION');
    }
  });

  it('refuses to resume an expired need', () => {
    expect(() => transition('PAUSED', 'resume', facts({ expiresAt: now }))).toThrow(
      expect.objectContaining({ details: { rule: 'NEED_EXPIRED' } }),
    );
    expect(transition('PAUSED', 'resume', facts({ expiresAt: new Date(now.getTime() + 1) }))).toBe(
      'OPEN',
    );
  });

  it('limits renewals', () => {
    expect(transition('EXPIRED', 'renew', facts({ renewals: 1 }))).toBe('OPEN');
    expect(() => transition('EXPIRED', 'renew', facts({ renewals: 2 }))).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({ rule: 'MAX_RENEWALS_REACHED' }),
      }),
    );
    expect(() => transition('EXPIRED', 'renew', facts({ maxRenewals: 0 }))).toThrow(AppError);
  });

  it('restores to the status before hiding', () => {
    for (const prev of [
      'OPEN',
      'PAUSED',
      'FULFILLING',
      'FULFILLED',
      'CLOSED',
      'EXPIRED',
    ] as const) {
      expect(transition('HIDDEN', 'restore', facts({ statusBeforeHidden: prev }))).toBe(prev);
    }
    // Unknown origin: never resurrect as OPEN.
    expect(transition('HIDDEN', 'restore', facts({ statusBeforeHidden: null }))).toBe('CLOSED');
  });

  it('never hides drafts and never re-hides', () => {
    expect(() => transition('DRAFT', 'hide', facts())).toThrow(AppError);
    expect(() => transition('HIDDEN', 'hide', facts())).toThrow(AppError);
  });
});
