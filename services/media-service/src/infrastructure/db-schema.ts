import type { Generated, KernelTables } from '@dorkar/kernel';
import type { ColumnType } from 'kysely';
import type {
  MediaPurpose,
  MediaStatus,
  UploadContentType,
  Variants,
  Visibility,
} from '../domain/media';

export interface MediaDB extends KernelTables {
  media_objects: {
    id: string;
    owner_id: string;
    purpose: MediaPurpose;
    visibility: Visibility;
    status: Generated<MediaStatus>;
    declared_content_type: UploadContentType;
    declared_size: number;
    sniffed_mime: string | null;
    size_bytes: number | null;
    sha256: string | null;
    storage_key: string;
    /** jsonb: read as an object, written as a JSON string. */
    variants: ColumnType<Variants, string | undefined, string>;
    width: number | null;
    height: number | null;
    rejection_reason: string | null;
    created_at: Generated<Date>;
    ready_at: Date | null;
    expires_at: Date | null;
    version: Generated<number>;
  };
}
