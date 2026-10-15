/** Integer poisha + currency, as every API returns money. */
export interface Money {
  amount: number;
  currency: 'BDT';
}

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Western digits for whatever the person typed (Bangla digits are common on Bangla keyboards). */
export function asciiDigits(s: string): string {
  return s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/**
 * Parses a taka amount as typed ("8000", "৮,০০০", "8,000.50", "৳ 1200") into poisha.
 * Returns null for anything that isn't a plain non-negative amount with at most two decimals.
 */
export function parseTaka(input: string): number | null {
  const s = asciiDigits(input)
    .replace(/[৳,\s]/g, '')
    .replace(/^tk\.?/i, '');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export const poisha = (amount: number): Money => ({ amount, currency: 'BDT' });

/** A poisha amount back into an editable taka string ("8000", "8000.5"). */
export function takaInput(m: Money | number | null | undefined): string {
  if (m === null || m === undefined) return '';
  const amount = typeof m === 'number' ? m : m.amount;
  const whole = Math.floor(amount / 100);
  const frac = amount % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}`;
}
