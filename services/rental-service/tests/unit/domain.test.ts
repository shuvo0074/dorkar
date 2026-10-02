import { describe, expect, it } from 'vitest';
import {
  assertBookable,
  assertNoContactInfo,
  assertTermsConsistent,
  assertWindow,
  bookingSlot,
  DEFAULT_TERMS,
  defaultTerms,
  initialState,
  mergeBusy,
  quote,
  type BookingPolicy,
  type RentalListing,
} from '../../src/domain/booking';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = new Date('2026-03-01T00:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const policy: BookingPolicy = {
  holdMinutes: 15,
  approvalHours: 24,
  overdueGraceHours: 2,
  maxAdvanceDays: 180,
};
const listing: RentalListing = {
  listingId: '00000000-0000-4000-8000-000000000001',
  sellerId: '00000000-0000-4000-8000-0000000000aa',
  categoryId: '00000000-0000-4000-8000-0000000000cc',
  title: 'Canon DSLR',
  district: 'dhaka',
  price: 150_000,
  currency: 'BDT',
  priceUnit: 'PER_DAY',
  available: true,
};
const renterId = '00000000-0000-4000-8000-0000000000bb';
const rule = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as { details?: { rule?: string } }).details?.rule ?? (e as { code: string }).code;
  }
  return null;
};

describe('pricing', () => {
  const start = at(0);
  const cases: Array<[string, Parameters<typeof quote>[0], number, number, number]> = [
    // [name, unit, durationMs, expectedUnits, expectedAmount for price 100]
    ['PER_DAY exact day', 'PER_DAY', DAY, 1, 100],
    ['PER_DAY 25h → 2 days', 'PER_DAY', 25 * HOUR, 2, 200],
    ['PER_DAY 1 minute → 1 day', 'PER_DAY', 60_000, 1, 100],
    ['PER_DAY 3 days exact', 'PER_DAY', 3 * DAY, 3, 300],
    ['PER_UNIT priced as PER_DAY', 'PER_UNIT', 49 * HOUR, 3, 300],
    ['PER_HOUR exact', 'PER_HOUR', 5 * HOUR, 5, 500],
    ['PER_HOUR 5h01 → 6h', 'PER_HOUR', 5 * HOUR + 60_000, 6, 600],
    ['PER_HOUR 30 min → 1h', 'PER_HOUR', HOUR / 2, 1, 100],
    ['TOTAL is flat', 'TOTAL', 10 * DAY, 1, 100],
  ];
  for (const [name, unit, ms, units, amount] of cases) {
    it(name, () => {
      const q = quote(unit, 100, start, new Date(start.getTime() + ms));
      expect(q.billedUnits).toBe(units);
      expect(q.amount).toBe(amount);
      expect(q.hours).toBeCloseTo(ms / HOUR);
    });
  }

  it('reports the effective unit', () => {
    expect(quote('PER_UNIT', 1, at(0), at(DAY)).effectiveUnit).toBe('PER_DAY');
    expect(quote('PER_HOUR', 1, at(0), at(HOUR)).effectiveUnit).toBe('PER_HOUR');
    expect(quote('TOTAL', 1, at(0), at(HOUR)).effectiveUnit).toBe('TOTAL');
  });

  it('rejects empty periods and amounts beyond the money ceiling', () => {
    expect(rule(() => quote('PER_DAY', 100, at(0), at(0)))).toBe('INVALID_PERIOD');
    expect(rule(() => quote('PER_HOUR', 100_000_000_000, at(0), at(2 * HOUR)))).toBe(
      'AMOUNT_TOO_LARGE',
    );
  });
});

describe('bookability', () => {
  const terms = defaultTerms(listing.listingId); // min 24h, max 30d, notice 12h
  const now = at(0);
  const ok = { renterId, startAt: at(DAY), endAt: at(2 * DAY) };

  it('accepts a request within the terms', () => {
    expect(rule(() => assertBookable(listing, terms, ok, now, policy))).toBeNull();
  });

  it.each([
    ['OWN_LISTING', { ...ok, renterId: listing.sellerId }, listing],
    ['LISTING_UNAVAILABLE', ok, { ...listing, available: false }],
    ['INVALID_PERIOD', { ...ok, endAt: ok.startAt }, listing],
    ['DURATION_TOO_SHORT', { ...ok, endAt: at(DAY + 23 * HOUR) }, listing],
    ['DURATION_TOO_LONG', { ...ok, endAt: at(DAY + 30 * DAY + 1) }, listing],
    ['ADVANCE_NOTICE', { ...ok, startAt: at(11 * HOUR), endAt: at(35 * HOUR) }, listing],
    ['TOO_FAR_AHEAD', { ...ok, startAt: at(179 * DAY), endAt: at(180 * DAY + 1) }, listing],
  ] as const)('%s', (expected, req, l) => {
    expect(rule(() => assertBookable(l, terms, req, now, policy))).toBe(expected);
  });

  it('boundaries are inclusive where the spec says ≥ / ≤', () => {
    const exact = { renterId, startAt: at(12 * HOUR), endAt: at(36 * HOUR) };
    expect(rule(() => assertBookable(listing, terms, exact, now, policy))).toBeNull();
    const longest = { renterId, startAt: at(DAY), endAt: at(31 * DAY) };
    expect(rule(() => assertBookable(listing, terms, longest, now, policy))).toBeNull();
    const farthest = { renterId, startAt: at(170 * DAY), endAt: at(180 * DAY) };
    expect(rule(() => assertBookable(listing, terms, farthest, now, policy))).toBeNull();
  });
});

describe('initial state and slot', () => {
  it('instant book holds for the hold window, otherwise waits for approval', () => {
    const start = at(10 * DAY);
    expect(initialState({ ...defaultTerms('x'), instantBook: true }, start, at(0), policy)).toEqual(
      { status: 'HELD', holdExpiresAt: at(15 * 60_000) },
    );
    expect(initialState(defaultTerms('x'), start, at(0), policy)).toEqual({
      status: 'PENDING_APPROVAL',
      holdExpiresAt: at(DAY),
    });
  });

  it('the deadline never passes the start', () => {
    const start = at(2 * HOUR);
    expect(initialState(defaultTerms('x'), start, at(0), policy).holdExpiresAt).toEqual(start);
  });

  it('the buffer widens the slot after the booking', () => {
    expect(bookingSlot(at(0), at(DAY), 3)).toEqual({ startAt: at(0), endAt: at(DAY + 3 * HOUR) });
    expect(bookingSlot(at(0), at(DAY), 0)).toEqual({ startAt: at(0), endAt: at(DAY) });
  });
});

describe('terms', () => {
  it('defaults', () => {
    expect(DEFAULT_TERMS).toEqual({
      instantBook: false,
      minDurationHours: 24,
      maxDurationDays: 30,
      deposit: null,
      advanceNoticeHours: 12,
      bufferHours: 0,
      cancellationNote: null,
    });
  });

  it('rejects a minimum above the maximum and contact info in the note', () => {
    expect(
      rule(() =>
        assertTermsConsistent({ ...DEFAULT_TERMS, minDurationHours: 49, maxDurationDays: 2 }),
      ),
    ).toBe('TERMS_INCONSISTENT');
    expect(
      rule(() => assertTermsConsistent({ ...DEFAULT_TERMS, cancellationNote: 'call 01712345678' })),
    ).toBe('NO_CONTACT_INFO');
  });

  it('notes may not carry contact details', () => {
    expect(rule(() => assertNoContactInfo('note', 'mail me at a@b.com'))).toBe('NO_CONTACT_INFO');
    expect(rule(() => assertNoContactInfo('note', 'Picking up Friday evening'))).toBeNull();
  });
});

describe('calendar', () => {
  it('merges overlapping and touching intervals and clips to the window', () => {
    const merged = mergeBusy(
      [
        { startAt: at(5 * HOUR), endAt: at(6 * HOUR) },
        { startAt: at(-HOUR), endAt: at(HOUR) },
        { startAt: at(HOUR), endAt: at(2 * HOUR) }, // touches the first: one interval
        { startAt: at(5 * HOUR + 30 * 60_000), endAt: at(7 * HOUR) }, // overlaps
        { startAt: at(20 * HOUR), endAt: at(30 * HOUR) },
      ],
      at(0),
      at(24 * HOUR),
    );
    expect(merged).toEqual([
      { startAt: at(0), endAt: at(2 * HOUR) },
      { startAt: at(5 * HOUR), endAt: at(7 * HOUR) },
      { startAt: at(20 * HOUR), endAt: at(24 * HOUR) },
    ]);
  });

  it('windows must be ordered and bounded', () => {
    expect(rule(() => assertWindow(at(0), at(0), 120, 'x'))).toBe('VALIDATION_FAILED');
    expect(rule(() => assertWindow(at(0), at(121 * DAY), 120, 'x'))).toBe('VALIDATION_FAILED');
    expect(rule(() => assertWindow(at(0), at(120 * DAY), 120, 'x'))).toBeNull();
  });
});
