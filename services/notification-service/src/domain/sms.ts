import type { Money } from '@dorkar/contracts';
import { copyFor } from './copy';
import type { Notification, NotificationPayload, PayloadValue } from './notification';

const isMoney = (v: PayloadValue | undefined): v is Money =>
  typeof v === 'object' && v !== null && typeof v.amount === 'number';

/** Integer poisha → "৳1,25,000" (South Asian grouping; paisa only when present). */
export function formatTaka(m: Money): string {
  const whole = Math.trunc(m.amount / 100);
  const paisa = m.amount % 100;
  const grouped = whole.toLocaleString('en-IN');
  return `৳${paisa ? `${grouped}.${String(paisa).padStart(2, '0')}` : grouped}`;
}

const amount = (p: NotificationPayload, key: string): string | null => {
  const v = p[key];
  return isMoney(v) ? formatTaka(v) : null;
};

/** "https://dorkar.com.bd/" → "dorkar.com.bd": SMS links stay short and look like our domain. */
export const shortHost = (baseUrl: string): string =>
  baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');

function body(n: Notification): string {
  const p = n.payload;
  switch (n.type) {
    case 'NEED_MATCHED':
      return 'A new buyer request matches what you offer.';
    case 'OFFER_RECEIVED': {
      const a = amount(p, 'price');
      return a ? `You received an offer of ${a} on your request.` : 'You received a new offer.';
    }
    case 'OFFER_COUNTERED': {
      const a = amount(p, 'price');
      return a ? `You received a counter-offer of ${a}.` : 'You received a counter-offer.';
    }
    case 'OFFER_ACCEPTED': {
      const a = amount(p, 'price');
      return a ? `Your offer of ${a} was accepted.` : 'Your offer was accepted.';
    }
    case 'OFFER_REJECTED':
      return 'Your offer was declined.';
    case 'OFFER_CLOSED':
      return 'A request you made an offer on is no longer open.';
    case 'TRANSACTION_CREATED': {
      const a = amount(p, 'amount');
      return a
        ? `Your deal for ${a} is confirmed. Next steps are in the app.`
        : 'A new deal was created.';
    }
    case 'TRANSACTION_UPDATED':
      return copyFor(n).body;
    case 'NEED_EXPIRED':
      return 'Your request has expired. You can renew it in the app.';
    case 'NEED_FULFILLING':
      return 'Your request is being fulfilled.';
    case 'REVIEW_RECEIVED':
      return 'You received a new review.';
    case 'VERIFICATION_UPDATED':
      return p['status'] === 'VERIFIED'
        ? 'Your NID verification is approved.'
        : 'Your NID verification was not approved. See the app for details.';
    default:
      // Phase 2 types share the push copy: no amounts, names or free text.
      return copyFor(n).body;
  }
}

/**
 * Short SMS text. Built only from the notification's type and its non-sensitive payload, so it
 * can never carry another person's name or phone number. The only link is our own short path.
 */
export function renderSms(n: Notification, publicBaseUrl: string): string {
  return `Dorkar: ${body(n)} ${shortHost(publicBaseUrl)}/n/${n.id}`;
}

// ------------------------------------------------------------------------------- retry policy

export const SMS_RETRY_BASE_MS = 30_000;
export const SMS_RETRY_MAX_MS = 60 * 60_000;

/** Exponential backoff after the n-th failed attempt (1-based): 30s, 60s, 2m, 4m … capped at 1h. */
export const retryDelayMs = (attempt: number): number =>
  Math.min(SMS_RETRY_MAX_MS, SMS_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));

export type FailureOutcome = { status: 'PENDING'; retryInMs: number } | { status: 'FAILED' };

export const afterFailure = (attempt: number, maxAttempts: number): FailureOutcome =>
  attempt >= maxAttempts
    ? { status: 'FAILED' }
    : { status: 'PENDING', retryInMs: retryDelayMs(attempt) };
