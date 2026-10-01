import { baseEnvSchema, isProductionLike, loadConfig } from '@dorkar/kernel';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const int = (def: number, min = 1) => z.coerce.number().int().min(min).default(def);

/** The gateway is stateless: no database, only Redis (rate limits, revocation denylist, events). */
export const gatewayEnvSchema = baseEnvSchema
  .omit({
    DATABASE_URL: true,
    DATABASE_SCHEMA: true,
    DATABASE_POOL_MAX: true,
    DATABASE_SSL: true,
    DATABASE_SSL_CA: true,
    DATABASE_STATEMENT_TIMEOUT_MS: true,
  })
  .extend({
    SERVICE_NAME: z.string().default('gateway'),
    PORT: z.coerce.number().int().default(4000),

    /** Upstream base URLs, one per service (private network addresses). */
    UPSTREAM_IDENTITY_URL: z.url(),

    JWKS_URL: z.url().optional(),
    JWT_ISSUER: z.string().default('dorkar-identity'),
    JWT_AUDIENCE: z.string().default('dorkar-api'),
    /** Must match identity's access-token TTL: revocation entries live this long. */
    ACCESS_TOKEN_TTL_SECONDS: int(600, 60),

    /** Keyed hash for client IPs in rate-limit keys and logs. */
    PII_HASH_KEY: z.string().min(32),
    RATE_LIMIT_IP_PER_MINUTE: int(300),
    RATE_LIMIT_ACTOR_PER_MINUTE: int(600),

    UPSTREAM_TIMEOUT_MS: int(10_000, 100),

    EVENTS_CONSUMER_ENABLED: bool.default(true),
    EVENTS_GROUP: z.string().default('gateway'),
  })
  .superRefine((c, ctx) => {
    if (isProductionLike(c) && c.TRUST_PROXY === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY'],
        message: 'set the number of reverse-proxy hops in front of the gateway (usually 1)',
      });
    }
  })
  .transform((c) => ({
    ...c,
    JWKS_URL: c.JWKS_URL ?? new URL('/.well-known/jwks.json', c.UPSTREAM_IDENTITY_URL).toString(),
  }));

export type GatewayConfig = z.infer<typeof gatewayEnvSchema>;

export const loadGatewayConfig = (env: Record<string, string | undefined> = process.env) =>
  loadConfig(gatewayEnvSchema, env);
