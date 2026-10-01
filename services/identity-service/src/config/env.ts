import { baseEnvSchema, isProductionLike, loadConfig } from '@dorkar/kernel';
import { z } from 'zod';

const secret = (name: string) =>
  z.string().min(32, `${name} must be at least 32 characters of high-entropy secret`);

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);

/** PEM may be given raw or base64-encoded (env-file friendly). */
const pem = z
  .string()
  .transform((v) => (v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8')));

export const identityEnvSchema = baseEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('identity-service'),
    PORT: z.coerce.number().int().default(4001),
    DATABASE_SCHEMA: z.string().default('identity'),

    JWT_PRIVATE_KEY: pem,
    JWT_KEY_ID: z.string().min(1),
    JWT_PREVIOUS_PUBLIC_JWKS: z
      .string()
      .default('[]')
      .transform((v, ctx) => {
        try {
          return JSON.parse(v) as Record<string, unknown>[];
        } catch {
          ctx.addIssue({ code: 'custom', message: 'must be a JSON array of JWKs' });
          return z.NEVER;
        }
      }),
    JWT_ISSUER: z.string().default('dorkar-identity'),
    JWT_AUDIENCE: z.string().default('dorkar-api'),
    ACCESS_TOKEN_TTL_SECONDS: int(600, 60),
    REFRESH_IDLE_TTL_SECONDS: int(30 * 86_400, 3600),
    SESSION_ABSOLUTE_TTL_SECONDS: int(90 * 86_400, 3600),

    OTP_PEPPER: secret('OTP_PEPPER'),
    PII_HASH_KEY: secret('PII_HASH_KEY'),
    OTP_LENGTH: int(6, 4).pipe(z.number().max(8)),
    OTP_TTL_SECONDS: int(300, 60),
    OTP_MAX_ATTEMPTS: int(5),
    OTP_RESEND_COOLDOWN_SECONDS: int(60),
    OTP_PER_PHONE_PER_HOUR: int(5),
    OTP_PER_PHONE_PER_DAY: int(10),
    OTP_PER_IP_PER_HOUR: int(20),
    OTP_PER_DEVICE_PER_HOUR: int(10),
    OTP_GLOBAL_PER_MINUTE: int(600),
    OTP_VERIFY_PER_IP_PER_HOUR: int(60),
    OTP_LOCKOUT_AFTER_EXHAUSTED: int(3),
    OTP_LOCKOUT_WINDOW_SECONDS: int(3600),

    SMS_PROVIDER: z.enum(['file']).default('file'),
    SMS_FILE_PATH: z.string().default('var/dev-sms.log'),
    WEBOTP_DOMAIN: z.string().optional(),

    REFRESH_COOKIE_SECURE: bool.default(true),
    REFRESH_COOKIE_PATH: z.string().default('/api/v1/auth'),

    OUTBOX_RELAY_ENABLED: bool.default(true),
    JOBS_ENABLED: bool.default(true),
  })
  .superRefine((c, ctx) => {
    if (!isProductionLike(c)) return;
    if (c.NODE_ENV === 'production' && c.SMS_PROVIDER === 'file') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'the file SMS provider is for development/staging only; configure a real provider',
      });
    }
    if (!c.REFRESH_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['REFRESH_COOKIE_SECURE'],
        message: 'must be true outside development',
      });
    }
    if (c.OTP_PEPPER === c.PII_HASH_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['PII_HASH_KEY'],
        message: 'must differ from OTP_PEPPER',
      });
    }
    if (c.DATABASE_SSL === 'disable') {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_SSL'],
        message: 'TLS is required outside development',
      });
    }
  });

export type IdentityConfig = z.infer<typeof identityEnvSchema>;

export const loadIdentityConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig(identityEnvSchema, env);
