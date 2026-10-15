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
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'CONFLICT':
    case 'INVALID_STATE_TRANSITION':
    case 'VERIFICATION_REQUIRED':
    case 'VALIDATION_FAILED':
    case 'NEED_QUANTITY_EXHAUSTED':
    case 'BUSINESS_RULE_VIOLATION':
    case 'PAYLOAD_TOO_LARGE':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'IDEMPOTENCY_IN_PROGRESS':
    case 'UNAUTHENTICATED':
      return t(`error.${err.code}`);
    case 'SESSION_REVOKED':
      return t('error.UNAUTHENTICATED');
    case 'RATE_LIMITED':
      return t('error.RATE_LIMITED', { s: err.retryAfterSeconds ?? 60 });
    default:
      return t('error.generic');
  }
}

/**
 * A domain rule the server named (`details.rule`), for pages that explain specific rules in
 * their own words. Undefined for every other error.
 */
export function ruleOf(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.code !== 'BUSINESS_RULE_VIOLATION') return undefined;
  const rule = err.details?.['rule'];
  return typeof rule === 'string' ? rule : undefined;
}

/** Field-level issues from a VALIDATION_FAILED response, keyed by the first path segment. */
export function fieldIssues(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.code !== 'VALIDATION_FAILED') return {};
  const issues = err.details?.['issues'];
  if (!Array.isArray(issues)) return {};
  const out: Record<string, string> = {};
  for (const i of issues as Array<{ path?: unknown; message?: unknown }>) {
    const first: unknown = Array.isArray(i.path) ? i.path[0] : i.path;
    const path = typeof first === 'string' || typeof first === 'number' ? String(first) : '';
    if (path && !out[path] && typeof i.message === 'string') out[path] = i.message;
  }
  return out;
}
