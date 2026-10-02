import {
  createServiceRuntime,
  isProductionLike,
  loadConfig,
  serviceEnvSchema,
  type AccessTokenVerifier,
  type Logger,
  type ServiceRuntime,
} from '@dorkar/kernel';
import { z } from 'zod';
import { MediaService } from './application/media-service';
import type { ObjectStorage } from './application/ports';
import type { MediaDB } from './infrastructure/db-schema';
import { pgMediaStore, pgMediaUnitOfWork } from './infrastructure/pg-media-store';
import {
  DEFAULT_MAX_INPUT_PIXELS,
  fileTypeSniffer,
  noopScanner,
  SharpImageProcessor,
} from './infrastructure/processing';
import { LocalDiskStorage } from './infrastructure/storage/local-disk-storage';
import { S3Storage } from './infrastructure/storage/s3-storage';
import { localStorageRoutes } from './interfaces/http/local-storage-routes';
import { mediaRoutes } from './interfaces/http/routes';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const mediaEnvSchema = serviceEnvSchema
  .extend({
    SERVICE_NAME: z.string().default('media-service'),
    PORT: z.coerce.number().int().default(4006),
    DATABASE_SCHEMA: z.string().default('media'),

    MEDIA_STORAGE: z.enum(['local', 's3']).default('local'),
    /** Public origin of signed local URLs (normally the gateway). */
    MEDIA_PUBLIC_BASE_URL: z.url().default('http://localhost:4006'),
    MEDIA_LOCAL_DIR: z.string().min(1).default('var/media'),
    /** HMAC key for local signed URLs. */
    MEDIA_SIGNING_KEY: z.string().min(32).optional(),
    MEDIA_MAX_INPUT_PIXELS: z.coerce.number().int().positive().default(DEFAULT_MAX_INPUT_PIXELS),

    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: z.string().min(3).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: bool.default(false),
  })
  .superRefine((c, ctx) => {
    if (c.MEDIA_STORAGE === 'local') {
      if (isProductionLike(c)) {
        ctx.addIssue({
          code: 'custom',
          path: ['MEDIA_STORAGE'],
          message: 'local storage is for development only; use s3 in production',
        });
      }
      if (!c.MEDIA_SIGNING_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['MEDIA_SIGNING_KEY'],
          message: 'required when MEDIA_STORAGE=local',
        });
      }
    } else {
      if (!c.S3_BUCKET) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_BUCKET'],
          message: 'required when MEDIA_STORAGE=s3',
        });
      }
      if (!!c.S3_ACCESS_KEY_ID !== !!c.S3_SECRET_ACCESS_KEY) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_SECRET_ACCESS_KEY'],
          message: 'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither',
        });
      }
    }
  });
export type MediaConfig = z.infer<typeof mediaEnvSchema>;

/** How often abandoned uploads are swept. */
const EXPIRY_SWEEP_MS = 60_000;

/** Composition root. */
export async function buildMediaService(
  env: Record<string, string | undefined>,
  logger: Logger,
  overrides: { verifier?: AccessTokenVerifier; storage?: ObjectStorage } = {},
): Promise<{ runtime: ServiceRuntime<MediaDB>; media: MediaService; storage: ObjectStorage }> {
  const config = loadConfig(mediaEnvSchema, env);
  const runtime = await createServiceRuntime<MediaDB>({
    config,
    logger,
    producer: 'media',
    openapi: {
      title: 'Dorkar Media API',
      description: 'Direct uploads, verification and processing of images and documents.',
    },
    ...(overrides.verifier ? { verifier: overrides.verifier } : {}),
  });

  const local =
    config.MEDIA_STORAGE === 'local'
      ? new LocalDiskStorage({
          root: config.MEDIA_LOCAL_DIR,
          signingKey: config.MEDIA_SIGNING_KEY!,
          publicBaseUrl: config.MEDIA_PUBLIC_BASE_URL,
        })
      : null;
  const storage =
    overrides.storage ??
    local ??
    new S3Storage({
      bucket: config.S3_BUCKET!,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      credentials:
        config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? {
              accessKeyId: config.S3_ACCESS_KEY_ID,
              secretAccessKey: config.S3_SECRET_ACCESS_KEY,
            }
          : undefined,
    });

  const media = new MediaService({
    uow: pgMediaUnitOfWork(runtime.db),
    event: runtime.event,
    storage,
    sniffer: fileTypeSniffer,
    images: new SharpImageProcessor(config.MEDIA_MAX_INPUT_PIXELS),
    scanner: noopScanner,
    logger,
  });

  runtime.every('media.expire-pending-uploads', EXPIRY_SWEEP_MS, (trx) =>
    media.expirePending(pgMediaStore(trx)),
  );

  await runtime.app.register(mediaRoutes, {
    media,
    runtime: runtime as unknown as ServiceRuntime<never>,
  });
  if (local && storage === local) {
    await runtime.app.register(localStorageRoutes, { media, store: local });
  }
  return { runtime, media, storage };
}
