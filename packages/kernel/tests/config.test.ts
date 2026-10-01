import { describe, expect, it } from 'vitest';
import { baseEnvSchema, ConfigError, loadConfig } from '../src/config';

const valid = {
  SERVICE_NAME: 'x',
  PORT: '3000',
  DATABASE_URL: 'postgres://u:secretpw@db:5432/dorkar',
  DATABASE_SCHEMA: 'identity',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('parses and applies defaults', () => {
    const c = loadConfig(baseEnvSchema, valid);
    expect(c.PORT).toBe(3000);
    expect(c.NODE_ENV).toBe('development');
    expect(c.CORS_ORIGINS).toEqual([]);
    expect(c.TRUST_PROXY).toBe(false);
  });

  it('lists every problem and never echoes values', () => {
    try {
      loadConfig(baseEnvSchema, { ...valid, PORT: 'abc', DATABASE_URL: 'mysql://u:secretpw@x/y' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toContain('PORT');
      expect(msg).toContain('DATABASE_URL');
      expect(msg).not.toContain('secretpw');
    }
  });
});
