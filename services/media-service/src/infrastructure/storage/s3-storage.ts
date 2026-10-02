import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStorage, UploadTarget } from '../../application/ports';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible providers (DigitalOcean Spaces, R2, MinIO). */
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  /** Omit to use the SDK's default credential chain (instance role, env, profile). */
  credentials?: { accessKeyId: string; secretAccessKey: string } | undefined;
}

/**
 * Any S3-compatible object store. Uses only the core S3 API (Put/Get/Delete + SigV4 presigning):
 * no vendor-specific features. The bucket must be private; reads go through signed URLs.
 */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly opts: S3StorageOptions) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      // Default CRC checksums are not supported by every S3-compatible provider and would have
      // to be computed by browsers for presigned uploads.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async createUploadTarget(
    key: string,
    contentType: string,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<UploadTarget> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: sizeBytes,
      }),
      // Signing both headers makes the store refuse any other type or size.
      { expiresIn: ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return {
      method: 'PUT',
      url,
      headers: { 'content-type': contentType },
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (
        err instanceof S3ServiceException &&
        (err.name === 'NoSuchKey' || err.$metadata.httpStatusCode === 404)
      ) {
        return null;
      }
      throw err;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentDisposition: contentType.startsWith('image/') ? 'inline' : 'attachment',
        CacheControl: 'private, max-age=600',
      }),
    );
  }

  async signedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    });
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
}
