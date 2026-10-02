import cookie from '@fastify/cookie';
import {
  createAuthenticator,
  createDatabase,
  createHttpServer,
  createRedis,
  OutboxRelay,
  RedisRateLimiter,
  RedisStreamPublisher,
  startPeriodicJob,
  type App,
  type Database,
  type Logger,
  type PeriodicJob,
  type Redis,
} from '@dorkar/kernel';
import type { IdentityDeps } from './application/deps';
import type { Clock, RateLimiter, SmsSender } from './application/ports';
import { ChangeAccountStatus } from './application/use-cases/admin';
import { RefreshSession } from './application/use-cases/refresh-session';
import { RequestOtp } from './application/use-cases/request-otp';
import {
  CheckSession,
  GetMyAccount,
  ListMyDevices,
  ListMySessions,
  Logout,
  LogoutAll,
  RevokeMyDevice,
} from './application/use-cases/sessions';
import { VerifyOtp } from './application/use-cases/verify-otp';
import type { IdentityConfig } from './config/env';
import type { IdentityDB } from './infrastructure/db-schema';
import { createPgUnitOfWork, purgeExpired } from './infrastructure/pg-unit-of-work';
import { FileSmsSender } from './infrastructure/sms/sms-senders';
import { JoseTokenService } from './infrastructure/token-issuer';
import { identityRoutes } from './interfaces/http/routes';
import { identityInternalRoutes } from './interfaces/http/internal-routes';
import { GetContact } from './application/use-cases/contact';

export interface IdentityOverrides {
  sms?: SmsSender;
  clock?: Clock;
  limiter?: RateLimiter;
}

export interface IdentityService {
  app: App;
  database: Database<IdentityDB>;
  /** Service-private keys (rate limits). */
  redis: Redis;
  /** Unprefixed connection for the shared event bus. */
  bus: Redis;
  /** Background workers (outbox relay, retention purge). */
  startWorkers(): void;
  stopWorkers(): Promise<void>;
  close(): Promise<void>;
}

/** Composition root: the only place that knows concrete implementations. */
export async function buildIdentityService(
  config: IdentityConfig,
  logger: Logger,
  overrides: IdentityOverrides = {},
): Promise<IdentityService> {
  const database = createDatabase<IdentityDB>(config);
  const redis = createRedis(config.REDIS_URL, { keyPrefix: 'identity', logger });
  const bus = createRedis(config.REDIS_URL, { keyPrefix: null, logger });
  const clock: Clock = overrides.clock ?? { now: () => new Date() };

  const tokens = await JoseTokenService.create(
    {
      privateKeyPem: config.JWT_PRIVATE_KEY,
      keyId: config.JWT_KEY_ID,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
      previousPublicJwks: config.JWT_PREVIOUS_PUBLIC_JWKS,
    },
    clock,
  );

  const deps: IdentityDeps = {
    uow: createPgUnitOfWork(database.db),
    limiter: overrides.limiter ?? new RedisRateLimiter(redis),
    sms: overrides.sms ?? new FileSmsSender(config.SMS_FILE_PATH),
    tokens,
    clock,
    logger,
    secrets: { otpPepper: config.OTP_PEPPER, piiKey: config.PII_HASH_KEY },
    otpPolicy: {
      length: config.OTP_LENGTH,
      ttlSeconds: config.OTP_TTL_SECONDS,
      maxAttempts: config.OTP_MAX_ATTEMPTS,
      resendCooldownSeconds: config.OTP_RESEND_COOLDOWN_SECONDS,
      perPhonePerHour: config.OTP_PER_PHONE_PER_HOUR,
      perPhonePerDay: config.OTP_PER_PHONE_PER_DAY,
      perIpPerHour: config.OTP_PER_IP_PER_HOUR,
      perDevicePerHour: config.OTP_PER_DEVICE_PER_HOUR,
      globalPerMinute: config.OTP_GLOBAL_PER_MINUTE,
      verifyPerIpPerHour: config.OTP_VERIFY_PER_IP_PER_HOUR,
      lockoutAfterExhausted: config.OTP_LOCKOUT_AFTER_EXHAUSTED,
      lockoutWindowSeconds: config.OTP_LOCKOUT_WINDOW_SECONDS,
    },
    sessionPolicy: {
      accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
      refreshIdleTtlSeconds: config.REFRESH_IDLE_TTL_SECONDS,
      sessionAbsoluteTtlSeconds: config.SESSION_ABSOLUTE_TTL_SECONDS,
    },
    webOtpDomain: config.WEBOTP_DOMAIN,
  };

  const checkSession = new CheckSession(deps);
  const auth = createAuthenticator({
    verifier: tokens.verifier(),
    sessionCheck: (claims) => checkSession.execute(claims.sid, claims.sub),
  });

  const app = await createHttpServer({
    config,
    logger,
    ipHashKey: config.PII_HASH_KEY,
    readiness: [
      { name: 'postgres', check: () => database.ping() },
      { name: 'redis', check: async () => void (await redis.ping()) },
    ],
    openapi: {
      title: 'Dorkar Identity API',
      description: 'Phone + OTP authentication, sessions and devices.',
    },
  });
  await app.register(cookie);
  await app.register(identityRoutes, {
    useCases: {
      requestOtp: new RequestOtp(deps),
      verifyOtp: new VerifyOtp(deps),
      refreshSession: new RefreshSession(deps),
      logout: new Logout(deps),
      logoutAll: new LogoutAll(deps),
      listSessions: new ListMySessions(deps),
      listDevices: new ListMyDevices(deps),
      revokeDevice: new RevokeMyDevice(deps),
      getAccount: new GetMyAccount(deps),
      changeAccountStatus: new ChangeAccountStatus(deps),
    },
    auth,
    jwks: tokens.jwks,
    cookie: {
      name: 'dorkar_rt',
      path: config.REFRESH_COOKIE_PATH,
      secure: config.REFRESH_COOKIE_SECURE,
    },
    allowedOrigins: config.CORS_ORIGINS,
  });
  if (config.INTERNAL_API_TOKEN) {
    await app.register(identityInternalRoutes, {
      token: config.INTERNAL_API_TOKEN,
      getContact: new GetContact(deps),
    });
  }

  const relay = new OutboxRelay(database.db, new RedisStreamPublisher(bus, 'identity'), logger, {
    producer: 'identity',
  });
  let purgeJob: PeriodicJob | null = null;

  const stopWorkers = async () => {
    await relay.stop();
    await purgeJob?.stop();
  };

  return {
    app,
    database,
    redis,
    bus,
    stopWorkers,
    startWorkers() {
      if (config.OUTBOX_RELAY_ENABLED) relay.start();
      if (config.JOBS_ENABLED) {
        purgeJob = startPeriodicJob({
          name: 'identity.purge-expired',
          intervalMs: 15 * 60_000,
          db: database.db,
          logger,
          run: purgeExpired,
        });
      }
    },
    async close() {
      await app.close();
      await stopWorkers();
      redis.disconnect();
      bus.disconnect();
      await database.close();
    },
  };
}
