import { describe, expect, it } from 'vitest';
import { pseudonymize, safeEqual, uuidv7 } from '../src/crypto';

describe('uuidv7', () => {
  it('is RFC 9562 v7 formatted', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encodes the timestamp so ids sort by creation time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(1_700_000_000_000);
  });

  it('is unique', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(0)));
    expect(ids.size).toBe(10_000);
  });
});

describe('safeEqual / pseudonymize', () => {
  it('compares buffers of different length without throwing', () => {
    expect(safeEqual(Buffer.from('a'), Buffer.from('ab'))).toBe(false);
    expect(safeEqual(Buffer.from('ab'), Buffer.from('ab'))).toBe(true);
  });

  it('is deterministic per key and differs across keys', () => {
    expect(pseudonymize('k1', '1.2.3.4')).toBe(pseudonymize('k1', '1.2.3.4'));
    expect(pseudonymize('k1', '1.2.3.4')).not.toBe(pseudonymize('k2', '1.2.3.4'));
  });
});
