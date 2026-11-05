jest.mock('react-native-get-random-values', () => ({}));
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { getRandomValues: (b: Uint8Array) => b.fill(7) },
});
const { SimpleRelativeTimeFormat } = require('../src/lib/polyfills');

test('English matches numeric: auto', () => {
  const f = new SimpleRelativeTimeFormat('en-GB');
  expect(f.format(3, 'day')).toBe('in 3 days');
  expect(f.format(-1, 'hour')).toBe('1 hour ago');
  expect(f.format(1, 'day')).toBe('tomorrow');
  expect(f.format(-1, 'day')).toBe('yesterday');
});

test('Bangla', () => {
  const f = new SimpleRelativeTimeFormat('bn-BD');
  expect(f.format(-1, 'day')).toBe('গতকাল');
  expect(f.format(2, 'hour')).toContain('ঘণ্টা পরে');
});

test('randomUUID has the v4 shape', () => {
  expect(crypto.randomUUID()).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});
