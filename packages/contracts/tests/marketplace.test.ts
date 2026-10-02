import { describe, expect, it } from 'vitest';
import { validateAttributes, type AttributeSchema } from '../src/attributes';
import { Districts, LocationSchema } from '../src/locations';
import { taka } from '../src/marketplace';
import { findContactInfo } from '../src/privacy';

const phones: AttributeSchema = {
  properties: {
    brand: { type: 'string', label: { en: 'Brand', bn: 'ব্র্যান্ড' }, enum: ['Apple', 'Samsung'] },
    storageGb: {
      type: 'integer',
      label: { en: 'Storage', bn: 'স্টোরেজ' },
      minimum: 8,
      maximum: 2048,
    },
    boxed: { type: 'boolean', label: { en: 'With box', bn: 'বক্সসহ' } },
  },
  required: ['brand'],
};

describe('validateAttributes', () => {
  it('accepts valid values and trims strings', () => {
    expect(validateAttributes(phones, { brand: 'Apple', storageGb: 256, boxed: true })).toEqual({
      ok: true,
      value: { brand: 'Apple', storageGb: 256, boxed: true },
    });
  });

  it('rejects unknown keys, wrong types, bounds and enum violations, and missing required', () => {
    const r = validateAttributes(phones, { storageGb: 4.5, colour: 'red', boxed: 'yes' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.path).sort()).toEqual(['boxed', 'brand', 'colour', 'storageGb']);
    const enumErr = validateAttributes(phones, { brand: 'Nokia' });
    expect(enumErr.ok).toBe(false);
  });

  it('partial mode skips required (filters, drafts)', () => {
    expect(validateAttributes(phones, { storageGb: 128 }, { partial: true }).ok).toBe(true);
  });

  it('rejects non-objects', () => {
    expect(validateAttributes(phones, ['x']).ok).toBe(false);
    expect(validateAttributes(phones, null).ok).toBe(false);
  });
});

describe('locations', () => {
  it('has all 64 districts across 8 divisions', () => {
    expect(Object.keys(Districts)).toHaveLength(64);
    expect(new Set(Object.values(Districts).map((d) => d.division)).size).toBe(8);
  });

  it('derives the division from the district, ignoring a wrong client value', () => {
    expect(
      LocationSchema.parse({ district: 'sylhet', division: 'dhaka', area: 'Zindabazar' }),
    ).toEqual({
      district: 'sylhet',
      division: 'sylhet',
      area: 'Zindabazar',
    });
    expect(LocationSchema.safeParse({ district: 'atlantis' }).success).toBe(false);
  });
});

describe('money', () => {
  it('converts taka to integer poisha', () => {
    expect(taka(80_000)).toEqual({ amount: 8_000_000, currency: 'BDT' });
    expect(taka(12.34)).toEqual({ amount: 1234, currency: 'BDT' });
  });
});

describe('findContactInfo', () => {
  it.each([
    'Call me 01712345678',
    'whatsapp +880 1712-345678 please',
    'ফোন ০১৭১২৩৪৫৬৭৮',
    '017 1234 5678',
    'num:(017)12345678',
  ])('detects a phone number in %j', (t) => {
    expect(findContactInfo(t)).toBe('PHONE');
  });

  it('detects emails', () => {
    expect(findContactInfo('mail me at rahim.k@example.com')).toBe('EMAIL');
  });

  it.each([
    'iPhone 15 Pro 256GB',
    'Budget 80000 taka',
    'Order 500 bags by 2026-10-31',
    'Model 2023, 120000 km',
  ])('leaves ordinary text alone: %j', (t) => {
    expect(findContactInfo(t)).toBeNull();
  });
});
