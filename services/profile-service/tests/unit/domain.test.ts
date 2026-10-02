import { describe, expect, it } from 'vitest';
import {
  assertCapabilitiesComplete,
  assertNoContactInfo,
  defaultDisplayName,
} from '../../src/domain/profile';

describe('profile rules', () => {
  it('derives a neutral default name from the account id, never the phone', () => {
    expect(defaultDisplayName('0192f0c4-0000-7000-8000-00000000abcd')).toBe('Member ABCD');
  });

  it('blocks contact details in public text', () => {
    expect(() => assertNoContactInfo('bio', 'whatsapp 01712345678')).toThrow(/phone number/);
    expect(() => assertNoContactInfo('bio', 'x@y.com')).toThrow(/email/);
    expect(() => assertNoContactInfo('bio', 'Phones, 10 years in business')).not.toThrow();
    expect(() => assertNoContactInfo('bio', null)).not.toThrow();
  });

  it('requires roles and categories for an active seller, not an inactive one', () => {
    const base = { serviceDistricts: [], deliveryModes: [] };
    expect(() =>
      assertCapabilitiesComplete({ ...base, roles: [], categoryIds: [], active: true }),
    ).toThrow();
    expect(() =>
      assertCapabilitiesComplete({ ...base, roles: [], categoryIds: [], active: false }),
    ).not.toThrow();
  });
});
