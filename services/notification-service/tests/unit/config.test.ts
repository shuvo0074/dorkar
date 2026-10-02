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
      PUSH_PROVIDER: 'file',
      PUSH_FILE_PATH: 'var/notification-push.log',
      PUSH_MAX_ATTEMPTS: 5,
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

  const issuesOf = (env: Record<string, string>): string[] => {
    try {
      loadConfig(notificationEnvSchema, { ...testServiceEnv('notification'), ...env });
      return [];
    } catch (err) {
      if (err instanceof ConfigError) return err.issues;
      throw err;
    }
  };

  it('refuses the file push provider in production, mirroring SMS', () => {
    expect(issuesOf({ NODE_ENV: 'production' }).some((i) => i.startsWith('PUSH_PROVIDER:'))).toBe(
      true,
    );
    expect(
      issuesOf({ NODE_ENV: 'production', PUSH_PROVIDER: 'none' }).some((i) =>
        i.startsWith('PUSH_PROVIDER:'),
      ),
    ).toBe(false);
    expect(issuesOf({ NODE_ENV: 'staging', PUSH_PROVIDER: 'file' })).toEqual([]);
  });

  it('fcm requires a well-formed base64 service account, and never echoes it', () => {
    const missing = issuesOf({ PUSH_PROVIDER: 'fcm' });
    expect(missing.some((i) => i.startsWith('FCM_SERVICE_ACCOUNT_JSON:'))).toBe(true);
    const secret = Buffer.from('{"private_key":"SECRET-KEY-MATERIAL"}').toString('base64');
    const bad = issuesOf({ PUSH_PROVIDER: 'fcm', FCM_SERVICE_ACCOUNT_JSON: secret });
    expect(bad.join('\n')).not.toContain('SECRET');
    expect(bad.join('\n')).not.toContain(secret);

    const ok = Buffer.from(
      JSON.stringify({
        project_id: 'dorkar-prod',
        client_email: 'push@dorkar-prod.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
      }),
    ).toString('base64');
    expect(issuesOf({ PUSH_PROVIDER: 'fcm', FCM_SERVICE_ACCOUNT_JSON: ok })).toEqual([]);
  });
});
