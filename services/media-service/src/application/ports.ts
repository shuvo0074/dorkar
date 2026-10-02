import type { EventEnvelope } from '@dorkar/contracts';
import type { AuditEntry, RequestContext } from '@dorkar/kernel';
import type {
  ImageType,
  Media,
  MediaPurpose,
  MediaStatus,
  UploadContentType,
  Variants,
  Visibility,
} from '../domain/media';

// ---------------------------------------------------------------- object storage

export interface UploadTarget {
  method: 'PUT';
  url: string;
  /** Headers the client must send with the upload (signed). */
  headers: Record<string, string>;
  expiresAt: Date;
}

/**
 * Bytes live in object storage, never in Postgres. Adapters: S3-compatible (production) and
 * local disk (development/tests).
 */
export interface ObjectStorage {
  /** A pre-signed, single-object, exact-size, exact-type direct upload. */
  createUploadTarget(
    key: string,
    contentType: string,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<UploadTarget>;
  /** The object's bytes, or null if nothing was uploaded under the key. */
  get(key: string): Promise<Buffer | null>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  signedReadUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------- processing

export interface ContentSniffer {
  /** MIME type from magic bytes, or null when unknown. */
  sniff(bytes: Buffer): Promise<string | null>;
}

export interface ProcessedImage {
  original: { body: Buffer; width: number; height: number };
  variants: Array<{ name: 'thumb' | 'medium'; body: Buffer; width: number; height: number }>;
}

/** Thrown by the image processor when bytes cannot be decoded safely (corrupt, too many pixels). */
export class ImageDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImageDecodeError';
  }
}

export interface ImageProcessor {
  /**
   * Decode with a pixel limit, auto-orient and re-encode (dropping all metadata incl. EXIF/GPS),
   * and produce WebP variants.
   */
  process(bytes: Buffer, format: ImageType): Promise<ProcessedImage>;
}

export type ScanResult = { clean: true } | { clean: false; signature: string };

/**
 * Antivirus hook, called before an object becomes READY. The default `NoopScanner` accepts
 * everything; a ClamAV adapter (clamd INSTREAM over TCP) implements this same port.
 */
export interface MalwareScanner {
  scan(bytes: Buffer, contentType: string): Promise<ScanResult>;
}

// ---------------------------------------------------------------- persistence

export interface NewMedia {
  id: string;
  ownerId: string;
  purpose: MediaPurpose;
  visibility: Visibility;
  declaredContentType: UploadContentType;
  declaredSize: number;
  storageKey: string;
  expiresAt: Date;
}

export interface ReadyPatch {
  sniffedMime: UploadContentType;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  variants: Variants;
  width: number | null;
  height: number | null;
}

export interface MediaStore {
  get(id: string): Promise<Media | null>;
  /** Serializes concurrent creations by one owner (transaction-scoped). */
  lockOwner(ownerId: string): Promise<void>;
  countPending(ownerId: string): Promise<number>;
  insert(m: NewMedia): Promise<Media>;
  /** Guarded transitions: return null if the row was not in `from` at `version`. */
  markReady(id: string, version: number, patch: ReadyPatch): Promise<Media | null>;
  markRejected(
    id: string,
    version: number,
    reason: string,
    facts: { sniffedMime: string | null; sizeBytes: number; sha256: string | null },
  ): Promise<Media | null>;
  markDeleted(id: string, version: number, from: MediaStatus): Promise<Media | null>;
  /** PENDING_UPLOAD rows past their deadline, locked for this transaction. */
  claimExpiredPending(limit: number): Promise<Media[]>;
  outbox(events: EventEnvelope<unknown> | EventEnvelope<unknown>[]): Promise<void>;
  audit(ctx: RequestContext, entry: AuditEntry): Promise<void>;
}

export interface MediaUnitOfWork {
  readonly store: MediaStore;
  transaction<T>(fn: (store: MediaStore) => Promise<T>): Promise<T>;
}
