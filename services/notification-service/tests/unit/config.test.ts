import { ConfigError, loadConfig } from '@dorkar/kernel';
import { testServiceEnv } from '@dorkar/kernel/testing';
import { describe, expect, it } from 'vitest';
import { notificationEnvSchema } from '../../src/app';

describe('config', () => {
  it('has sane defaults', () => {
    const c = loadConfig(notificationEnvSchema, testServiceEnv('notification'));
    expect(c).toMatchObject({
      SMS_PROVIDER: 'file',
      SMS_FILE_PATH: 'var/notification-sms.log',
      SMS_MAX_ATTEMPTS: 5,
      NOTIFICATION_RETENTION_DAYS: 90,
      IDENTITY_URL: 'http://localhost:4001',
    });
  });

  it('refuses the file SMS provider in production', () => {
    expect(() =>
      loadConfig(notificationEnvSchema, {
        ...testServiceEnv('notification'),
        NODE_ENV: 'production',
      }),
    ).toThrow(ConfigError);
  });
});
