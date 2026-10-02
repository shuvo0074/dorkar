/** Stable, client-visible error codes. Adding is fine; renaming is a breaking change. */
export const ErrorCodes = {
  VALIDATION_FAILED: 400,
  INVALID_PHONE: 400,
  OTP_INVALID: 400,
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  SESSION_REVOKED: 401,
  FORBIDDEN: 403,
  ACCOUNT_SUSPENDED: 403,
  VERIFICATION_REQUIRED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  NEED_QUANTITY_EXHAUSTED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  BUSINESS_RULE_VIOLATION: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UNAVAILABLE: 503,
  UPSTREAM_TIMEOUT: 504,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}
