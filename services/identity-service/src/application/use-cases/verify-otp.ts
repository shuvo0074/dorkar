import { IdentityEvents, type Role } from '@dorkar/contracts';
import { AppError, Errors, pseudonymize, uuidv7, type RequestContext } from '@dorkar/kernel';
import { canAuthenticate, effectiveRoles, type Account } from '../../domain/account';
import { hashDeviceKey, type DevicePlatform } from '../../domain/device';
import { otpMatches } from '../../domain/otp';
import { newRefreshToken, refreshExpiry, sessionExpiry } from '../../domain/session';
import { event, type IdentityDeps } from '../deps';

export interface VerifyOtpInput {
  challengeId: string;
  otp: string;
  device: { key: string; platform: DevicePlatform; label?: string | undefined };
}

export interface AuthenticatedSession {
  account: Account;
  roles: Role[];
  isNewAccount: boolean;
  sessionId: string;
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const invalid = () => new AppError('OTP_INVALID', 'The code is invalid or has expired.');
const HOUR = 3_600_000;

/**
 * Completes login. The attempt counter is incremented atomically *before* comparing, so
 * parallel guesses cannot exceed `maxAttempts`; consumption is a guarded update, so two
 * concurrent correct submissions yield exactly one session.
 */
export class VerifyOtp {
  constructor(
    private readonly d: Pick<
      IdentityDeps,
      'uow' | 'limiter' | 'tokens' | 'clock' | 'logger' | 'secrets' | 'otpPolicy' | 'sessionPolicy'
    >,
  ) {}

  async execute(input: VerifyOtpInput, ctx: RequestContext): Promise<AuthenticatedSession> {
    await this.throttleByIp(ctx);

    const attempt = await this.d.uow.repos.otp.registerAttempt(input.challengeId);
    if (!attempt) {
      await this.d.uow.repos.audit(ctx, {
        action: 'auth.otp_verify_failed',
        targetType: 'otp_challenge',
        targetId: input.challengeId,
        metadata: { reason: 'unusable' },
      });
      throw invalid();
    }

    const phoneKey = pseudonymize(this.d.secrets.piiKey, attempt.phone);
    if (!otpMatches(this.d.secrets.otpPepper, input.challengeId, input.otp, attempt.codeHash)) {
      const exhausted = attempt.attempts >= attempt.maxAttempts;
      if (exhausted) {
        await this.d.limiter
          .hit(`otp:exhausted:${phoneKey}`, this.d.otpPolicy.lockoutWindowSeconds * 1000)
          .catch((err: unknown) => this.d.logger.warn({ err }, 'could not record OTP exhaustion'));
      }
      await this.d.uow.repos.audit(ctx, {
        action: 'auth.otp_verify_failed',
        targetType: 'otp_challenge',
        targetId: input.challengeId,
        metadata: { reason: 'mismatch', attempts: attempt.attempts, exhausted },
      });
      throw invalid();
    }

    const now = this.d.clock.now();
    const sessionId = uuidv7();
    const refresh = newRefreshToken();
    const sessionExpiresAt = sessionExpiry(now, this.d.sessionPolicy);
    const refreshExpiresAt = refreshExpiry(now, sessionExpiresAt, this.d.sessionPolicy);

    const outcome = await this.d.uow.transaction(async (r) => {
      if (!(await r.otp.consume(input.challengeId))) return { kind: 'raced' as const };

      const { account, created } = await r.accounts.getOrCreateByPhone(uuidv7(), attempt.phone);
      if (created) {
        await r.audit(ctx, {
          action: 'auth.account_created',
          actorId: account.id,
          targetType: 'account',
          targetId: account.id,
        });
        await r.outbox(
          event(IdentityEvents.AccountCreated, account.id, { accountId: account.id }, ctx),
        );
      }
      if (!canAuthenticate(account.status)) {
        await r.audit(ctx, {
          action: 'auth.login_denied',
          actorId: account.id,
          targetType: 'account',
          targetId: account.id,
          metadata: { status: account.status },
        });
        return { kind: 'denied' as const };
      }

      const { device, created: newDevice } = await r.devices.upsert({
        id: uuidv7(),
        accountId: account.id,
        keyHash: hashDeviceKey(this.d.secrets.piiKey, input.device.key),
        platform: input.device.platform,
        label: input.device.label?.trim() || null,
      });
      if (newDevice) {
        await r.audit(ctx, {
          action: 'device.registered',
          actorId: account.id,
          targetType: 'device',
          targetId: device.id,
          metadata: { platform: device.platform },
        });
      }

      await r.sessions.create({
        id: sessionId,
        accountId: account.id,
        deviceId: device.id,
        expiresAt: sessionExpiresAt,
        ipHash: ctx.ipHash,
        userAgent: ctx.userAgent,
      });
      await r.refreshTokens.insert({
        id: uuidv7(),
        sessionId,
        hash: refresh.hash,
        expiresAt: refreshExpiresAt,
      });
      const roles = effectiveRoles(await r.accounts.roles(account.id));

      await r.audit(ctx, {
        action: 'auth.login_succeeded',
        actorId: account.id,
        targetType: 'session',
        targetId: sessionId,
        metadata: { deviceId: device.id, newDevice },
      });
      await r.outbox(
        event(
          IdentityEvents.UserLoggedIn,
          account.id,
          { accountId: account.id, sessionId, deviceId: device.id, newDevice },
          ctx,
        ),
      );
      return { kind: 'ok' as const, account, created, deviceId: device.id, roles };
    });

    if (outcome.kind === 'raced') throw invalid();
    if (outcome.kind === 'denied') {
      throw new AppError('ACCOUNT_SUSPENDED', 'This account is not active. Contact support.');
    }

    const access = await this.d.tokens.issueAccessToken({
      accountId: outcome.account.id,
      sessionId,
      deviceId: outcome.deviceId,
      roles: outcome.roles,
    });
    return {
      account: outcome.account,
      roles: outcome.roles,
      isNewAccount: outcome.created,
      sessionId,
      deviceId: outcome.deviceId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refreshExpiresAt,
    };
  }

  /** Verification is bounded by per-challenge attempts in Postgres, so here we fail open. */
  private async throttleByIp(ctx: RequestContext) {
    if (!ctx.ipHash) return;
    try {
      const v = await this.d.limiter.consume([
        {
          key: `otp:verify:ip:${ctx.ipHash}`,
          limit: this.d.otpPolicy.verifyPerIpPerHour,
          windowMs: HOUR,
        },
      ]);
      if (!v.allowed) throw Errors.rateLimited(v.retryAfterMs);
    } catch (err) {
      if (err instanceof AppError) throw err;
      this.d.logger.warn({ err }, 'rate limiter unavailable; continuing (verify is DB-bounded)');
    }
  }
}
