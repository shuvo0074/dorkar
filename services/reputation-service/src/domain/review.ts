import { findContactInfo, type TransactionState } from '@dorkar/contracts';
import { AppError, Errors } from '@dorkar/kernel';

export const ReviewStatuses = ['VISIBLE', 'HIDDEN'] as const;
export type ReviewStatus = (typeof ReviewStatuses)[number];

export const AuthorRoles = ['BUYER', 'SELLER'] as const;
export type AuthorRole = (typeof AuthorRoles)[number];

/** What this service knows about a transaction (projection of transaction-service events). */
export interface TransactionView {
  id: string;
  buyerId: string;
  sellerId: string;
  state: TransactionState;
  completedAt: Date | null;
}

export interface Review {
  id: string;
  transactionId: string;
  authorId: string;
  subjectId: string;
  authorRole: AuthorRole;
  rating: number;
  comment: string | null;
  status: ReviewStatus;
  createdAt: Date;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export const isParty = (tx: TransactionView, accountId: string) =>
  tx.buyerId === accountId || tx.sellerId === accountId;

const rule = (rule: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError('BUSINESS_RULE_VIOLATION', message, { rule, ...details });

/**
 * Who may review whom, and when. Reviews exist only for real, completed deals:
 *  - the author must be a party (otherwise the transaction does not exist for them: 404);
 *  - the subject is always the other party, never chosen by the client;
 *  - the transaction must be COMPLETED;
 *  - the review must be written within `windowDays` of completion (inclusive);
 *  - nobody reviews themselves (a buyer = seller transaction is never reviewable).
 * One review per party per transaction is enforced by the store (UNIQUE → 409).
 */
export function reviewEligibility(
  tx: TransactionView | null,
  authorId: string,
  now: Date,
  windowDays: number,
): { subjectId: string; authorRole: AuthorRole } {
  if (!tx || !isParty(tx, authorId)) throw Errors.notFound('Transaction');
  const authorRole: AuthorRole = tx.buyerId === authorId ? 'BUYER' : 'SELLER';
  const subjectId = authorRole === 'BUYER' ? tx.sellerId : tx.buyerId;
  if (subjectId === authorId) {
    throw rule('SELF_REVIEW', 'You cannot review yourself.');
  }
  if (tx.state !== 'COMPLETED' || !tx.completedAt) {
    throw rule('TRANSACTION_NOT_COMPLETED', 'You can review this deal once it is completed.', {
      state: tx.state,
    });
  }
  if (now.getTime() - tx.completedAt.getTime() > windowDays * DAY_MS) {
    throw rule(
      'REVIEW_WINDOW_CLOSED',
      `Reviews can be written up to ${windowDays} days after completion.`,
      { windowDays },
    );
  }
  return { subjectId, authorRole };
}

/** Public text must not leak contact details (phone numbers stay private on Dorkar). */
export function assertNoContactInfo(field: string, text: string | null | undefined): void {
  if (!text) return;
  const kind = findContactInfo(text);
  if (kind) {
    throw rule(
      'NO_CONTACT_INFO',
      `Remove the ${kind === 'PHONE' ? 'phone number' : 'email address'} from your ${field}. People contact you through Dorkar.`,
      { field },
    );
  }
}
