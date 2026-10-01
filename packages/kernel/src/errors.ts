import { ErrorCodes, type ErrorCode } from '@dorkar/contracts';

/**
 * The only error type application code throws on purpose. Anything else reaching the HTTP
 * layer is treated as a bug and returned as INTERNAL without details.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ErrorCodes[code];
  }
}

export const Errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError('VALIDATION_FAILED', message, details),
  unauthenticated: (message = 'Authentication required.') =>
    new AppError('UNAUTHENTICATED', message),
  forbidden: (message = 'You are not allowed to perform this action.') =>
    new AppError('FORBIDDEN', message),
  notFound: (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found.`),
  conflict: (message: string, details?: Record<string, unknown>) =>
    new AppError('CONFLICT', message, details),
  rateLimited: (retryAfterMs: number) =>
    new AppError(
      'RATE_LIMITED',
      'Too many requests. Please try again later.',
      { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
      { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
    ),
  unavailable: (message = 'Service temporarily unavailable.') =>
    new AppError('UNAVAILABLE', message, undefined, { 'retry-after': '5' }),
};
