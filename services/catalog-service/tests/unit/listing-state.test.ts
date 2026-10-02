import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  availabilityEffect,
  canTransition,
  consumesStock,
  HideableStatuses,
  ListingActions,
  ListingStatuses,
  planRelease,
  planReserve,
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
  PUBLISHED: {
    pause: 'PAUSED',
    markSoldOut: 'SOLD_OUT',
    withdraw: 'WITHDRAWN',
    hide: 'HIDDEN',
    sellOut: 'SOLD_OUT',
  },
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

describe('stock-driven transitions', () => {
  it('restock only undoes a sell-out caused by reservations', () => {
    expect(
      canTransition({ status: 'SOLD_OUT', hiddenFrom: null, stockSoldOut: true }, 'restock'),
    ).toBe(true);
    expect(
      canTransition({ status: 'SOLD_OUT', hiddenFrom: null, stockSoldOut: false }, 'restock'),
    ).toBe(false);
    expect(
      transition({ status: 'SOLD_OUT', hiddenFrom: null, stockSoldOut: true }, 'restock'),
    ).toEqual({
      from: 'SOLD_OUT',
      to: 'PUBLISHED',
      hiddenFrom: null,
      stockSoldOut: false,
    });
  });

  it('flags sell-outs: set by sellOut, kept across hide/restore, cleared otherwise', () => {
    expect(transition({ status: 'PUBLISHED', hiddenFrom: null }, 'sellOut').stockSoldOut).toBe(
      true,
    );
    expect(transition({ status: 'PUBLISHED', hiddenFrom: null }, 'markSoldOut').stockSoldOut).toBe(
      false,
    );
    const hidden = transition({ status: 'SOLD_OUT', hiddenFrom: null, stockSoldOut: true }, 'hide');
    expect(hidden).toMatchObject({ to: 'HIDDEN', hiddenFrom: 'SOLD_OUT', stockSoldOut: true });
    expect(
      transition({ status: 'HIDDEN', hiddenFrom: 'SOLD_OUT', stockSoldOut: true }, 'restore'),
    ).toMatchObject({ to: 'SOLD_OUT', stockSoldOut: true });
    expect(
      transition({ status: 'SOLD_OUT', hiddenFrom: null, stockSoldOut: true }, 'withdraw')
        .stockSoldOut,
    ).toBe(false);
  });
});

describe('stock plans', () => {
  const l = (
    status: ListingStatus,
    quantityAvailable: number,
    extra: { hiddenFrom?: HideableStatus; stockSoldOut?: boolean } = {},
  ) => ({
    status,
    quantityAvailable,
    hiddenFrom: extra.hiddenFrom ?? null,
    stockSoldOut: extra.stockSoldOut ?? false,
  });

  it('only products bought outright consume stock', () => {
    expect(consumesStock('PRODUCT', 'BUY')).toBe(true);
    expect(consumesStock('RENTAL', 'BUY')).toBe(false);
    expect(consumesStock('SERVICE', 'BUY')).toBe(false);
    expect(consumesStock('PRODUCT', 'RENT')).toBe(false);
  });

  it('reserves what is left and sells out a live listing at zero', () => {
    expect(planReserve(l('PUBLISHED', 5), 2)).toEqual({
      reserved: 2,
      plan: { quantity: 3, action: null, stockSoldOut: false, announce: true },
    });
    expect(planReserve(l('PUBLISHED', 2), 5)).toEqual({
      reserved: 2,
      plan: { quantity: 0, action: 'sellOut', stockSoldOut: false, announce: false },
    });
    expect(planReserve(l('SOLD_OUT', 0, { stockSoldOut: true }), 1)).toEqual({
      reserved: 0,
      plan: { quantity: 0, action: null, stockSoldOut: true, announce: false },
    });
    // Not offered: no events; a paused listing stays paused at zero.
    expect(planReserve(l('PAUSED', 1), 1).plan).toEqual({
      quantity: 0,
      action: null,
      stockSoldOut: false,
      announce: false,
    });
    // Hidden from PUBLISHED: a later restore must land on SOLD_OUT.
    expect(planReserve(l('HIDDEN', 1, { hiddenFrom: 'PUBLISHED' }), 1).plan).toEqual({
      quantity: 0,
      action: null,
      hiddenFrom: 'SOLD_OUT',
      stockSoldOut: true,
      announce: false,
    });
  });

  it('releases stock: a stock sell-out comes back, everything else keeps its state', () => {
    expect(planRelease(l('SOLD_OUT', 0, { stockSoldOut: true }), 2)).toMatchObject({
      quantity: 2,
      action: 'restock',
    });
    expect(planRelease(l('SOLD_OUT', 0), 2)).toMatchObject({ quantity: 2, action: null });
    expect(planRelease(l('PUBLISHED', 1), 2)).toMatchObject({ quantity: 3, announce: true });
    for (const status of ['PAUSED', 'WITHDRAWN'] as const) {
      expect(planRelease(l(status, 0), 1)).toMatchObject({
        quantity: 1,
        action: null,
        announce: false,
      });
    }
    expect(
      planRelease(l('HIDDEN', 0, { hiddenFrom: 'SOLD_OUT', stockSoldOut: true }), 1),
    ).toMatchObject({ quantity: 1, action: null, hiddenFrom: 'PUBLISHED', stockSoldOut: false });
    expect(planRelease(l('HIDDEN', 0, { hiddenFrom: 'SOLD_OUT' }), 1)).toMatchObject({
      action: null,
      stockSoldOut: false,
    });
    expect(planRelease(l('HIDDEN', 0, { hiddenFrom: 'SOLD_OUT' }), 1).hiddenFrom).toBeUndefined();
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
