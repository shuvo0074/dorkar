import { describe, expect, it } from 'vitest';
import { maskBdPhone, normalizeBdPhone } from '../src/phone';

describe('normalizeBdPhone', () => {
  it.each([
    ['01712345678', '+8801712345678'],
    ['+8801712345678', '+8801712345678'],
    ['8801712345678', '+8801712345678'],
    ['008801712345678', '+8801712345678'],
    ['+880 1712-345678', '+8801712345678'],
    ['(017) 1234.5678', '+8801712345678'],
    ['  01312345678 ', '+8801312345678'],
    ['01912345678', '+8801912345678'],
    ['1712345678', '+8801712345678'], // leading 0 omitted
    ['০১৭১২৩৪৫৬৭৮', '+8801712345678'],
    ['+৮৮০১৮১২৩৪৫৬৭৮', '+8801812345678'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBdPhone(input)).toBe(expected);
  });

  it.each([
    '',
    '0171234567', // too short
    '017123456789', // too long
    '01212345678', // 012 is not a mobile operator prefix
    '01012345678',
    '+911712345678', // other country
    '+8801712345678x',
    '880171234567',
    'abc',
    '0'.repeat(40),
  ])('rejects %j', (input) => {
    expect(normalizeBdPhone(input)).toBeNull();
  });
});

describe('maskBdPhone', () => {
  it('keeps operator prefix and last 3 digits', () => {
    expect(maskBdPhone('+8801712345678')).toBe('+88017•••••678');
  });
});
