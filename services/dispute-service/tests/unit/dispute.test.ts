import { DisputeStatuses, type DisputeStatus } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  assertEvidenceNotEmpty,
  assertNoContactInfo,
  assertNotOwnDispute,
  assertResolutionSupported,
  available,
  CaseActors,
  decide,
  DisputeCommands,
  openerOf,
  PROVIDER_CAPABILITIES,
  type CaseActor,
  type DisputeCommand,
} from '../../src/domain/dispute';

/** The whole machine, written out independently of RULES. */
const EXPECTED: Record<string, DisputeStatus> = {
  'AWAITING_RESPONSE|submit-statement|RESPONDENT': 'UNDER_REVIEW',
  'UNDER_REVIEW|submit-statement|RESPONDENT': 'UNDER_REVIEW',
  'AWAITING_RESPONSE|respondent-deadline|SYSTEM': 'UNDER_REVIEW',
  'AWAITING_RESPONSE|resolve|STAFF': 'RESOLVED',
  'UNDER_REVIEW|resolve|STAFF': 'RESOLVED',
  'AWAITING_RESPONSE|withdraw|OPENER': 'WITHDRAWN',
  'UNDER_REVIEW|withdraw|OPENER': 'WITHDRAWN',
  'AWAITING_RESPONSE|close-without-decision|SYSTEM': 'WITHDRAWN',
  'UNDER_REVIEW|close-without-decision|SYSTEM': 'WITHDRAWN',
};

/** Actors allowed to run a command in some status (otherwise 403 regardless of status). */
const ACTORS: Record<DisputeCommand, CaseActor[]> = {
  'submit-statement': ['RESPONDENT'],
  'respondent-deadline': ['SYSTEM'],
  resolve: ['STAFF'],
  withdraw: ['OPENER'],
  'close-without-decision': ['SYSTEM'],
};

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof AppError ? e.code : 'UNEXPECTED';
  }
};

describe('dispute status machine', () => {
  for (const status of DisputeStatuses) {
    for (const command of DisputeCommands) {
      for (const actor of CaseActors) {
        const key = `${status}|${command}|${actor}`;
        it(key, () => {
          const f = { status, statementSubmitted: false };
          const to = EXPECTED[key];
          if (to) {
            expect(decide(f, command, actor)).toEqual({ from: status, to });
          } else if (!ACTORS[command].includes(actor)) {
            expect(codeOf(() => decide(f, command, actor))).toBe('FORBIDDEN');
          } else {
            expect(codeOf(() => decide(f, command, actor))).toBe('INVALID_STATE_TRANSITION');
          }
        });
      }
    }
  }

  it('accepts one statement only', () => {
    for (const status of ['AWAITING_RESPONSE', 'UNDER_REVIEW'] as const) {
      expect(() =>
        decide({ status, statementSubmitted: true }, 'submit-statement', 'RESPONDENT'),
      ).toThrow(/already submitted/);
    }
  });

  it('final statuses offer nothing to anyone', () => {
    for (const status of ['RESOLVED', 'WITHDRAWN', 'OPEN'] as const) {
      for (const actor of CaseActors) {
        expect(available({ status, statementSubmitted: false }, actor)).toEqual([]);
      }
    }
  });

  it('lists available commands per actor', () => {
    const f = { status: 'AWAITING_RESPONSE' as const, statementSubmitted: false };
    expect(available(f, 'RESPONDENT')).toEqual(['submit-statement']);
    expect(available(f, 'OPENER')).toEqual(['withdraw']);
    expect(available(f, 'STAFF')).toEqual(['resolve']);
    expect(
      available({ ...f, status: 'UNDER_REVIEW', statementSubmitted: true }, 'RESPONDENT'),
    ).toEqual([]);
  });
});

describe('dispute rules', () => {
  it('refuses refunds for cash and allows release/cancel', () => {
    expect(PROVIDER_CAPABILITIES.CASH.refunds).toBe(false);
    expect(() => assertResolutionSupported('REFUND', 'CASH')).toThrow(/cash/);
    try {
      assertResolutionSupported('REFUND', 'CASH');
    } catch (e) {
      expect((e as AppError).details).toMatchObject({ rule: 'REFUND_NOT_SUPPORTED' });
    }
    expect(() => assertResolutionSupported('RELEASE', 'CASH')).not.toThrow();
    expect(() => assertResolutionSupported('CANCEL', 'CASH')).not.toThrow();
  });

  it('blocks contact details in party text', () => {
    expect(() => assertNoContactInfo('evidence', 'call me 01712345678')).toThrow(/phone/);
    expect(() => assertNoContactInfo('evidence', 'mail a@b.com')).toThrow(/email/);
    expect(() => assertNoContactInfo('evidence', 'the box was crushed')).not.toThrow();
  });

  it('needs text or media for evidence', () => {
    expect(() => assertEvidenceNotEmpty(null, [])).toThrow();
    expect(() => assertEvidenceNotEmpty('photo attached', [])).not.toThrow();
    expect(() => assertEvidenceNotEmpty(null, ['m'])).not.toThrow();
  });

  it('keeps staff off their own disputes', () => {
    expect(() => assertNotOwnDispute('b', { buyerId: 'b', sellerId: 's' })).toThrow();
    expect(() => assertNotOwnDispute('x', { buyerId: 'b', sellerId: 's' })).not.toThrow();
  });

  it('takes the opener from the actor, falling back to the buyer', () => {
    expect(openerOf('b', 's', 's')).toBe('s');
    expect(openerOf('b', 's', 'b')).toBe('b');
    expect(openerOf('b', 's', null)).toBe('b');
  });
});
