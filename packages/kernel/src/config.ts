import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const csv = z.string().transform((v) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Variables every service needs. Services extend this with their own. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1),
  SERVICE_VERSION: z.string().default('dev'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  DATABASE_SSL_CA: z.string().optional(),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),

  REDIS_URL: z.url({ protocol: /^rediss?$/ }),

  TRUST_PROXY: bool.default(false),
  CORS_ORIGINS: csv.default([]),
  API_DOCS_ENABLED: bool.optional(),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10_000),
});
export type BaseConfig = z.infer<typeof baseEnvSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse and validate environment variables. Fails fast at boot with every problem listed,
 * and never echoes values (they may be secrets).
 */
export function loadConfig<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}

export const isProductionLike = (c: Pick<BaseConfig, 'NODE_ENV'>) =>
  c.NODE_ENV === 'production' || c.NODE_ENV === 'staging';
