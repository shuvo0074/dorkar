import { normalizeBdPhone } from './phone';

/**
 * "Your phone number stays private": people reach each other through Dorkar, so public free
 * text (display names, bios, needs, listings, offers) must not carry phone numbers or emails.
 * Catches the common evasions: spaces, dashes, dots, Bengali digits, +880/880/0 prefixes.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Runs of digits (ASCII or Bengali) possibly separated by spaces, dots, dashes or brackets.
const DIGIT_RUN = /[+(]?[0-9০-৯][0-9০-৯\s().-]{8,}[0-9০-৯]/g;

export type ContactKind = 'PHONE' | 'EMAIL';

export function findContactInfo(text: string): ContactKind | null {
  if (EMAIL.test(text)) return 'EMAIL';
  for (const run of text.match(DIGIT_RUN) ?? []) {
    if (normalizeBdPhone(run)) return 'PHONE';
    // A BD mobile embedded in a longer run, e.g. "call01712345678now" after separators removed.
    const digits = run.replace(/[^0-9০-৯]/g, '');
    for (let i = 0; i + 11 <= digits.length; i++) {
      if (normalizeBdPhone(digits.slice(i, i + 11))) return 'PHONE';
    }
  }
  return null;
}
