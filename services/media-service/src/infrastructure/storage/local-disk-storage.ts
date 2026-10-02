import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, hmacSha256, randomToken, safeEqual } from '@dorkar/kernel';
import type { ObjectStorage, UploadTarget } from '../../application/ports';
import { mediaIdFromUploadKey } from '../../domain/media';

export interface LocalDiskOptions {
  /** Directory holding the objects. */
  root: string;
  /** HMAC key for upload and read URLs (≥ 32 chars). */
  signingKey: string;
  /** Origin clients reach this service at (usually the gateway), e.g. http://localhost:8080. */
  publicBaseUrl: string;
}

/** Keys are lowercase path segments; no dot-segments, no hidden files, no sidecar names. */
const KEY = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9._-]*)*$/;
const META_SUFFIX = '.meta.json';

export class InvalidKeyError extends Error {
  constructor() {
    super('Invalid object key.');
    this.name = 'InvalidKeyError';
  }
}

class ExactSize extends Transform {
  received = 0;
  constructor(private readonly expected: number) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    this.received += chunk.length;
    if (this.received > this.expected) {
      cb(
        new AppError('PAYLOAD_TOO_LARGE', 'The upload is larger than declared.', {
          declaredBytes: this.expected,
        }),
      );
      return;
    }
    this.push(chunk);
    cb();
  }
}

/**
 * Development/test adapter: objects on local disk, served by this service through HMAC-signed,
 * expiring URLs that mimic S3 pre-signed URLs. Refused in production by config validation.
 */
export class LocalDiskStorage implements ObjectStorage {
  private readonly root: string;
  private readonly base: string;

  constructor(private readonly opts: LocalDiskOptions) {
    this.root = resolve(opts.root);
    this.base = opts.publicBaseUrl.replace(/\/+$/, '');
  }

  /** Resolves a key to a path that is guaranteed to stay inside the root. */
  pathOf(key: string): string {
    if (key.length > 256 || !KEY.test(key) || key.endsWith(META_SUFFIX)) {
      throw new InvalidKeyError();
    }
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new InvalidKeyError();
    return p;
  }

  // ---- signatures

  private sign(kind: 'put' | 'get', subject: string, expires: number): string {
    return hmacSha256(this.opts.signingKey, `${kind}\n${subject}\n${expires}`).toString(
      'base64url',
    );
  }

  private verify(kind: 'put' | 'get', subject: string, expires: string, sig: string): boolean {
    if (!/^\d{1,12}$/.test(expires)) return false;
    const exp = Number(expires);
    if (exp * 1000 <= Date.now()) return false;
    const expected = Buffer.from(this.sign(kind, subject, exp));
    return safeEqual(expected, Buffer.from(sig));
  }

  verifyUpload(mediaId: string, expires: string, sig: string): boolean {
    return this.verify('put', mediaId, expires, sig);
  }

  verifyRead(key: string, expires: string, sig: string): boolean {
    return this.verify('get', key, expires, sig);
  }

  // ---- ObjectStorage

  async createUploadTarget(
    key: string,
    contentType: string,
    _sizeBytes: number,
    ttlSeconds: number,
  ): Promise<UploadTarget> {
    const id = mediaIdFromUploadKey(key);
    if (!id) throw new InvalidKeyError();
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const q = new URLSearchParams({ expires: String(expires), sig: this.sign('put', id, expires) });
    return {
      method: 'PUT',
      url: `${this.base}/api/v1/media/uploads/${id}/content?${q.toString()}`,
      headers: { 'content-type': contentType },
      expiresAt: new Date(expires * 1000),
    };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const p = this.pathOf(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomToken(6)}.part`;
    await writeFile(tmp, body);
    await writeFile(`${p}${META_SUFFIX}`, JSON.stringify({ contentType }));
    await rename(tmp, p);
  }

  /**
   * Streams a request body to disk, accepting exactly `sizeBytes` bytes: larger bodies are cut
   * off as soon as they pass the limit, shorter ones are discarded.
   */
  async writeStream(
    key: string,
    body: Readable,
    sizeBytes: number,
    contentType: string,
  ): Promise<void> {
    const p = this.pathOf(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomToken(6)}.part`;
    const counter = new ExactSize(sizeBytes);
    try {
      await pipeline(body, counter, createWriteStream(tmp, { flags: 'wx' }));
      if (counter.received !== sizeBytes) {
        throw new AppError('VALIDATION_FAILED', 'The upload is smaller than declared.', {
          declaredBytes: sizeBytes,
          receivedBytes: counter.received,
        });
      }
      await writeFile(`${p}${META_SUFFIX}`, JSON.stringify({ contentType }));
      await rename(tmp, p);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  /** For the signed-read route: the stream, its stored content type and size; null if missing. */
  async open(key: string): Promise<{ body: Readable; contentType: string; size: number } | null> {
    const p = this.pathOf(key);
    try {
      const [st, meta] = await Promise.all([stat(p), readFile(`${p}${META_SUFFIX}`, 'utf8')]);
      const { contentType } = JSON.parse(meta) as { contentType: string };
      return { body: createReadStream(p), contentType, size: st.size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async signedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    this.pathOf(key);
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const q = new URLSearchParams({
      expires: String(expires),
      sig: this.sign('get', key, expires),
    });
    return `${this.base}/api/v1/media/files/${key}?${q.toString()}`;
  }

  async delete(key: string): Promise<void> {
    const p = this.pathOf(key);
    await rm(p, { force: true });
    await rm(`${p}${META_SUFFIX}`, { force: true });
  }
}
