import {
  NeedModes,
  TransactionStates,
  type NeedMode,
  type TransactionState,
} from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import { depositOutcome, policyFrom } from '../../src/domain/transaction';
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
const policy = policyFrom({
  confirmTtlHours: 48,
  autoCompleteDays: 3,
  disputeWindowDays: 3,
  returnCompleteHours: 24,
});
const T0 = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const facts = (state: TransactionState, over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  state,
  mode: 'BUY',
  sourceType: 'OFFER',
  buyerConfirmedAt: null,
  sellerConfirmedAt: null,
  createdAt: T0,
  deliveredAt: state === 'DELIVERED' ? at(HOUR) : null,
  returnedAt: state === 'RETURNED' ? at(HOUR) : null,
  preDisputeState: null,
  refundable: false,
  now: at(2 * HOUR),
  policy,
  ...over,
});

const RETURN_MODES: readonly NeedMode[] = ['RENT', 'BORROW'];
const isReturnMode = (m: NeedMode) => RETURN_MODES.includes(m);

/** Facts that satisfy the time/source/payment guards of the system and admin commands. */
const satisfying = (mode: NeedMode, state: TransactionState, command: TransactionCommand) => {
  const base = { mode };
  switch (command) {
    case 'expire':
      return facts(state, { ...base, now: at(49 * HOUR) });
    case 'auto-complete':
      return facts(state, { ...base, now: at(HOUR + 3 * DAY) });
    case 'auto-confirm':
      return facts(state, { ...base, sourceType: isReturnMode(mode) ? 'BOOKING' : 'LOAN' });
    case 'resolve-refund':
      return facts(state, { ...base, refundable: true });
    case 'withdraw-dispute':
      return facts(state, {
        ...base,
        preDisputeState: isReturnMode(mode) ? 'HANDED_OVER' : 'DELIVERED',
      });
    default:
      return facts(state, base);
  }
};

type Row = [TransactionState, TransactionCommand, ActorRole, TransactionState];

/** The specification, written independently of the implementation's table. */
const COMMON: Row[] = [
  ['CREATED', 'confirm', 'BUYER', 'CREATED'],
  ['CREATED', 'confirm', 'SELLER', 'CREATED'],
  ['CREATED', 'auto-confirm', 'SYSTEM', 'CONFIRMED'],
  ['CREATED', 'cancel', 'BUYER', 'CANCELLED'],
  ['CREATED', 'cancel', 'SELLER', 'CANCELLED'],
  ['CONFIRMED', 'cancel', 'BUYER', 'CANCELLED'],
  ['CONFIRMED', 'cancel', 'SELLER', 'CANCELLED'],
  ['CREATED', 'expire', 'SYSTEM', 'EXPIRED'],
  ['DISPUTED', 'resolve-release', 'ADMIN', 'COMPLETED'],
  ['DISPUTED', 'resolve-cancel', 'ADMIN', 'CANCELLED'],
  ['DISPUTED', 'resolve-refund', 'ADMIN', 'REFUNDED'],
];

/** BUY / HIRE / SOURCE. */
const DELIVERY: Row[] = [
  ...COMMON,
  ['CONFIRMED', 'arrange-delivery', 'BUYER', 'DELIVERY_PENDING'],
  ['CONFIRMED', 'arrange-delivery', 'SELLER', 'DELIVERY_PENDING'],
  ['DELIVERY_PENDING', 'mark-delivered', 'SELLER', 'DELIVERED'],
  ['DELIVERED', 'confirm-receipt', 'BUYER', 'COMPLETED'],
  ['DELIVERED', 'auto-complete', 'SYSTEM', 'COMPLETED'],
  ['DELIVERY_PENDING', 'dispute', 'BUYER', 'DISPUTED'],
  ['DELIVERY_PENDING', 'dispute', 'SELLER', 'DISPUTED'],
  ['DELIVERED', 'dispute', 'BUYER', 'DISPUTED'],
  ['DELIVERED', 'dispute', 'SELLER', 'DISPUTED'],
  ['DISPUTED', 'withdraw-dispute', 'SYSTEM', 'DELIVERED'],
];

/** RENT / BORROW: SELLER = owner/lender, BUYER = renter/borrower. */
const RETURN: Row[] = [
  ...COMMON,
  ['CONFIRMED', 'hand-over', 'SELLER', 'HANDED_OVER'],
  ['HANDED_OVER', 'report-return', 'BUYER', 'RETURN_REPORTED'],
  ['RETURN_REPORTED', 'confirm-return', 'SELLER', 'RETURNED'],
  ['HANDED_OVER', 'confirm-return', 'SELLER', 'RETURNED'],
  ['RETURNED', 'complete', 'SELLER', 'COMPLETED'],
  ['RETURNED', 'auto-complete', 'SYSTEM', 'COMPLETED'],
  ['HANDED_OVER', 'dispute', 'BUYER', 'DISPUTED'],
  ['HANDED_OVER', 'dispute', 'SELLER', 'DISPUTED'],
  ['RETURN_REPORTED', 'dispute', 'BUYER', 'DISPUTED'],
  ['RETURN_REPORTED', 'dispute', 'SELLER', 'DISPUTED'],
  ['RETURNED', 'dispute', 'SELLER', 'DISPUTED'],
  ['DISPUTED', 'withdraw-dispute', 'SYSTEM', 'HANDED_OVER'],
];

const ACTORS_OF: Record<TransactionCommand, ActorRole[]> = {
  confirm: ['BUYER', 'SELLER'],
  'auto-confirm': ['SYSTEM'],
  cancel: ['BUYER', 'SELLER'],
  expire: ['SYSTEM'],
  'arrange-delivery': ['BUYER', 'SELLER'],
  'mark-delivered': ['SELLER'],
  'confirm-receipt': ['BUYER'],
  'hand-over': ['SELLER'],
  'report-return': ['BUYER'],
  'confirm-return': ['SELLER'],
  complete: ['SELLER'],
  'auto-complete': ['SYSTEM'],
  dispute: ['BUYER', 'SELLER'],
  'resolve-release': ['ADMIN'],
  'resolve-cancel': ['ADMIN'],
  'resolve-refund': ['ADMIN'],
  'withdraw-dispute': ['SYSTEM'],
};

const DELIVERY_ONLY: TransactionCommand[] = [
  'arrange-delivery',
  'mark-delivered',
  'confirm-receipt',
];
const RETURN_ONLY: TransactionCommand[] = [
  'hand-over',
  'report-return',
  'confirm-return',
  'complete',
];
const appliesToMode = (mode: NeedMode, c: TransactionCommand) =>
  isReturnMode(mode) ? !DELIVERY_ONLY.includes(c) : !RETURN_ONLY.includes(c);

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
};

function expectedError(
  mode: NeedMode,
  state: TransactionState,
  c: TransactionCommand,
  r: ActorRole,
) {
  if (!ACTORS_OF[c].includes(r)) return 'FORBIDDEN';
  if (!appliesToMode(mode, c)) return 'BUSINESS_RULE_VIOLATION';
  const spec = isReturnMode(mode) ? RETURN : DELIVERY;
  // The state allows the command, just not for this party (e.g. a renter's damage claim).
  if (spec.some(([s, cmd]) => s === state && cmd === c)) return 'FORBIDDEN';
  return 'INVALID_STATE_TRANSITION';
}

describe.each(NeedModes.map((mode) => ({ mode })))(
  'transition table for $mode (every state × command × actor)',
  ({ mode }) => {
    const spec = isReturnMode(mode) ? RETURN : DELIVERY;
    const cases = TransactionStates.flatMap((state) =>
      TransactionCommands.flatMap((command) =>
        ActorRoles.map((role) => ({ state, command, role })),
      ),
    );

    it.each(cases)('$state --$command($role)', ({ state, command, role }) => {
      const allowed = spec.find(([s, c, r]) => s === state && c === command && r === role);
      const f = satisfying(mode, state, command);
      if (allowed) {
        expect(decide(f, command, role)).toEqual({ from: state, to: allowed[3] });
      } else {
        expect(codeOf(() => decide(f, command, role))).toBe(
          expectedError(mode, state, command, role),
        );
      }
    });

    it('has no way out of terminal states', () => {
      for (const s of TERMINAL_STATES)
        for (const role of ActorRoles)
          expect(availableCommands(facts(s, { mode, refundable: true }), role)).toEqual([]);
    });
  },
);

describe('mode guards', () => {
  const ruleOf = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (err) {
      return (err as AppError).details?.['rule'] ?? null;
    }
  };

  it('has no hand-over or return on delivered deals', () => {
    for (const mode of ['BUY', 'HIRE', 'SOURCE'] as const) {
      expect(ruleOf(() => decide(facts('CONFIRMED', { mode }), 'hand-over', 'SELLER'))).toBe(
        'NOT_FOR_MODE',
      );
      expect(ruleOf(() => decide(facts('CONFIRMED', { mode }), 'complete', 'SELLER'))).toBe(
        'NOT_FOR_MODE',
      );
      expect(availableCommands(facts('CONFIRMED', { mode }), 'SELLER')).toEqual([
        'cancel',
        'arrange-delivery',
      ]);
    }
  });

  it('has no delivery on rentals and loans', () => {
    for (const mode of ['RENT', 'BORROW'] as const) {
      expect(ruleOf(() => decide(facts('CONFIRMED', { mode }), 'arrange-delivery', 'BUYER'))).toBe(
        'NOT_FOR_MODE',
      );
      expect(ruleOf(() => decide(facts('HANDED_OVER', { mode }), 'mark-delivered', 'SELLER'))).toBe(
        'NOT_FOR_MODE',
      );
      expect(ruleOf(() => decide(facts('HANDED_OVER', { mode }), 'confirm-receipt', 'BUYER'))).toBe(
        'NOT_FOR_MODE',
      );
      expect(availableCommands(facts('CONFIRMED', { mode }), 'SELLER')).toEqual([
        'cancel',
        'hand-over',
      ]);
      expect(availableCommands(facts('CONFIRMED', { mode }), 'BUYER')).toEqual(['cancel']);
    }
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

  it('auto-confirms only bookings and loans (agreed in their own service)', () => {
    for (const sourceType of ['BOOKING', 'LOAN'] as const)
      expect(decide(facts('CREATED', { sourceType }), 'auto-confirm', 'SYSTEM').to).toBe(
        'CONFIRMED',
      );
    for (const sourceType of ['OFFER', 'LISTING', 'AUCTION'] as const)
      expect(() => decide(facts('CREATED', { sourceType }), 'auto-confirm', 'SYSTEM')).toThrow(
        expect.objectContaining({ details: { rule: 'CONFIRMATION_REQUIRED' } }),
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

  it('allows disputes while a rental is out or its return is reported, regardless of time', () => {
    for (const state of ['HANDED_OVER', 'RETURN_REPORTED'] as const)
      for (const role of ['BUYER', 'SELLER'] as const)
        expect(decide(facts(state, { mode: 'RENT', now: at(365 * DAY) }), 'dispute', role).to).toBe(
          'DISPUTED',
        );
  });
});

describe('damage-claim window after a return (RENT / BORROW)', () => {
  const returned = at(HOUR);
  const f = (now: number, mode: NeedMode = 'RENT') =>
    facts('RETURNED', { mode, returnedAt: returned, now: at(now) });

  it('lets the owner claim damage up to the end of the window, never the renter', () => {
    expect(decide(f(HOUR + DAY), 'dispute', 'SELLER').to).toBe('DISPUTED');
    expect(decide(f(HOUR + DAY, 'BORROW'), 'dispute', 'SELLER').to).toBe('DISPUTED');
    expect(() => decide(f(HOUR + DAY + 1), 'dispute', 'SELLER')).toThrow(
      expect.objectContaining({ details: { rule: 'DAMAGE_CLAIM_WINDOW_CLOSED' } }),
    );
    expect(codeOf(() => decide(f(2 * HOUR), 'dispute', 'BUYER'))).toBe('FORBIDDEN');
    expect(availableCommands(f(2 * HOUR), 'SELLER')).toEqual(['complete', 'dispute']);
    expect(availableCommands(f(HOUR + DAY + 1), 'SELLER')).toEqual(['complete']);
    expect(availableCommands(f(2 * HOUR), 'BUYER')).toEqual([]);
  });

  it('auto-completes only once the window has passed', () => {
    expect(() => decide(f(HOUR + DAY - 1), 'auto-complete', 'SYSTEM')).toThrow(
      expect.objectContaining({ details: { rule: 'COMPLETION_WINDOW_OPEN' } }),
    );
    expect(decide(f(HOUR + DAY), 'auto-complete', 'SYSTEM').to).toBe('COMPLETED');
  });
});

describe('dispute outcomes', () => {
  it('refunds only when the payment provider can refund', () => {
    expect(() => decide(facts('DISPUTED'), 'resolve-refund', 'ADMIN')).toThrow(
      expect.objectContaining({ details: { rule: 'REFUND_NOT_SUPPORTED' } }),
    );
    expect(decide(facts('DISPUTED', { refundable: true }), 'resolve-refund', 'ADMIN').to).toBe(
      'REFUNDED',
    );
  });

  it('restores whatever state the deal was in before the dispute', () => {
    for (const pre of [
      'DELIVERY_PENDING',
      'DELIVERED',
      'HANDED_OVER',
      'RETURN_REPORTED',
      'RETURNED',
    ] as const) {
      const f = facts('DISPUTED', { preDisputeState: pre });
      expect(decide(f, 'withdraw-dispute', 'SYSTEM')).toEqual({ from: 'DISPUTED', to: pre });
    }
    expect(() => decide(facts('DISPUTED'), 'withdraw-dispute', 'SYSTEM')).toThrow(
      expect.objectContaining({ details: { rule: 'NO_PRE_DISPUTE_STATE' } }),
    );
  });

  it('offers no dispute outcome to the parties', () => {
    expect(availableCommands(facts('DISPUTED'), 'BUYER')).toEqual([]);
    expect(availableCommands(facts('DISPUTED'), 'SELLER')).toEqual([]);
  });
});

describe('actions per viewer', () => {
  it('lists what each party can do now (delivery)', () => {
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

  it('lists what each party can do now (return)', () => {
    const rent = (s: TransactionState) => facts(s, { mode: 'RENT' });
    expect(availableCommands(rent('HANDED_OVER'), 'BUYER')).toEqual(['report-return', 'dispute']);
    expect(availableCommands(rent('HANDED_OVER'), 'SELLER')).toEqual(['confirm-return', 'dispute']);
    expect(availableCommands(rent('RETURN_REPORTED'), 'BUYER')).toEqual(['dispute']);
    expect(availableCommands(rent('RETURN_REPORTED'), 'SELLER')).toEqual([
      'confirm-return',
      'dispute',
    ]);
  });
});

describe('transition patch', () => {
  const p = (
    command: TransactionCommand,
    role: ActorRole,
    from: TransactionState,
    to: TransactionState,
    input: Parameters<typeof transitionPatch>[3] = {},
  ) => transitionPatch(command, role, { from, to }, input);

  it('records who confirmed, delivery and completion times, and reasons', () => {
    expect(p('confirm', 'BUYER', 'CREATED', 'CREATED')).toEqual({ buyerConfirmedAt: true });
    expect(p('confirm', 'SELLER', 'CREATED', 'CONFIRMED')).toEqual({ sellerConfirmedAt: true });
    expect(p('auto-confirm', 'SYSTEM', 'CREATED', 'CONFIRMED')).toEqual({
      buyerConfirmedAt: true,
      sellerConfirmedAt: true,
    });
    expect(p('mark-delivered', 'SELLER', 'DELIVERY_PENDING', 'DELIVERED')).toEqual({
      deliveredAt: true,
    });
    expect(p('confirm-receipt', 'BUYER', 'DELIVERED', 'COMPLETED')).toEqual({ completedAt: true });
    expect(p('resolve-release', 'ADMIN', 'DISPUTED', 'COMPLETED', { reason: 'ok' })).toEqual({
      completedAt: true,
    });
    expect(p('cancel', 'BUYER', 'CREATED', 'CANCELLED', { reason: 'changed mind' })).toEqual({
      cancelReason: 'changed mind',
    });
    expect(p('resolve-cancel', 'ADMIN', 'DISPUTED', 'CANCELLED', { reason: 'fraud' })).toEqual({
      cancelReason: 'fraud',
    });
    expect(p('expire', 'SYSTEM', 'CREATED', 'EXPIRED')).toEqual({});
    expect(p('withdraw-dispute', 'SYSTEM', 'DISPUTED', 'DELIVERED')).toEqual({});
  });

  it('records the hand-over and return times', () => {
    expect(p('hand-over', 'SELLER', 'CONFIRMED', 'HANDED_OVER')).toEqual({ handedOverAt: true });
    expect(p('report-return', 'BUYER', 'HANDED_OVER', 'RETURN_REPORTED')).toEqual({
      returnReportedAt: true,
    });
    expect(p('confirm-return', 'SELLER', 'HANDED_OVER', 'RETURNED')).toEqual({ returnedAt: true });
    expect(p('complete', 'SELLER', 'RETURNED', 'COMPLETED')).toEqual({ completedAt: true });
  });

  it('records the dispute reason, category and the state to restore', () => {
    expect(
      p('dispute', 'BUYER', 'DELIVERED', 'DISPUTED', { reason: 'broken', category: 'DAMAGED' }),
    ).toEqual({
      disputeReason: 'broken',
      disputeCategory: 'DAMAGED',
      preDisputeState: 'DELIVERED',
    });
    expect(p('dispute', 'SELLER', 'RETURNED', 'DISPUTED', { reason: 'scratched' })).toEqual({
      disputeReason: 'scratched',
      disputeCategory: 'OTHER',
      preDisputeState: 'RETURNED',
    });
  });
});

describe('deposit outcome', () => {
  it('returns the deposit on completion and when the deal does not go ahead', () => {
    expect(depositOutcome('COMPLETED', 'complete', null)?.status).toBe('RETURNED');
    expect(depositOutcome('COMPLETED', 'auto-complete', null)?.status).toBe('RETURNED');
    expect(depositOutcome('COMPLETED', 'resolve-release', 'BUYER')?.status).toBe('RETURNED');
    expect(depositOutcome('CANCELLED', 'resolve-cancel', null)?.status).toBe('RETURNED');
    expect(depositOutcome('CANCELLED', 'cancel', null)?.status).toBe('RETURNED');
    expect(depositOutcome('REFUNDED', 'resolve-refund', null)?.status).toBe('RETURNED');
  });

  it('lets the owner keep it when their claim is upheld; no change mid-deal', () => {
    expect(depositOutcome('COMPLETED', 'resolve-release', 'SELLER')?.status).toBe('FORFEITED');
    expect(depositOutcome('HANDED_OVER', 'hand-over', null)).toBeNull();
    expect(depositOutcome('DISPUTED', 'dispute', null)).toBeNull();
    expect(depositOutcome('RETURNED', 'withdraw-dispute', null)).toBeNull();
  });
});
