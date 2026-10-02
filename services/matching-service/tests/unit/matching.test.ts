import { describe, expect, it } from 'vitest';
import {
  districtsNear,
  fromStatesFor,
  MatchStatuses,
  MatchTransitions,
  modesForKind,
  modesForRoles,
  reopenedStatus,
  rescoredStatus,
  selectBestPerSeller,
  targetFor,
  transition,
  type Candidate,
  type MatchAction,
  type MatchStatus,
  type ScoredCandidate,
} from '../../src/domain/matching';

describe('match state machine', () => {
  const expected: Record<MatchStatus, Partial<Record<MatchAction, MatchStatus>>> = {
    NEW: { DISMISS: 'DISMISSED', RESPOND: 'RESPONDED', CLOSE: 'CLOSED' },
    DISMISSED: { RESPOND: 'RESPONDED', CLOSE: 'CLOSED' },
    RESPONDED: { CLOSE: 'CLOSED' },
    CLOSED: {},
  };
  const actions: MatchAction[] = ['DISMISS', 'RESPOND', 'CLOSE'];

  it.each(MatchStatuses.flatMap((s) => actions.map((a) => [s, a] as const)))(
    '%s --%s--> as specified',
    (from, action) => {
      const to = expected[from][action];
      if (to) expect(transition(from, action)).toBe(to);
      else expect(() => transition(from, action)).toThrow(/Cannot/);
    },
  );

  it('derives guarded-update source states and targets from the table', () => {
    expect(MatchTransitions).toEqual(expected);
    expect(fromStatesFor('CLOSE')).toEqual(['NEW', 'DISMISSED', 'RESPONDED']);
    expect(fromStatesFor('RESPOND')).toEqual(['NEW', 'DISMISSED']);
    expect(fromStatesFor('DISMISS')).toEqual(['NEW']);
    for (const a of actions) {
      for (const s of fromStatesFor(a)) expect(transition(s, a)).toBe(targetFor(a));
    }
  });

  it('restores the seller’s choice when a closed match qualifies again', () => {
    const at = new Date();
    expect(reopenedStatus({ respondedAt: null, dismissedAt: null })).toBe('NEW');
    expect(reopenedStatus({ respondedAt: null, dismissedAt: at })).toBe('DISMISSED');
    expect(reopenedStatus({ respondedAt: at, dismissedAt: at })).toBe('RESPONDED');
    expect(rescoredStatus({ status: 'DISMISSED', respondedAt: null, dismissedAt: at })).toBe(
      'DISMISSED',
    );
    expect(rescoredStatus({ status: 'CLOSED', respondedAt: null, dismissedAt: null })).toBe('NEW');
  });
});

describe('compatibility lookups', () => {
  it('maps listing kinds and seller roles back to need modes', () => {
    expect(modesForKind('PRODUCT').sort()).toEqual(['BUY', 'SOURCE']);
    expect(modesForKind('RENTAL').sort()).toEqual(['BORROW', 'RENT']);
    expect(modesForKind('SERVICE')).toEqual(['HIRE']);
    expect(modesForRoles(['LENDER']).sort()).toEqual(['BORROW', 'RENT']);
    expect(modesForRoles(['SELLER', 'SUPPLIER']).sort()).toEqual(['BUY', 'RENT', 'SOURCE']);
    expect(modesForRoles([])).toEqual([]);
  });

  it('expands districts to their whole divisions', () => {
    const near = districtsNear(['dhaka']);
    expect(near).toContain('gazipur');
    expect(near).not.toContain('sylhet');
    expect(districtsNear(['dhaka', 'sylhet'])).toEqual(
      expect.arrayContaining(['gazipur', 'moulvibazar']),
    );
  });
});

describe('best candidate per seller', () => {
  const sc = (
    sellerId: string,
    score: number,
    listingId: string | null = null,
  ): ScoredCandidate => ({
    candidate: (listingId
      ? { type: 'LISTING', sellerId, listingId }
      : { type: 'SELLER', sellerId }) as Candidate,
    score,
    reasons: {},
  });

  it('keeps one per seller, drops below the minimum, caps the count, orders deterministically', () => {
    const picked = selectBestPerSeller(
      [
        sc('a', 50),
        sc('a', 70, 'l1'),
        sc('a', 60, 'l2'),
        sc('b', 39),
        sc('c', 70),
        sc('d', 80),
        sc('e', 45),
      ],
      40,
      3,
    );
    expect(picked.map((p) => [p.candidate.sellerId, p.score])).toEqual([
      ['d', 80],
      ['a', 70],
      ['c', 70],
    ]);
    expect(picked[1]!.candidate).toMatchObject({ listingId: 'l1' });
  });

  it('prefers a listing over a capability on equal score', () => {
    const [p] = selectBestPerSeller([sc('a', 60), sc('a', 60, 'l1')], 0, 10);
    expect(p!.candidate.type).toBe('LISTING');
  });
});
