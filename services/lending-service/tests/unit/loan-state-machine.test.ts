import {
  LoanStatuses,
  TransactionStates,
  type LoanStatus,
  type TransactionState,
} from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  ActorRoles,
  availableCommands,
  decide,
  LoanCommands,
  loanStatusFor,
  marksReturn,
  mirrorTarget,
  type ActorRole,
  type LoanCommand,
  type TransitionFacts,
} from '../../src/domain/loan';

const now = new Date('2026-10-02T10:00:00.000Z');
const facts = (status: LoanStatus, over: Partial<TransitionFacts> = {}): TransitionFacts => ({
  status,
  returnBy: new Date(now.getTime() + 86_400_000),
  now,
  itemAvailable: true,
  ...over,
});

const outcome = (f: TransitionFacts, c: LoanCommand, r: ActorRole) => {
  try {
    return decide(f, c, r).to;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
};

/** Who may run each command and where it leads (only ever from REQUESTED). */
const SPEC: Record<LoanCommand, { actor: ActorRole; to: LoanStatus }> = {
  approve: { actor: 'LENDER', to: 'APPROVED' },
  decline: { actor: 'LENDER', to: 'DECLINED' },
  cancel: { actor: 'BORROWER', to: 'CANCELLED' },
  expire: { actor: 'SYSTEM', to: 'EXPIRED' },
};

describe('loan state machine (exhaustive)', () => {
  for (const status of LoanStatuses) {
    for (const command of LoanCommands) {
      for (const role of ActorRoles) {
        const spec = SPEC[command];
        const expected =
          role !== spec.actor
            ? 'FORBIDDEN'
            : status === 'REQUESTED'
              ? spec.to
              : 'INVALID_STATE_TRANSITION';
        it(`${status} --${command} by ${role}--> ${expected}`, () => {
          expect(outcome(facts(status), command, role)).toBe(expected);
        });
      }
    }
  }

  it('approval needs the item still on the shelf and the period not over', () => {
    expect(() => decide(facts('REQUESTED', { itemAvailable: false }), 'approve', 'LENDER')).toThrow(
      expect.objectContaining({ details: { rule: 'ITEM_NOT_AVAILABLE' } }),
    );
    expect(() =>
      decide(facts('REQUESTED', { returnBy: new Date(now.getTime() - 1) }), 'approve', 'LENDER'),
    ).toThrow(expect.objectContaining({ details: { rule: 'LOAN_PERIOD_PASSED' } }));
    // Declining is always possible.
    expect(decide(facts('REQUESTED', { itemAvailable: false }), 'decline', 'LENDER').to).toBe(
      'DECLINED',
    );
  });

  it('lists the commands each role can run right now', () => {
    expect(availableCommands(facts('REQUESTED'), 'LENDER')).toEqual(['approve', 'decline']);
    expect(availableCommands(facts('REQUESTED'), 'BORROWER')).toEqual(['cancel']);
    expect(availableCommands(facts('REQUESTED', { itemAvailable: false }), 'LENDER')).toEqual([
      'decline',
    ]);
    for (const s of LoanStatuses.filter((x) => x !== 'REQUESTED')) {
      for (const r of ActorRoles) expect(availableCommands(facts(s), r)).toEqual([]);
    }
  });
});

describe('transaction mirror (exhaustive)', () => {
  const MAP: Record<TransactionState, LoanStatus | null> = {
    CREATED: 'APPROVED',
    CONFIRMED: 'APPROVED',
    DELIVERY_PENDING: null,
    DELIVERED: null,
    HANDED_OVER: 'LENT',
    RETURN_REPORTED: 'RETURN_REPORTED',
    RETURNED: 'RETURNED',
    COMPLETED: 'CLOSED',
    CANCELLED: 'CANCELLED',
    DISPUTED: 'DISPUTED',
    REFUNDED: 'CANCELLED',
    EXPIRED: 'CANCELLED',
  };
  const DEAL: LoanStatus[] = ['APPROVED', 'LENT', 'RETURN_REPORTED', 'RETURNED', 'DISPUTED'];

  for (const tx of TransactionStates) {
    it(`transaction ${tx} ↦ loan ${MAP[tx] ?? '(ignored)'}`, () => {
      expect(loanStatusFor(tx)).toBe(MAP[tx]);
    });
  }

  for (const status of LoanStatuses) {
    for (const tx of TransactionStates) {
      const target = MAP[tx];
      const expected = DEAL.includes(status) && target && target !== status ? target : null;
      it(`loan ${status} + transaction ${tx} → ${expected ?? 'unchanged'}`, () => {
        expect(mirrorTarget(status, tx)).toBe(expected);
      });
    }
  }

  it('stamps the return on RETURN_REPORTED and RETURNED only', () => {
    expect(LoanStatuses.filter(marksReturn)).toEqual(['RETURN_REPORTED', 'RETURNED']);
  });
});
