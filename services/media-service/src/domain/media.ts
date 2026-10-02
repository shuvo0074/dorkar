import type { MediaPurposes, Permission } from '@dorkar/contracts';
import { AppError } from '@dorkar/kernel';

export type MediaPurpose = (typeof MediaPurposes)[number];
export const MediaStatuses = ['PENDING_UPLOAD', 'READY', 'REJECTED', 'DELETED'] as const;
export type MediaStatus = (typeof MediaStatuses)[number];
export type Visibility = 'PUBLIC' | 'PRIVATE';

export const ImageTypes = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ImageType = (typeof ImageTypes)[number];
export const UploadContentTypes = [...ImageTypes, 'application/pdf'] as const;
export type UploadContentType = (typeof UploadContentTypes)[number];

export const MB = 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * MB;
export const MAX_PDF_BYTES = 5 * MB;
/** Unfinished uploads one owner may hold at a time. */
export const MAX_PENDING_PER_OWNER = 30;
export const UPLOAD_TTL_SECONDS = 15 * 60;
export const READ_URL_TTL_SECONDS = 10 * 60;

/** Image variants produced on completion, all WebP, by target width. */
export const VARIANT_WIDTHS = { thumb: 320, medium: 1280 } as const;
export type VariantName = keyof typeof VARIANT_WIDTHS;
export interface Variant {
  key: string;
  width: number;
  height: number;
}
export type Variants = Partial<Record<VariantName, Variant>>;

/** Who may read the object without it being public. */
export const PRIVATE_READ_PERMISSION: Permission = 'verification:nid:read';

/** Why processing refused an upload (stored, returned to the owner, put in MediaRejected). */
export type RejectionReason =
  'TYPE_MISMATCH' | 'SIZE_MISMATCH' | 'UNREADABLE_IMAGE' | 'MALWARE_DETECTED';

export interface Media {
  id: string;
  ownerId: string;
  purpose: MediaPurpose;
  visibility: Visibility;
  status: MediaStatus;
  declaredContentType: UploadContentType;
  declaredSize: number;
  sniffedMime: UploadContentType | null;
  sizeBytes: number | null;
  sha256: string | null;
  storageKey: string;
  variants: Variants;
  width: number | null;
  height: number | null;
  rejectionReason: string | null;
  createdAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  /** PENDING_UPLOAD past its deadline (evaluated by the database clock). */
  expired: boolean;
  version: number;
}

export const visibilityFor = (purpose: MediaPurpose): Visibility =>
  purpose === 'VERIFICATION' ? 'PRIVATE' : 'PUBLIC';

export const isImage = (t: string): t is ImageType => (ImageTypes as readonly string[]).includes(t);

export function allowedTypes(purpose: MediaPurpose): readonly UploadContentType[] {
  return purpose === 'VERIFICATION' ? UploadContentTypes : ImageTypes;
}

export const maxBytesFor = (contentType: UploadContentType) =>
  isImage(contentType) ? MAX_IMAGE_BYTES : MAX_PDF_BYTES;

const rule = (rule: string, message: string, details: Record<string, unknown> = {}) =>
  new AppError('BUSINESS_RULE_VIOLATION', message, { rule, ...details });

/** What the client declares is only an upper bound; the bytes are checked again on completion. */
export function assertUploadAllowed(
  purpose: MediaPurpose,
  contentType: UploadContentType,
  sizeBytes: number,
): void {
  if (!allowedTypes(purpose).includes(contentType)) {
    throw rule('TYPE_NOT_ALLOWED', 'This file type is not accepted here.', {
      allowed: allowedTypes(purpose),
    });
  }
  const max = maxBytesFor(contentType);
  if (sizeBytes > max) {
    throw rule('FILE_TOO_LARGE', `Files of this type may be at most ${max / MB} MB.`, {
      maxBytes: max,
    });
  }
}

export function assertPendingQuota(pendingCount: number): void {
  if (pendingCount >= MAX_PENDING_PER_OWNER) {
    throw rule(
      'UPLOAD_LIMIT',
      'Too many unfinished uploads. Finish or wait for them to expire, then try again.',
      { max: MAX_PENDING_PER_OWNER },
    );
  }
}

/**
 * Compare the sniffed (magic-byte) type with what the purpose allows and what the client
 * declared. Never trust the client's MIME type or filename.
 */
export function checkSniffedType(
  purpose: MediaPurpose,
  declared: UploadContentType,
  sniffed: string | null,
): RejectionReason | null {
  if (!sniffed) return 'TYPE_MISMATCH';
  if (!(allowedTypes(purpose) as readonly string[]).includes(sniffed)) return 'TYPE_MISMATCH';
  if (sniffed !== declared) return 'TYPE_MISMATCH';
  return null;
}

// ---- state machine

const TRANSITIONS: Readonly<Record<MediaStatus, readonly MediaStatus[]>> = {
  PENDING_UPLOAD: ['READY', 'REJECTED', 'DELETED'],
  READY: ['DELETED'],
  REJECTED: ['DELETED'],
  DELETED: [],
};

export const canTransition = (from: MediaStatus, to: MediaStatus) => TRANSITIONS[from].includes(to);

export function assertTransition(from: MediaStatus, to: MediaStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError('INVALID_STATE_TRANSITION', `Media cannot go from ${from} to ${to}.`, {
      from,
      to,
    });
  }
}

// ---- read policy

export interface Reader {
  id: string;
  permissions: ReadonlySet<Permission>;
}

/**
 * Owners see their own media in any live state. Others see only READY media: public media
 * to anyone, private media only with the verification reviewer permission.
 */
export function canRead(
  m: Pick<Media, 'ownerId' | 'status' | 'visibility'>,
  reader: Reader | null,
) {
  if (m.status === 'DELETED') return false;
  if (reader && reader.id === m.ownerId) return true;
  if (m.status !== 'READY') return false;
  if (m.visibility === 'PUBLIC') return true;
  return !!reader?.permissions.has(PRIVATE_READ_PERMISSION);
}

// ---- storage keys (always server-generated; never derived from client input)

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UPLOAD_KEY = new RegExp(`^uploads/(${UUID})$`);
const SERVABLE_KEY = new RegExp(`^media/${UUID}/(original|thumb\\.webp|medium\\.webp)$`);

/** Raw bytes as the client sent them; never served, deleted after processing. */
export const uploadKey = (id: string) => `uploads/${id}`;
/** Processed original (re-encoded for images). */
export const originalKey = (id: string) => `media/${id}/original`;
export const variantKey = (id: string, v: VariantName) => `media/${id}/${v}.webp`;

export const mediaIdFromUploadKey = (key: string): string | null =>
  UPLOAD_KEY.exec(key)?.[1] ?? null;

/** Only processed objects may be served through signed reads. */
export const isServableKey = (key: string) => SERVABLE_KEY.test(key);

/** Every key this media may have written. */
export function allKeys(m: Pick<Media, 'id' | 'storageKey' | 'variants'>): string[] {
  const keys = new Set([uploadKey(m.id), originalKey(m.id), m.storageKey]);
  for (const v of Object.values(m.variants)) if (v) keys.add(v.key);
  return [...keys];
}
