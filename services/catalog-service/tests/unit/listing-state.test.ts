import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  availabilityEffect,
  canTransition,
  HideableStatuses,
  ListingActions,
  ListingStatuses,
  transition,
  type HideableStatus,
  type ListingAction,
  type ListingStatus,
} from '../../src/domain/listing';

/** Expected target for every (state, action); undefined = not allowed. HIDDEN rows are per pre-hide state. */
type Row = Partial<Record<ListingAction, ListingStatus>>;
const TABLE: Record<Exclude<ListingStatus, 'HIDDEN'>, Row> &
  Record<`HIDDEN<${HideableStatus}`, Row> = {
  DRAFT: { publish: 'PUBLISHED', withdraw: 'WITHDRAWN' },
  PUBLISHED: { pause: 'PAUSED', markSoldOut: 'SOLD_OUT', withdraw: 'WITHDRAWN', hide: 'HIDDEN' },
  PAUSED: {
    resume: 'PUBLISHED',
    markSoldOut: 'SOLD_OUT',
    withdraw: 'WITHDRAWN',
    hide: 'HIDDEN',
  },
  SOLD_OUT: { withdraw: 'WITHDRAWN', hide: 'HIDDEN' },
  WITHDRAWN: {},
  'HIDDEN<PUBLISHED': { restore: 'PUBLISHED', withdraw: 'WITHDRAWN' },
  'HIDDEN<PAUSED': { restore: 'PAUSED', withdraw: 'WITHDRAWN' },
  'HIDDEN<SOLD_OUT': { restore: 'SOLD_OUT', withdraw: 'WITHDRAWN' },
};

const states = Object.keys(TABLE).map((key) => {
  const m = /^HIDDEN<(.+)$/.exec(key);
  return {
    key: key as keyof typeof TABLE,
    listing: m
      ? { status: 'HIDDEN' as const, hiddenFrom: m[1] as HideableStatus }
      : { status: key as ListingStatus, hiddenFrom: null },
  };
});

describe('listing state machine', () => {
  it('covers every status', () => {
    const covered = new Set(states.map((s) => s.listing.status));
    expect([...covered].sort()).toEqual([...ListingStatuses].sort());
  });

  for (const { key, listing } of states) {
    for (const action of ListingActions) {
      const expected = TABLE[key][action];
      it(`${key} --${action}--> ${expected ?? '409'}`, () => {
        expect(canTransition(listing, action)).toBe(expected !== undefined);
        if (expected) {
          const t = transition(listing, action);
          expect(t.from).toBe(listing.status);
          expect(t.to).toBe(expected);
          expect(t.hiddenFrom).toBe(expected === 'HIDDEN' ? listing.status : null);
        } else {
          let err: unknown;
          try {
            transition(listing, action);
          } catch (e) {
            err = e;
          }
          expect(err).toBeInstanceOf(AppError);
          expect((err as AppError).code).toBe('INVALID_STATE_TRANSITION');
          expect((err as AppError).status).toBe(409);
        }
      });
    }
  }

  it('cannot restore a HIDDEN row with no remembered state', () => {
    expect(canTransition({ status: 'HIDDEN', hiddenFrom: null }, 'restore')).toBe(false);
  });

  it('hide remembers each hideable state', () => {
    for (const s of HideableStatuses) {
      expect(transition({ status: s, hiddenFrom: null }, 'hide').hiddenFrom).toBe(s);
    }
  });
});

describe('availability effects (which event a transition emits)', () => {
  it.each([
    ['DRAFT', 'PUBLISHED', { kind: 'AVAILABLE' }],
    ['PAUSED', 'PUBLISHED', { kind: 'AVAILABLE' }],
    ['HIDDEN', 'PUBLISHED', { kind: 'AVAILABLE' }],
    ['PUBLISHED', 'PAUSED', { kind: 'UNAVAILABLE', reason: 'PAUSED' }],
    ['PUBLISHED', 'SOLD_OUT', { kind: 'UNAVAILABLE', reason: 'SOLD_OUT' }],
    ['PAUSED', 'WITHDRAWN', { kind: 'UNAVAILABLE', reason: 'WITHDRAWN' }],
    ['SOLD_OUT', 'HIDDEN', { kind: 'UNAVAILABLE', reason: 'HIDDEN' }],
    ['HIDDEN', 'PAUSED', { kind: 'UNAVAILABLE', reason: 'PAUSED' }],
    ['DRAFT', 'WITHDRAWN', { kind: 'NONE' }],
  ] as const)('%s → %s', (from, to, effect) => {
    expect(availabilityEffect({ from, to })).toEqual(effect);
  });
});
