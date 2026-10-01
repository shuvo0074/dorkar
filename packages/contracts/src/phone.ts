/**
 * Bangladesh mobile number normalization.
 *
 * Accepts the formats people actually type (01XXXXXXXXX, 8801…, +8801…, 008801…,
 * with spaces/dashes/dots/parentheses, Bengali digits) and returns E.164
 * (+8801[3-9]XXXXXXXX). Shared by backend (authoritative) and frontend (instant feedback).
 */

const BENGALI_ZERO = 0x09e6;
const SEPARATORS = /[\s\-.()]/g;
/** National significant number: 1, operator digit 3–9, then 8 digits. */
const BD_MOBILE_NSN = /^1[3-9]\d{8}$/;

export type BdPhoneE164 = string & { readonly __brand: 'BdPhoneE164' };

function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (ch) => String(ch.charCodeAt(0) - BENGALI_ZERO));
}

export function normalizeBdPhone(input: string): BdPhoneE164 | null {
  if (input.length > 32) return null;
  let s = toAsciiDigits(input.trim()).replace(SEPARATORS, '');

  if (s.startsWith('+')) {
    s = s.slice(1);
    if (!s.startsWith('880')) return null;
    s = s.slice(3);
  } else if (s.startsWith('00880')) {
    s = s.slice(5);
  } else if (s.startsWith('880') && s.length === 13) {
    s = s.slice(3);
  } else if (s.startsWith('0') && s.length === 11) {
    s = s.slice(1);
  }

  return BD_MOBILE_NSN.test(s) ? (`+880${s}` as BdPhoneE164) : null;
}

/** "+8801712345678" → "+88017•••••678". Safe for UIs, support tools and logs. */
export function maskBdPhone(e164: string): string {
  if (e164.length < 8) return '•••';
  return `${e164.slice(0, 6)}${'•'.repeat(e164.length - 9)}${e164.slice(-3)}`;
}
