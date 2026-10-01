import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * Paths that must never reach logs. Values are replaced, not removed, so their presence is
 * still visible when debugging. Keep in sync with docs/architecture/04-security.md.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.otp',
  '*.phone',
  '*.phoneE164',
  '*.nid',
  '*.nidNumber',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.deviceKey',
  '*.secret',
  'body',
];

export interface LoggerOptions {
  service: string;
  version: string;
  env: string;
  level: string;
}

export function createLogger(opts: LoggerOptions, destination?: DestinationStream): Logger {
  return pino(
    {
      level: opts.level,
      base: { service: opts.service, version: opts.version, env: opts.env },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      formatters: { level: (label) => ({ level: label }) },
    },
    destination,
  );
}
