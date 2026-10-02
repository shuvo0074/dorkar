import type { NeedMode } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';
import { describe, expect, it } from 'vitest';
import {
  assertBudget,
  assertCategoryAllows,
  assertNoContactInfo,
  assertNoContactInfoDeep,
  assertNoMaterialChange,
  assertOpenNeedLimit,
  assertRequiredByNotPast,
  dhakaDate,
  effectiveTtlDays,
  expiryFrom,
  parseAttributes,
  parseModeTerms,
  type NeedPolicy,
} from '../../src/domain/need';

const policy: NeedPolicy = {
  defaultTtlDays: 14,
  maxTtlDays: 60,
  maxRenewals: 2,
  maxOpenPerUser: 20,
  maxOffers: 50,
};

const ruleOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.details?.['rule'] : e;
  }
  return null;
};

describe('mode terms', () => {
  const valid: Record<NeedMode, Record<string, unknown>> = {
    BUY: { acceptsUsed: true, warrantyRequired: false },
    RENT: {
      startAt: '2026-10-10T09:00:00Z',
      endAt: '2026-10-12T09:00:00Z',
      depositAcceptable: true,
    },
    BORROW: {
      startAt: '2026-10-10T09:00:00+06:00',
      returnBy: '2026-10-11T09:00:00+06:00',
      purpose: 'Wedding photos',
      depositOffered: false,
    },
    HIRE: {
      serviceDate: '2026-10-20',
      serviceWindow: 'MORNING',
      durationEstimateHours: 3,
      onSite: true,
      skills: ['plumbing'],
    },
    SOURCE: {
      specifications: '500 cotton t-shirts, 180 GSM',
      customization: 'Logo print',
      sampleRequired: true,
      deliveryDeadline: '2026-12-01',
    },
  };

  it.each(Object.entries(valid))('accepts valid %s terms', (mode, terms) => {
    expect(parseModeTerms(mode as NeedMode, terms)).toEqual(terms);
  });

  it('accepts empty BUY terms (all optional)', () => {
    expect(parseModeTerms('BUY', undefined)).toEqual({});
  });

  const invalid: Array<[NeedMode, Record<string, unknown>]> = [
    ['BUY', { acceptsUsed: 'yes' }],
    ['BUY', { unknownKey: true }],
    ['RENT', { startAt: '2026-10-12T09:00:00Z', endAt: '2026-10-10T09:00:00Z' }],
    ['RENT', { startAt: '2026-10-12T09:00:00Z', endAt: '2026-10-12T09:00:00Z' }],
    ['RENT', { startAt: '2026-10-12' }],
    ['BORROW', { startAt: '2026-10-12T09:00:00Z', returnBy: '2026-10-11T09:00:00Z' }],
    ['BORROW', { returnBy: '2026-10-11T09:00:00Z' }],
    ['HIRE', {}],
    ['HIRE', { serviceDate: '2026-10-20', serviceWindow: 'LUNCH' }],
    ['HIRE', { serviceDate: '2026-10-20', durationEstimateHours: -1 }],
    ['SOURCE', {}],
    ['SOURCE', { specifications: '   ' }],
    ['SOURCE', { specifications: 'x', deliveryDeadline: 'soon' }],
  ];
  it.each(invalid)('rejects invalid %s terms %j', (mode, terms) => {
    expect(ruleOf(() => parseModeTerms(mode, terms))).toBe('INVALID_MODE_TERMS');
  });

  it('does not accept terms meant for another mode', () => {
    expect(ruleOf(() => parseModeTerms('BUY', valid.RENT))).toBe('INVALID_MODE_TERMS');
  });
});

describe('TTL and renewal math', () => {
  it('uses the default TTL, allows a shorter one, never a longer one', () => {
    expect(effectiveTtlDays(null, policy)).toBe(14);
    expect(effectiveTtlDays(3, policy)).toBe(3);
    expect(effectiveTtlDays(30, policy)).toBe(14);
  });

  it('caps the default by the max TTL', () => {
    expect(effectiveTtlDays(null, { ...policy, defaultTtlDays: 90, maxTtlDays: 60 })).toBe(60);
    expect(effectiveTtlDays(0, policy)).toBe(1);
  });

  it('computes expiry from the given clock', () => {
    const now = new Date('2026-10-02T00:00:00Z');
    expect(expiryFrom(now, 14).toISOString()).toBe('2026-10-16T00:00:00.000Z');
  });
});

describe('need rules', () => {
  it('rejects contact details anywhere in public text', () => {
    expect(ruleOf(() => assertNoContactInfo('title', 'call 01712345678'))).toBe('NO_CONTACT_INFO');
    expect(ruleOf(() => assertNoContactInfo('description', 'mail me a@b.co'))).toBe(
      'NO_CONTACT_INFO',
    );
    expect(ruleOf(() => assertNoContactInfoDeep('terms', { purpose: ['০১৭১২-৩৪৫৬৭৮'] }))).toBe(
      'NO_CONTACT_INFO',
    );
    expect(ruleOf(() => assertNoContactInfo('title', 'iPhone 15 Pro 256GB'))).toBeNull();
  });

  it('requires an active category that allows the mode', () => {
    const cat = {
      id: 'c',
      parentId: null,
      modes: ['BUY'] as NeedMode[],
      attributeSchema: { properties: {}, required: [] },
      active: true,
    };
    expect(ruleOf(() => assertCategoryAllows(null, 'BUY'))).toBe('CATEGORY_UNAVAILABLE');
    expect(ruleOf(() => assertCategoryAllows({ ...cat, active: false }, 'BUY'))).toBe(
      'CATEGORY_UNAVAILABLE',
    );
    expect(ruleOf(() => assertCategoryAllows(cat, 'RENT'))).toBe('MODE_NOT_ALLOWED');
    expect(assertCategoryAllows(cat, 'BUY')).toBe(cat);
  });

  it('validates attributes partially against the category schema', () => {
    const schema = {
      properties: {
        brand: { type: 'string' as const, label: { en: 'Brand', bn: 'ব্র্যান্ড' } },
        storageGb: {
          type: 'integer' as const,
          label: { en: 'Storage', bn: 'স্টোরেজ' },
          minimum: 1,
        },
      },
      required: ['brand'],
    };
    expect(parseAttributes(schema, { storageGb: 256 })).toEqual({ storageGb: 256 });
    expect(ruleOf(() => parseAttributes(schema, { color: 'red' }))).toBe('INVALID_ATTRIBUTES');
    expect(ruleOf(() => parseAttributes(schema, { storageGb: 'big' }))).toBe('INVALID_ATTRIBUTES');
  });

  it('checks budget ranges, required-by dates and the open-need limit', () => {
    expect(ruleOf(() => assertBudget(200, 100))).toBe('BUDGET_RANGE');
    expect(ruleOf(() => assertBudget(100, 100))).toBeNull();
    expect(ruleOf(() => assertBudget(null, 100))).toBeNull();
    // 2026-10-01T20:00Z is already 2026-10-02 in Dhaka.
    const now = new Date('2026-10-01T20:00:00Z');
    expect(dhakaDate(now)).toBe('2026-10-02');
    expect(ruleOf(() => assertRequiredByNotPast('2026-10-01', now))).toBe('REQUIRED_BY_IN_PAST');
    expect(ruleOf(() => assertRequiredByNotPast('2026-10-02', now))).toBeNull();
    expect(ruleOf(() => assertOpenNeedLimit(19, policy))).toBeNull();
    expect(ruleOf(() => assertOpenNeedLimit(20, policy))).toBe('OPEN_NEED_LIMIT');
  });

  it('refuses material changes once offers exist', () => {
    const need = { offerCount: 0, acceptedQuantity: 0, categoryId: 'a', mode: 'BUY' as const };
    expect(
      ruleOf(() => assertNoMaterialChange(need, { categoryId: 'b', mode: 'RENT', quantity: 1 })),
    ).toBeNull();
    const withOffers = { ...need, offerCount: 2, acceptedQuantity: 2 };
    const same = { categoryId: 'a', mode: 'BUY' as const, quantity: 3 };
    expect(ruleOf(() => assertNoMaterialChange(withOffers, same))).toBeNull();
    expect(ruleOf(() => assertNoMaterialChange(withOffers, { ...same, categoryId: 'b' }))).toBe(
      'MATERIAL_CHANGE_WITH_OFFERS',
    );
    expect(ruleOf(() => assertNoMaterialChange(withOffers, { ...same, mode: 'RENT' }))).toBe(
      'MATERIAL_CHANGE_WITH_OFFERS',
    );
    expect(ruleOf(() => assertNoMaterialChange(withOffers, { ...same, quantity: 1 }))).toBe(
      'MATERIAL_CHANGE_WITH_OFFERS',
    );
  });
});
