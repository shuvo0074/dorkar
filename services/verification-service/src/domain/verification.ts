import type { VerificationKinds, VerificationStatuses } from '@dorkar/contracts';
import { AppError, Errors } from '@dorkar/kernel';

export type VerificationKind = (typeof VerificationKinds)[number];
export type VerificationStatus = (typeof VerificationStatuses)[number];

/** One current record per (account, kind). Holds no raw NID, name or date of birth. */
export interface Verification {
  id: string;
  accountId: string;
  kind: VerificationKind;
  status: VerificationStatus;
  provider: string;
  providerRef: string | null;
  nidLast4: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  submittedAt: Date;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

// ---------------------------------------------------------------- state machine

/**
 * Allowed transitions. A record re-enters PENDING only through a new submission after it was
 * rejected, revoked or expired; VERIFIED ends only by revocation or expiry.
 */
export const TRANSITIONS: Readonly<Record<VerificationStatus, readonly VerificationStatus[]>> = {
  PENDING: ['VERIFIED', 'REJECTED'],
  VERIFIED: ['REVOKED', 'EXPIRED'],
  REJECTED: ['PENDING'],
  REVOKED: ['PENDING'],
  EXPIRED: ['PENDING'],
};

export const canTransition = (from: VerificationStatus, to: VerificationStatus): boolean =>
  TRANSITIONS[from].includes(to);

export function assertTransition(from: VerificationStatus, to: VerificationStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      'INVALID_STATE_TRANSITION',
      `A ${from.toLowerCase()} verification cannot become ${to.toLowerCase()}.`,
      { from, to },
    );
  }
}

/** A new NID submission is allowed only when nothing is pending or verified. */
export function assertCanSubmitNid(current: VerificationStatus | null): void {
  if (current === 'PENDING') {
    throw new AppError(
      'BUSINESS_RULE_VIOLATION',
      'Your NID is already being reviewed. We will let you know the result.',
      { rule: 'NID_PENDING' },
    );
  }
  if (current === 'VERIFIED') {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'Your NID is already verified.', {
      rule: 'NID_ALREADY_VERIFIED',
    });
  }
}

export const nidAlreadyUsed = () =>
  new AppError(
    'BUSINESS_RULE_VIOLATION',
    'This NID is already verified on another Dorkar account. Contact support if this is a mistake.',
    { rule: 'NID_ALREADY_USED' },
  );

// ---------------------------------------------------------------- NID input

const BENGALI_ZERO = 0x09e6;

/** Bengali digits (০–৯) → ASCII; spaces and dashes removed. Returns null if anything else remains. */
export function normalizeNid(raw: string): string | null {
  const ascii = raw.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - BENGALI_ZERO));
  const compact = ascii.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(compact)) return null;
  // Smart card (10), old laminated (13) or old with birth year prefix (17).
  return compact.length === 10 || compact.length === 13 || compact.length === 17 ? compact : null;
}

export const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses a calendar date (YYYY-MM-DD) strictly; rejects impossible dates like 2001-02-30. */
export function parseIsoDate(s: string): { y: number; m: number; d: number } | null {
  const match = ISO_DATE.exec(s);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** Whole years between the date of birth and `today` (UTC calendar). */
export function ageOn(dob: { y: number; m: number; d: number }, today: Date): number {
  const ty = today.getUTCFullYear();
  const tm = today.getUTCMonth() + 1;
  const td = today.getUTCDate();
  return ty - dob.y - (tm < dob.m || (tm === dob.m && td < dob.d) ? 1 : 0);
}

export const MIN_AGE = 18;

export interface NidSubmission {
  nidNumber: string;
  dateOfBirth: string;
  fullName: string;
}

export interface ValidNidSubmission {
  /** Normalized digits. Passed to the provider and hashed; never stored or logged. */
  nid: string;
  dateOfBirth: string;
  fullName: string;
  last4: string;
}

/**
 * Validates an NID submission. Error details name the field, never the submitted value.
 */
export function validateNidSubmission(input: NidSubmission, today: Date): ValidNidSubmission {
  const nid = normalizeNid(input.nidNumber);
  if (!nid) {
    throw Errors.validation('Enter your NID number: 10, 13 or 17 digits.', {
      field: 'nidNumber',
    });
  }
  const dob = parseIsoDate(input.dateOfBirth);
  if (!dob || dob.y < 1900 || ageOn(dob, today) < 0) {
    throw Errors.validation('Enter your date of birth as YYYY-MM-DD.', { field: 'dateOfBirth' });
  }
  if (ageOn(dob, today) < MIN_AGE) {
    throw new AppError('BUSINESS_RULE_VIOLATION', 'You must be 18 or older to verify your NID.', {
      rule: 'UNDERAGE',
    });
  }
  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  if (fullName.length < 2 || fullName.length > 80 || /\d/.test(fullName)) {
    throw Errors.validation('Enter your name as printed on your NID (2–80 letters).', {
      field: 'fullName',
    });
  }
  return { nid, dateOfBirth: input.dateOfBirth, fullName, last4: nid.slice(-4) };
}
