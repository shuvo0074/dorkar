import { normalizeBdPhone } from '@dorkar/contracts';
import {
  AppError,
  Errors,
  pseudonymize,
  uuidv7,
  type RateLimitResult,
  type RateLimitRule,
  type RequestContext,
} from '@dorkar/kernel';
import { DEVICE_KEY_PATTERN, hashDeviceKey } from '../../domain/device';
import { generateOtp, hashOtp, otpMessage } from '../../domain/otp';
import type { IdentityDeps } from '../deps';

export interface RequestOtpInput {
  phone: string;
  deviceKey?: string | undefined;
}

export interface RequestOtpResult {
  challengeId: string;
  expiresAt: Date;
  resendAfterSeconds: number;
}

const HOUR = 3_600_000;

/**
 * Starts phone login. Responds identically whether or not an account exists (no enumeration).
 * Throttling fails *closed*: if Redis is unavailable we refuse to send, because SMS costs money
 * and pumping is the main abuse vector.
 */
export class RequestOtp {
  constructor(
    private readonly d: Pick<
      IdentityDeps,
      'uow' | 'limiter' | 'sms' | 'logger' | 'secrets' | 'otpPolicy' | 'webOtpDomain'
    >,
  ) {}

  async execute(input: RequestOtpInput, ctx: RequestContext): Promise<RequestOtpResult> {
    const phone = normalizeBdPhone(input.phone);
    if (!phone) throw new AppError('INVALID_PHONE', 'Enter a valid Bangladeshi mobile number.');

    const p = this.d.otpPolicy;
    const phoneKey = pseudonymize(this.d.secrets.piiKey, phone);
    const deviceKeyHash =
      input.deviceKey && DEVICE_KEY_PATTERN.test(input.deviceKey)
        ? hashDeviceKey(this.d.secrets.piiKey, input.deviceKey)
        : null;

    const rules: RateLimitRule[] = [
      { key: `otp:cooldown:${phoneKey}`, limit: 1, windowMs: p.resendCooldownSeconds * 1000 },
      { key: `otp:phone:h:${phoneKey}`, limit: p.perPhonePerHour, windowMs: HOUR },
      { key: `otp:phone:d:${phoneKey}`, limit: p.perPhonePerDay, windowMs: 24 * HOUR },
      { key: 'otp:global:m', limit: p.globalPerMinute, windowMs: 60_000 },
    ];
    if (ctx.ipHash)
      rules.push({ key: `otp:ip:${ctx.ipHash}`, limit: p.perIpPerHour, windowMs: HOUR });
    if (deviceKeyHash) {
      rules.push({ key: `otp:device:${deviceKeyHash}`, limit: p.perDevicePerHour, windowMs: HOUR });
    }

    let verdict: RateLimitResult;
    let exhausted: number;
    try {
      exhausted = await this.d.limiter.count(
        `otp:exhausted:${phoneKey}`,
        p.lockoutWindowSeconds * 1000,
      );
      verdict =
        exhausted >= p.lockoutAfterExhausted
          ? { allowed: false, retryAfterMs: p.lockoutWindowSeconds * 1000 }
          : await this.d.limiter.consume(rules);
    } catch (err) {
      this.d.logger.error({ err }, 'rate limiter unavailable; refusing to send OTP');
      throw Errors.unavailable();
    }
    if (!verdict.allowed) throw Errors.rateLimited(verdict.retryAfterMs);

    const challengeId = uuidv7();
    const otp = generateOtp(p.length);
    const { expiresAt } = await this.d.uow.transaction(async (r) => {
      const created = await r.otp.create({
        id: challengeId,
        phone,
        codeHash: hashOtp(this.d.secrets.otpPepper, challengeId, otp),
        ttlSeconds: p.ttlSeconds,
        maxAttempts: p.maxAttempts,
        ipHash: ctx.ipHash,
        deviceKeyHash,
      });
      await r.audit(ctx, {
        action: 'auth.otp_requested',
        targetType: 'phone',
        targetId: phoneKey,
        metadata: { challengeId },
      });
      return created;
    });

    try {
      await this.d.sms.send(phone, otpMessage(otp, p.ttlSeconds, this.d.webOtpDomain));
    } catch (err) {
      this.d.logger.error({ err, challengeId }, 'sms delivery failed');
      throw Errors.unavailable('Could not send the code right now. Please try again.');
    }

    return { challengeId, expiresAt, resendAfterSeconds: p.resendCooldownSeconds };
  }
}
