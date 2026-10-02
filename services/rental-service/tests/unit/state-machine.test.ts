import { BookingStatuses, TransactionStates, type BookingStatus } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  ActorRoles,
  availableCommands,
  BookingCommands,
  decide,
  mirrorCommandFor,
  TERMINAL_STATUSES,
  type ActorRole,
  type BookingCommand,
  type TransitionFacts,
} from '../../src/domain/booking-state-machine';

const T0 = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

/** Hold open: deadline 15 minutes after T0, now = T0 + 1 min. */
const facts = (status: BookingStatus, over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  status,
  holdExpiresAt: status === 'HELD' || status === 'PENDING_APPROVAL' ? at(15 * MIN) : null,
  now: at(MIN),
  ...over,
});
/** Facts that satisfy the time guard of `command` (expire needs a lapsed hold). */
const satisfying = (status: BookingStatus, command: BookingCommand) =>
  command === 'expire' ? facts(status, { now: at(15 * MIN) }) : facts(status);

/** The specification, written independently of the implementation's table. */
const ALLOWED: Array<[BookingStatus, BookingCommand, ActorRole, BookingStatus]> = [
  ['HELD', 'confirm', 'RENTER', 'CONFIRMED'],
  ['PENDING_APPROVAL', 'approve', 'OWNER', 'CONFIRMED'],
  ['PENDING_APPROVAL', 'decline', 'OWNER', 'DECLINED'],
  ['HELD', 'cancel', 'RENTER', 'CANCELLED'],
  ['PENDING_APPROVAL', 'cancel', 'RENTER', 'CANCELLED'],
  ['HELD', 'expire', 'SYSTEM', 'EXPIRED'],
  ['PENDING_APPROVAL', 'expire', 'SYSTEM', 'EXPIRED'],
  ['CONFIRMED', 'mirror-handed-over', 'TRANSACTION', 'ACTIVE'],
  ['CONFIRMED', 'mirror-returned', 'TRANSACTION', 'RETURNED'],
  ['ACTIVE', 'mirror-returned', 'TRANSACTION', 'RETURNED'],
  ['CONFIRMED', 'mirror-completed', 'TRANSACTION', 'CLOSED'],
  ['ACTIVE', 'mirror-completed', 'TRANSACTION', 'CLOSED'],
  ['RETURNED', 'mirror-completed', 'TRANSACTION', 'CLOSED'],
  ['CONFIRMED', 'mirror-cancelled', 'TRANSACTION', 'CANCELLED'],
  ['ACTIVE', 'mirror-cancelled', 'TRANSACTION', 'CANCELLED'],
  ['RETURNED', 'mirror-cancelled', 'TRANSACTION', 'CANCELLED'],
];
const allowed = new Map(ALLOWED.map(([f, c, r, to]) => [`${f}|${c}|${r}`, to]));

describe('booking state machine: exhaustive table', () => {
  for (const status of BookingStatuses) {
    for (const command of BookingCommands) {
      for (const role of ActorRoles) {
        const expected = allowed.get(`${status}|${command}|${role}`);
        it(`${status} --${command}/${role}--> ${expected ?? 'rejected'}`, () => {
          const f = satisfying(status, command);
          if (expected) {
            expect(decide(f, command, role)).toEqual({ from: status, to: expected });
          } else {
            let err: unknown;
            try {
              decide(f, command, role);
            } catch (e) {
              err = e;
            }
            expect(err).toBeInstanceOf(AppError);
            expect(['FORBIDDEN', 'INVALID_STATE_TRANSITION']).toContain((err as AppError).code);
          }
        });
      }
    }
  }

  it('terminal statuses accept no command from anyone', () => {
    for (const status of TERMINAL_STATUSES) {
      for (const role of ActorRoles) {
        expect(availableCommands(facts(status, { now: at(60 * MIN) }), role)).toEqual([]);
      }
    }
  });

  it('403 for a role that can never run the command, 409 for a wrong status', () => {
    expect(() => decide(facts('HELD'), 'confirm', 'OWNER')).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(() => decide(facts('CONFIRMED'), 'confirm', 'RENTER')).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
    // A renter cannot cancel a confirmed booking here: that goes through the transaction.
    expect(() => decide(facts('CONFIRMED'), 'cancel', 'RENTER')).toThrow(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }),
    );
  });
});

describe('time guards', () => {
  it('confirm and approve close at the deadline (exclusive)', () => {
    const lapsed = { now: at(15 * MIN) };
    expect(() => decide(facts('HELD', lapsed), 'confirm', 'RENTER')).toThrow(
      expect.objectContaining({
        code: 'BUSINESS_RULE_VIOLATION',
        details: { rule: 'HOLD_EXPIRED' },
      }),
    );
    expect(() => decide(facts('PENDING_APPROVAL', lapsed), 'approve', 'OWNER')).toThrow(
      expect.objectContaining({ details: { rule: 'APPROVAL_WINDOW_CLOSED' } }),
    );
    expect(decide(facts('HELD', { now: at(15 * MIN - 1) }), 'confirm', 'RENTER').to).toBe(
      'CONFIRMED',
    );
  });

  it('expire only once the deadline has passed', () => {
    expect(() => decide(facts('HELD'), 'expire', 'SYSTEM')).toThrow(
      expect.objectContaining({ details: { rule: 'HOLD_OPEN' } }),
    );
    expect(decide(facts('PENDING_APPROVAL', { now: at(15 * MIN) }), 'expire', 'SYSTEM').to).toBe(
      'EXPIRED',
    );
  });

  it('cancel and decline are allowed even after the deadline (until the job expires it)', () => {
    const lapsed = { now: at(20 * MIN) };
    expect(decide(facts('HELD', lapsed), 'cancel', 'RENTER').to).toBe('CANCELLED');
    expect(decide(facts('PENDING_APPROVAL', lapsed), 'decline', 'OWNER').to).toBe('DECLINED');
  });
});

describe('available actions', () => {
  it('drive the UI per role', () => {
    expect(availableCommands(facts('HELD'), 'RENTER')).toEqual(['confirm', 'cancel']);
    expect(availableCommands(facts('HELD'), 'OWNER')).toEqual([]);
    expect(availableCommands(facts('PENDING_APPROVAL'), 'OWNER')).toEqual(['approve', 'decline']);
    expect(availableCommands(facts('PENDING_APPROVAL'), 'RENTER')).toEqual(['cancel']);
    expect(availableCommands(facts('HELD', { now: at(15 * MIN) }), 'RENTER')).toEqual(['cancel']);
    expect(availableCommands(facts('CONFIRMED'), 'RENTER')).toEqual([]);
    expect(availableCommands(facts('CONFIRMED'), 'OWNER')).toEqual([]);
  });
});

describe('transaction mirror mapping', () => {
  it('maps every transaction state', () => {
    const map = Object.fromEntries(TransactionStates.map((s) => [s, mirrorCommandFor(s)]));
    expect(map).toEqual({
      CREATED: null,
      CONFIRMED: null,
      DELIVERY_PENDING: null,
      DELIVERED: null,
      HANDED_OVER: 'mirror-handed-over',
      RETURN_REPORTED: null,
      RETURNED: 'mirror-returned',
      COMPLETED: 'mirror-completed',
      CANCELLED: 'mirror-cancelled',
      DISPUTED: null,
      REFUNDED: 'mirror-cancelled',
      EXPIRED: 'mirror-cancelled',
    });
  });
});
