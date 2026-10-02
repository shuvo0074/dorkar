import { AuctionStatuses, type AuctionStatus } from '@dorkar/contracts';
import { describe, expect, it } from 'vitest';
import {
  AUCTION_TRANSITIONS,
  AuctionActors,
  AuctionCommands,
  closeOutcome,
  decide,
  reserveMet,
  transitionTable,
  type AuctionActor,
  type AuctionCommand,
  type AuctionFacts,
} from '../../src/domain/auction';

const now = new Date('2026-10-02T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const ahead = (ms: number) => new Date(now.getTime() + ms);
const bdt = (amount: number) => ({ amount, currency: 'BDT' as const });

/** Facts under which every guard of `command` passes. */
const passing = (command: AuctionCommand): Omit<AuctionFacts, 'status'> => ({
  kind: 'FORWARD',
  startsAt: ago(60_000),
  endsAt: ago(1_000),
  bidCount: 0,
  leadingBidId: command === 'AWARD' ? 'bid' : null,
  leadingAmount: command === 'AWARD' ? bdt(1_000) : null,
  reservePrice: null,
  now,
});

/** The expected table, written independently of the implementation (03-lifecycles §3). */
const EXPECTED: Record<
  AuctionCommand,
  { from: AuctionStatus[]; actor: AuctionActor; to: AuctionStatus }
> = {
  OPEN: { from: ['SCHEDULED'], actor: 'SYSTEM', to: 'OPEN' },
  CANCEL: { from: ['SCHEDULED', 'OPEN'], actor: 'OWNER', to: 'CANCELLED' },
  ADMIN_CANCEL: { from: ['SCHEDULED', 'OPEN', 'CLOSING'], actor: 'ADMIN', to: 'CANCELLED' },
  SUBJECT_GONE: { from: ['SCHEDULED', 'OPEN', 'CLOSING'], actor: 'SYSTEM', to: 'CANCELLED' },
  BEGIN_CLOSE: { from: ['OPEN'], actor: 'SYSTEM', to: 'CLOSING' },
  AWARD: { from: ['CLOSING'], actor: 'SYSTEM', to: 'AWARDED' },
  NO_WINNER: { from: ['CLOSING'], actor: 'SYSTEM', to: 'NO_WINNER' },
  SETTLE: { from: ['AWARDED'], actor: 'SYSTEM', to: 'SETTLED' },
};

describe('auction state machine — exhaustive (status × command × actor)', () => {
  const cells = AuctionStatuses.flatMap((status) =>
    AuctionCommands.flatMap((command) =>
      AuctionActors.map((actor) => ({ status, command, actor })),
    ),
  );

  it.each(cells)('$status --$command by $actor', ({ status, command, actor }) => {
    const d = decide({ ...passing(command), status }, command, actor);
    const e = EXPECTED[command];
    const allowed = e.from.includes(status) && e.actor === actor;
    expect(d.ok).toBe(allowed);
    if (d.ok) expect(d.to).toBe(e.to);
    else if (e.actor !== actor) expect(d.error.code).toBe('FORBIDDEN');
    else expect(d.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('declares exactly the expected transitions', () => {
    for (const c of AuctionCommands) {
      expect([...AUCTION_TRANSITIONS[c].from].sort()).toEqual([...EXPECTED[c].from].sort());
      expect(AUCTION_TRANSITIONS[c].to).toBe(EXPECTED[c].to);
      expect(AUCTION_TRANSITIONS[c].actors).toEqual([EXPECTED[c].actor]);
    }
  });

  it('terminal statuses accept no command at all', () => {
    const table = transitionTable(passing('AWARD'));
    for (const s of ['SETTLED', 'NO_WINNER', 'CANCELLED'] as const) {
      expect(table.filter((r) => r.status === s && r.to !== null)).toEqual([]);
    }
  });
});

describe('guards', () => {
  const base = (over: Partial<AuctionFacts> = {}): AuctionFacts => ({
    ...passing('OPEN'),
    status: 'SCHEDULED',
    ...over,
  });

  it('OPEN needs starts_at reached (inclusive)', () => {
    expect(decide(base({ startsAt: ahead(1) }), 'OPEN', 'SYSTEM')).toMatchObject({ ok: false });
    expect(decide(base({ startsAt: now }), 'OPEN', 'SYSTEM')).toEqual({ ok: true, to: 'OPEN' });
  });

  it('BEGIN_CLOSE needs ends_at reached (inclusive)', () => {
    const open = base({ status: 'OPEN' });
    expect(decide({ ...open, endsAt: ahead(1) }, 'BEGIN_CLOSE', 'SYSTEM').ok).toBe(false);
    expect(decide({ ...open, endsAt: now }, 'BEGIN_CLOSE', 'SYSTEM').ok).toBe(true);
  });

  it('owner may cancel an OPEN auction only without bids; admin always', () => {
    const open = base({ status: 'OPEN', bidCount: 1, leadingBidId: 'b', leadingAmount: bdt(5) });
    const d = decide(open, 'CANCEL', 'OWNER');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.details?.['rule']).toBe('AUCTION_HAS_BIDS');
    expect(decide({ ...open, bidCount: 0 }, 'CANCEL', 'OWNER').ok).toBe(true);
    expect(decide(open, 'ADMIN_CANCEL', 'ADMIN').ok).toBe(true);
    expect(decide({ ...open, status: 'SCHEDULED' }, 'CANCEL', 'OWNER').ok).toBe(true);
  });

  it('AWARD and NO_WINNER are mutually exclusive for every close situation', () => {
    const closing = (o: Partial<AuctionFacts>) => base({ status: 'CLOSING', ...o });
    const cases: Array<[string, Partial<AuctionFacts>, 'AWARD' | 'NO_WINNER']> = [
      ['no bids', {}, 'NO_WINNER'],
      ['bid, no reserve', { leadingBidId: 'b', leadingAmount: bdt(100) }, 'AWARD'],
      [
        'forward reserve met (equal)',
        { leadingBidId: 'b', leadingAmount: bdt(100), reservePrice: bdt(100) },
        'AWARD',
      ],
      [
        'forward reserve not met',
        { leadingBidId: 'b', leadingAmount: bdt(99), reservePrice: bdt(100) },
        'NO_WINNER',
      ],
      [
        'reverse reserve met (equal)',
        { kind: 'REVERSE', leadingBidId: 'b', leadingAmount: bdt(100), reservePrice: bdt(100) },
        'AWARD',
      ],
      [
        'reverse reserve not met',
        { kind: 'REVERSE', leadingBidId: 'b', leadingAmount: bdt(101), reservePrice: bdt(100) },
        'NO_WINNER',
      ],
    ];
    for (const [, o, expected] of cases) {
      const f = closing(o);
      expect(closeOutcome(f)).toBe(expected);
      expect(decide(f, expected, 'SYSTEM').ok).toBe(true);
      expect(decide(f, expected === 'AWARD' ? 'NO_WINNER' : 'AWARD', 'SYSTEM').ok).toBe(false);
    }
  });
});

describe('reserveMet', () => {
  it.each([
    ['FORWARD', null, null, false],
    ['FORWARD', 100, null, false],
    ['FORWARD', null, 50, true],
    ['FORWARD', 100, 100, true],
    ['FORWARD', 100, 99, false],
    ['REVERSE', null, 50, true],
    ['REVERSE', 100, 100, true],
    ['REVERSE', 100, 101, false],
    ['REVERSE', 100, 1, true],
  ] as const)('%s reserve=%s leading=%s → %s', (kind, reserve, leading, expected) => {
    expect(
      reserveMet({
        kind,
        reservePrice: reserve === null ? null : bdt(reserve),
        leadingAmount: leading === null ? null : bdt(leading),
      }),
    ).toBe(expected);
  });
});
