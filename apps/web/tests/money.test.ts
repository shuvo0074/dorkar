import { describe, expect, it } from 'vitest';
import { parseTaka, takaInput } from '../src/lib/money';

describe('taka input', () => {
  it('parses what people type into poisha', () => {
    expect(parseTaka('8000')).toBe(800_000);
    expect(parseTaka('8,000.5')).toBe(800_050);
    expect(parseTaka('৳ 1,200')).toBe(120_000);
    expect(parseTaka('৮,০০০')).toBe(800_000);
    expect(parseTaka('Tk 99.99')).toBe(9_999);
  });

  it('rejects anything that is not a plain amount', () => {
    expect(parseTaka('')).toBeNull();
    expect(parseTaka('-5')).toBeNull();
    expect(parseTaka('1.234')).toBeNull();
    expect(parseTaka('ten')).toBeNull();
  });

  it('round-trips poisha back into an editable string', () => {
    expect(takaInput(800_000)).toBe('8000');
    expect(takaInput(800_050)).toBe('8000.5');
    expect(takaInput(800_005)).toBe('8000.05');
    expect(takaInput(null)).toBe('');
  });
});
