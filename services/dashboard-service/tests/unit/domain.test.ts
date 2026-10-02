import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeTargetType, prefixUpperBound } from '../../src/domain/activity';
import {
  addDays,
  compare,
  daysInRange,
  dhakaDay,
  dhakaDayStart,
  periodWindow,
  weekStart,
  zeroFill,
} from '../../src/domain/calendar';
import { csvCell, csvRow } from '../../src/domain/csv';
import { ACTION_LABELS, labelFor } from '../../src/domain/labels';
import { count, mergeIncrements, shouldApply } from '../../src/domain/metrics';
import { dashboardEnvSchema } from '../../src/app';

describe('labels', () => {
  it('has a sentence for every action services emit today', () => {
    const emitted = [
      'auth.otp_requested',
      'auth.otp_verify_failed',
      'auth.account_created',
      'auth.login_succeeded',
      'auth.login_denied',
      'auth.logout',
      'auth.logout_all',
      'session.refresh_reuse_detected',
      'device.registered',
      'device.revoked',
      'contact.read',
      'admin.account_status_changed',
      'admin.role_granted',
      'media.upload_created',
      'media.completed',
      'media.deleted',
      'verification.nid.submitted',
      'verification.decided',
      'verification.policy.created',
      'verification.policy.updated',
      'verification.policy.deactivated',
      'category.created',
      'category.updated',
      'listing.hidden',
      'listing.restored',
      'need.hidden',
      'need.restored',
      'offer.submit',
      'offer.counter',
      'offer.accept',
      'offer.reject',
      'offer.withdraw',
      'offer.admin_read',
      'transaction.created',
      ...[
        'confirm',
        'cancel',
        'expire',
        'arrange-delivery',
        'mark-delivered',
        'confirm-receipt',
        'auto-complete',
        'dispute',
        'resolve-release',
        'resolve-cancel',
      ].map((c) => `transaction.${c}`),
      'review.create',
      'review.hide',
      'review.restore',
      'moderation.cases.listed',
      'moderation.case.viewed',
      'moderation.case.assigned',
      ...['hide', 'restore', 'dismiss'].map((a) => `moderation.case.${a}`),
      'activity.exported',
    ];
    for (const a of emitted) expect(ACTION_LABELS[a], a).toBeTruthy();
    expect(labelFor('auth.login_succeeded')).toBe('Signed in');
    expect(labelFor('transaction.mark-delivered')).toBe('Marked a deal as delivered');
  });

  it('labels are short sentences without trailing punctuation', () => {
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      expect(label.length, action).toBeLessThanOrEqual(80);
      expect(label, action).toMatch(/^[A-Z][^.]*[a-z]$/);
    }
  });

  it('falls back to a readable label for unknown actions', () => {
    expect(labelFor('bidding.bid_retracted')).toBe('Bidding: bid retracted');
    expect(labelFor('rental.booking-overdue.notice')).toBe('Rental: booking overdue notice');
    expect(labelFor('heartbeat')).toBe('Heartbeat');
  });
});

describe('csv', () => {
  it('escapes quotes, commas and newlines (RFC 4180)', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(csvCell({ a: 1, b: 'x' })).toBe('"{""a"":1,""b"":""x""}"');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('+880')).toBe("'+880");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    // Neutralised and quoted when it also needs quoting.
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('builds CRLF-terminated rows', () => {
    expect(csvRow(['a', 'b,c', null])).toBe('a,"b,c",\r\n');
  });
});

describe('calendar (Asia/Dhaka)', () => {
  it('maps instants to the Dhaka day (UTC+6, no DST)', () => {
    expect(dhakaDay('2026-03-15T17:59:59.999Z')).toBe('2026-03-15');
    expect(dhakaDay('2026-03-15T18:00:00.000Z')).toBe('2026-03-16');
    expect(dhakaDay(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
    expect(dhakaDayStart('2026-03-16').toISOString()).toBe('2026-03-15T18:00:00.000Z');
  });

  it('does day arithmetic across months and leap years', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(daysInRange('2026-01-01', '2026-01-01')).toBe(1);
    expect(daysInRange('2024-01-01', '2024-12-31')).toBe(366);
    expect(weekStart('2025-01-01')).toBe('2024-12-30'); // Wednesday → Monday
    expect(weekStart('2025-01-05')).toBe('2024-12-30'); // Sunday
    expect(weekStart('2025-01-06')).toBe('2025-01-06'); // Monday
  });

  it('zero-fills daily and weekly series', () => {
    const rows = [
      { day: '2025-01-02', value: 2 },
      { day: '2025-01-05', value: 1 },
    ];
    expect(zeroFill(rows, '2025-01-01', '2025-01-07', 'day').map((p) => p.value)).toEqual([
      0, 2, 0, 0, 1, 0, 0,
    ]);
    expect(zeroFill(rows, '2025-01-01', '2025-01-07', 'week')).toEqual([
      { start: '2024-12-30', value: 3 },
      { start: '2025-01-06', value: 0 },
    ]);
    expect(zeroFill([], '2025-01-01', '2025-01-01', 'day')).toEqual([
      { start: '2025-01-01', value: 0 },
    ]);
  });

  it('computes period windows and changes', () => {
    expect(periodWindow('2026-03-15', 7)).toEqual({
      days: 7,
      from: '2026-03-09',
      to: '2026-03-15',
      previousFrom: '2026-03-02',
      previousTo: '2026-03-08',
    });
    expect(periodWindow('2026-03-15', 1)).toMatchObject({
      from: '2026-03-15',
      previousFrom: '2026-03-14',
      previousTo: '2026-03-14',
    });
    expect(compare(3, 4)).toEqual({ current: 3, previous: 4, change: -1, changePct: -25 });
    expect(compare(2, 0)).toEqual({ current: 2, previous: 0, change: 2, changePct: null });
    expect(compare(2, 3).changePct).toBe(-33.3);
  });
});

describe('metrics', () => {
  it('writes the total plus each dimension', () => {
    expect(count('transactions_created', ['mode:BUY', 'source:OFFER'])).toEqual([
      { metric: 'transactions_created', dimension: '', by: 1 },
      { metric: 'transactions_created', dimension: 'mode:BUY', by: 1 },
      { metric: 'transactions_created', dimension: 'source:OFFER', by: 1 },
    ]);
    expect(count('gmv_completed', [], 1500)).toEqual([
      { metric: 'gmv_completed', dimension: '', by: 1500 },
    ]);
  });

  it('merges duplicate keys and drops zeros', () => {
    expect(
      mergeIncrements([...count('signups'), ...count('signups'), ...count('gmv_completed', [], 0)]),
    ).toEqual([{ metric: 'signups', dimension: '', by: 2 }]);
  });

  describe('shouldApply (ordering guard)', () => {
    const t = (s: number) => new Date(1_700_000_000_000 + s * 1000);
    const table: Array<
      [string, Parameters<typeof shouldApply>[0], string | null, number, boolean]
    > = [
      ['no row yet', null, null, 1, true],
      ['row without status (stub)', { status: null, at: null }, 'OPEN', 1, true],
      ['newer event', { status: 'OPEN', at: t(1) }, 'OPEN', 2, true],
      ['newer event, from mismatch', { status: 'PAUSED', at: t(1) }, 'OPEN', 2, true],
      ['older event', { status: 'CLOSED', at: t(5) }, 'OPEN', 2, false],
      ['tie, from matches', { status: 'OPEN', at: t(1) }, 'OPEN', 1, true],
      ['tie, from mismatch', { status: 'CLOSED', at: t(1) }, 'OPEN', 1, false],
      ['tie, creation fact (no from)', { status: 'CLOSED', at: t(1) }, null, 1, false],
    ];
    for (const [name, current, from, at, expected] of table) {
      it(name, () => expect(shouldApply(current, { from, at: t(at) })).toBe(expected));
    }
  });
});

describe('activity helpers', () => {
  it('normalises target types', () => {
    expect(normalizeTargetType('account')).toBe('ACCOUNT');
    expect(normalizeTargetType(' Offer ')).toBe('OFFER');
    expect(normalizeTargetType(null)).toBeNull();
    expect(normalizeTargetType('')).toBeNull();
  });

  it('builds an exclusive upper bound for prefix ranges', () => {
    const p = 'transaction.';
    const hi = prefixUpperBound(p);
    expect(hi).toBe('transaction/');
    for (const inside of ['transaction.', 'transaction.cancel', 'transaction.zzz']) {
      expect(inside >= p && inside < hi).toBe(true);
    }
    for (const outside of ['transactio', 'transactions', 'transaction', 'u']) {
      expect(outside >= p && outside < hi).toBe(false);
    }
  });
});

describe('config', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost:5432/x',
    REDIS_URL: 'redis://localhost:6379',
    JWKS_URL: 'http://localhost/jwks',
    INTERNAL_API_TOKEN: randomBytes(32).toString('hex'),
    PII_HASH_KEY: randomBytes(32).toString('hex'),
  };

  it('defaults to every producer, 365-day retention and a 30 s cache', () => {
    const c = dashboardEnvSchema.parse(base);
    expect(c.PORT).toBe(4018);
    expect(c.DATABASE_SCHEMA).toBe('dashboard');
    expect(c.ACTIVITY_PRODUCERS).toContain('identity');
    expect(c.ACTIVITY_PRODUCERS).toContain('dashboard');
    expect(c.ACTIVITY_PRODUCERS).toHaveLength(18);
    expect(c.ACTIVITY_RETENTION_DAYS).toBe(365);
    expect(c.DASHBOARD_CACHE_SECONDS).toBe(30);
  });

  it('parses and de-duplicates the producer list, rejecting junk', () => {
    expect(
      dashboardEnvSchema.parse({ ...base, ACTIVITY_PRODUCERS: ' offer, offer,demand ' })
        .ACTIVITY_PRODUCERS,
    ).toEqual(['offer', 'demand']);
    expect(dashboardEnvSchema.safeParse({ ...base, ACTIVITY_PRODUCERS: 'events:x' }).success).toBe(
      false,
    );
    expect(dashboardEnvSchema.safeParse({ ...base, ACTIVITY_PRODUCERS: ' , ' }).success).toBe(
      false,
    );
  });
});
