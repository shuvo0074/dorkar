import { TransactionStates, type TransactionState } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import { policyFrom } from '../../src/domain/transaction';
import {
  ActorRoles,
  availableCommands,
  decide,
  TERMINAL_STATES,
  TransactionCommands,
  transitionPatch,
  type ActorRole,
  type TransactionCommand,
  type TransitionFacts,
} from '../../src/domain/transaction-state-machine';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const policy = policyFrom({ confirmTtlHours: 48, autoCompleteDays: 3, disputeWindowDays: 3 });
const T0 = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const facts = (state: TransactionState, over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  state,
  buyerConfirmedAt: null,
  sellerConfirmedAt: null,
  createdAt: T0,
  deliveredAt: state === 'DELIVERED' ? at(HOUR) : null,
  now: at(2 * HOUR),
  policy,
  ...over,
});

/** Facts that satisfy the time-based guards of the system commands. */
const satisfying = (state: TransactionState, command: TransactionCommand) =>
  command === 'expire'
    ? facts(state, { now: at(49 * HOUR) })
    : command === 'auto-complete'
      ? facts(state, { now: at(HOUR + 3 * DAY) })
      : facts(state);

/** The specification, written independently of the implementation's table. */
const ALLOWED: Array<[TransactionState, TransactionCommand, ActorRole, TransactionState]> = [
  ['CREATED', 'confirm', 'BUYER', 'CREATED'],
  ['CREATED', 'confirm', 'SELLER', 'CREATED'],
  ['CREATED', 'cancel', 'BUYER', 'CANCELLED'],
  ['CREATED', 'cancel', 'SELLER', 'CANCELLED'],
  ['CONFIRMED', 'cancel', 'BUYER', 'CANCELLED'],
  ['CONFIRMED', 'cancel', 'SELLER', 'CANCELLED'],
  ['CREATED', 'expire', 'SYSTEM', 'EXPIRED'],
  ['CONFIRMED', 'arrange-delivery', 'BUYER', 'DELIVERY_PENDING'],
  ['CONFIRMED', 'arrange-delivery', 'SELLER', 'DELIVERY_PENDING'],
  ['DELIVERY_PENDING', 'mark-delivered', 'SELLER', 'DELIVERED'],
  ['DELIVERED', 'confirm-receipt', 'BUYER', 'COMPLETED'],
  ['DELIVERED', 'auto-complete', 'SYSTEM', 'COMPLETED'],
  ['DELIVERY_PENDING', 'dispute', 'BUYER', 'DISPUTED'],
  ['DELIVERY_PENDING', 'dispute', 'SELLER', 'DISPUTED'],
  ['DELIVERED', 'dispute', 'BUYER', 'DISPUTED'],
  ['DELIVERED', 'dispute', 'SELLER', 'DISPUTED'],
  ['DISPUTED', 'resolve-release', 'ADMIN', 'COMPLETED'],
  ['DISPUTED', 'resolve-cancel', 'ADMIN', 'CANCELLED'],
];

const ACTORS_OF: Record<TransactionCommand, ActorRole[]> = {
  confirm: ['BUYER', 'SELLER'],
  cancel: ['BUYER', 'SELLER'],
  expire: ['SYSTEM'],
  'arrange-delivery': ['BUYER', 'SELLER'],
  'mark-delivered': ['SELLER'],
  'confirm-receipt': ['BUYER'],
  'auto-complete': ['SYSTEM'],
  dispute: ['BUYER', 'SELLER'],
  'resolve-release': ['ADMIN'],
  'resolve-cancel': ['ADMIN'],
};

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
};

describe('transition table (every state × command × actor)', () => {
  const cases = TransactionStates.flatMap((state) =>
    TransactionCommands.flatMap((command) => ActorRoles.map((role) => ({ state, command, role }))),
  );

  it.each(cases)('$state --$command($role)', ({ state, command, role }) => {
    const allowed = ALLOWED.find(([s, c, r]) => s === state && c === command && r === role);
    const f = satisfying(state, command);
    if (allowed) {
      expect(decide(f, command, role)).toEqual({ from: state, to: allowed[3] });
    } else {
      expect(codeOf(() => decide(f, command, role))).toBe(
        ACTORS_OF[command].includes(role) ? 'INVALID_STATE_TRANSITION' : 'FORBIDDEN',
      );
    }
  });

  it('has no way out of terminal states', () => {
    for (const s of TERMINAL_STATES)
      for (const role of ActorRoles) expect(availableCommands(facts(s), role)).toEqual([]);
  });

  it('reserves REFUNDED for non-cash providers (nothing reaches it yet)', () => {
    expect(ALLOWED.some(([, , , to]) => to === 'REFUNDED')).toBe(false);
  });
});

describe('two-party confirmation', () => {
  it('stays CREATED after the first confirmation and becomes CONFIRMED after the second', () => {
    expect(decide(facts('CREATED'), 'confirm', 'BUYER').to).toBe('CREATED');
    expect(decide(facts('CREATED', { buyerConfirmedAt: T0 }), 'confirm', 'SELLER').to).toBe(
      'CONFIRMED',
    );
    expect(decide(facts('CREATED', { sellerConfirmedAt: T0 }), 'confirm', 'BUYER').to).toBe(
      'CONFIRMED',
    );
  });

  it('refuses a second confirmation by the same party', () => {
    const f = facts('CREATED', { buyerConfirmedAt: T0 });
    expect(() => decide(f, 'confirm', 'BUYER')).toThrow(
      expect.objectContaining({
        code: 'INVALID_STATE_TRANSITION',
        details: { rule: 'ALREADY_CONFIRMED' },
      }),
    );
    expect(availableCommands(f, 'BUYER')).toEqual(['cancel']);
    expect(availableCommands(f, 'SELLER')).toEqual(['confirm', 'cancel']);
  });

  it('closes confirmation when the TTL has passed', () => {
    const late = facts('CREATED', { now: at(48 * HOUR) });
    expect(() => decide(late, 'confirm', 'SELLER')).toThrow(
      expect.objectContaining({ details: { rule: 'CONFIRMATION_WINDOW_CLOSED' } }),
    );
    expect(decide(facts('CREATED', { now: at(48 * HOUR - 1) }), 'confirm', 'SELLER').to).toBe(
      'CREATED',
    );
  });
});

describe('time guards', () => {
  it('expires only after the confirmation TTL', () => {
    expect(codeOf(() => decide(facts('CREATED', { now: at(47 * HOUR) }), 'expire', 'SYSTEM'))).toBe(
      'BUSINESS_RULE_VIOLATION',
    );
    expect(decide(facts('CREATED', { now: at(48 * HOUR) }), 'expire', 'SYSTEM').to).toBe('EXPIRED');
  });

  it('auto-completes only after the completion window from delivery', () => {
    const delivered = at(HOUR);
    const before = facts('DELIVERED', { deliveredAt: delivered, now: at(HOUR + 3 * DAY - 1) });
    expect(() => decide(before, 'auto-complete', 'SYSTEM')).toThrow(
      expect.objectContaining({ details: { rule: 'COMPLETION_WINDOW_OPEN' } }),
    );
    const after = facts('DELIVERED', { deliveredAt: delivered, now: at(HOUR + 3 * DAY) });
    expect(decide(after, 'auto-complete', 'SYSTEM').to).toBe('COMPLETED');
  });

  it('allows disputes up to the end of the dispute window after delivery', () => {
    const delivered = at(HOUR);
    const edge = facts('DELIVERED', { deliveredAt: delivered, now: at(HOUR + 3 * DAY) });
    expect(decide(edge, 'dispute', 'BUYER').to).toBe('DISPUTED');
    const late = facts('DELIVERED', { deliveredAt: delivered, now: at(HOUR + 3 * DAY + 1) });
    expect(() => decide(late, 'dispute', 'BUYER')).toThrow(
      expect.objectContaining({ details: { rule: 'DISPUTE_WINDOW_CLOSED' } }),
    );
    expect(availableCommands(late, 'BUYER')).toEqual(['confirm-receipt']);
  });

  it('allows disputes while delivery is pending regardless of time', () => {
    const f = facts('DELIVERY_PENDING', { now: at(365 * DAY) });
    expect(decide(f, 'dispute', 'SELLER').to).toBe('DISPUTED');
  });
});

describe('actions per viewer', () => {
  it('lists what each party can do now', () => {
    expect(availableCommands(facts('CONFIRMED'), 'BUYER')).toEqual(['cancel', 'arrange-delivery']);
    expect(availableCommands(facts('DELIVERY_PENDING'), 'SELLER')).toEqual([
      'mark-delivered',
      'dispute',
    ]);
    expect(availableCommands(facts('DELIVERED'), 'BUYER')).toEqual(['confirm-receipt', 'dispute']);
    expect(availableCommands(facts('DISPUTED'), 'ADMIN')).toEqual([
      'resolve-release',
      'resolve-cancel',
    ]);
    expect(availableCommands(facts('CREATED'), 'SYSTEM')).toEqual([]);
  });
});

describe('transition patch', () => {
  it('records who confirmed, delivery and completion times, and reasons', () => {
    expect(transitionPatch('confirm', 'BUYER', 'CREATED', null)).toEqual({
      buyerConfirmedAt: true,
    });
    expect(transitionPatch('confirm', 'SELLER', 'CONFIRMED', null)).toEqual({
      sellerConfirmedAt: true,
    });
    expect(transitionPatch('mark-delivered', 'SELLER', 'DELIVERED', null)).toEqual({
      deliveredAt: true,
    });
    expect(transitionPatch('confirm-receipt', 'BUYER', 'COMPLETED', null)).toEqual({
      completedAt: true,
    });
    expect(transitionPatch('resolve-release', 'ADMIN', 'COMPLETED', 'ok')).toEqual({
      completedAt: true,
    });
    expect(transitionPatch('cancel', 'BUYER', 'CANCELLED', 'changed mind')).toEqual({
      cancelReason: 'changed mind',
    });
    expect(transitionPatch('resolve-cancel', 'ADMIN', 'CANCELLED', 'fraud')).toEqual({
      cancelReason: 'fraud',
    });
    expect(transitionPatch('dispute', 'BUYER', 'DISPUTED', 'broken')).toEqual({
      disputeReason: 'broken',
    });
    expect(transitionPatch('expire', 'SYSTEM', 'EXPIRED', null)).toEqual({});
  });
});
