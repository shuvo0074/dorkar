import { createEventFactory, type Logger } from '@dorkar/kernel';
import type { OtpPolicy } from '../domain/otp';
import type { SessionPolicy } from '../domain/session';
import type { Clock, RateLimiter, SmsSender, TokenIssuer, UnitOfWork } from './ports';

/** Everything use cases may depend on — all abstractions, wired in the composition root. */
export interface IdentityDeps {
  uow: UnitOfWork;
  limiter: RateLimiter;
  sms: SmsSender;
  tokens: TokenIssuer;
  clock: Clock;
  logger: Logger;
  secrets: { otpPepper: string; piiKey: string };
  otpPolicy: OtpPolicy;
  sessionPolicy: SessionPolicy;
  webOtpDomain: string | undefined;
}

export const event = createEventFactory('identity');
