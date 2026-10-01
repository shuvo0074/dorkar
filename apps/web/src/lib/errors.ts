import { ApiError } from './http';
import type { MessageKey } from './i18n';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Maps API error codes to copy that names the problem and the way out. */
export function errorMessage(err: unknown, t: T): string {
  if (!(err instanceof ApiError)) return t('error.generic');
  switch (err.code) {
    case 'INVALID_PHONE':
    case 'OTP_INVALID':
    case 'ACCOUNT_SUSPENDED':
    case 'NETWORK':
    case 'UNAVAILABLE':
      return t(`error.${err.code}`);
    case 'RATE_LIMITED':
      return t('error.RATE_LIMITED', { s: err.retryAfterSeconds ?? 60 });
    default:
      return t('error.generic');
  }
}
