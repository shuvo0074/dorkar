import { loadConfig, type ConfigError } from '@dorkar/kernel';
import { testServiceEnv } from '@dorkar/kernel/testing';
import { describe, expect, it } from 'vitest';
import { mediaEnvSchema } from '../../src/app';

const env = (extra: Record<string, string>) => ({
  ...testServiceEnv('media'),
  SERVICE_NAME: 'media-service',
  ...extra,
});
const issues = (e: Record<string, string>) => {
  try {
    loadConfig(mediaEnvSchema, e);
    return [];
  } catch (err) {
    return (err as ConfigError).issues;
  }
};

describe('media config', () => {
  it('defaults to local storage with port 4006 and schema media', () => {
    const c = loadConfig(mediaEnvSchema, {
      ...env({ MEDIA_SIGNING_KEY: 's'.repeat(32) }),
      PORT: '4006',
      DATABASE_SCHEMA: 'media',
    });
    expect(c).toMatchObject({ MEDIA_STORAGE: 'local', PORT: 4006, MEDIA_LOCAL_DIR: 'var/media' });
  });

  it('refuses local storage in production', () => {
    const found = issues(
      env({ NODE_ENV: 'production', MEDIA_STORAGE: 'local', MEDIA_SIGNING_KEY: 's'.repeat(32) }),
    );
    expect(found.join('\n')).toMatch(/MEDIA_STORAGE: local storage is for development only/);
  });

  it('requires a signing key for local storage and a bucket for s3', () => {
    expect(issues(env({})).join('\n')).toMatch(/MEDIA_SIGNING_KEY/);
    expect(issues(env({ MEDIA_STORAGE: 's3' })).join('\n')).toMatch(/S3_BUCKET/);
    expect(
      issues(env({ MEDIA_STORAGE: 's3', S3_BUCKET: 'dorkar', S3_ACCESS_KEY_ID: 'a' })).join('\n'),
    ).toMatch(/S3_SECRET_ACCESS_KEY/);
    expect(
      issues(
        env({
          NODE_ENV: 'production',
          MEDIA_STORAGE: 's3',
          S3_BUCKET: 'dorkar',
          S3_ENDPOINT: 'https://sgp1.digitaloceanspaces.com',
          S3_FORCE_PATH_STYLE: 'false',
        }),
      ),
    ).toEqual([]);
  });
});
