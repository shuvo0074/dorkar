import { reachableUrl } from '../../config';
import { api } from '../../lib/http';

/** Native twin of apps/web/src/features/media/api.ts: uploads a picked file by its local uri. */
export type MediaPurpose =
  | 'LISTING'
  | 'NEED'
  | 'OFFER'
  | 'AVATAR'
  | 'VERIFICATION'
  | 'MESSAGE'
  | 'DISPUTE'
  | 'LEND_ITEM';

export interface Media {
  id: string;
  purpose: MediaPurpose;
  status: 'PENDING_UPLOAD' | 'READY' | 'REJECTED' | 'DELETED';
  contentType: string | null;
  width: number | null;
  height: number | null;
  rejectionReason: string | null;
  createdAt: string;
  urls: { original?: string; thumb?: string; medium?: string };
  urlsExpireAt: string | null;
}

interface UploadCreated {
  mediaId: string;
  upload: { method: 'PUT'; url: string; headers: Record<string, string> };
  expiresAt: string;
}

export interface PickedFile {
  uri: string;
  type: string;
  size: number;
}

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export class UploadRejected extends Error {
  constructor(readonly reason: 'TYPE' | 'SIZE' | 'REJECTED') {
    super(reason);
  }
}

const enc = encodeURIComponent;

export const mediaApi = {
  get: (id: string) =>
    api<{ data: Media }>(`/api/v1/media/${enc(id)}`).then((r) => {
      const urls: Media['urls'] = {};
      for (const [k, v] of Object.entries(r.data.urls)) {
        if (v) urls[k as keyof Media['urls']] = reachableUrl(v);
      }
      return { ...r.data, urls };
    }),
  remove: (id: string) => api<void>(`/api/v1/media/${enc(id)}`, { method: 'DELETE' }),

  /** Signed upload: ask for a slot, put the bytes, then have the server check and process them. */
  async upload(file: PickedFile, purpose: MediaPurpose): Promise<Media> {
    if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) throw new UploadRejected('TYPE');
    if (file.size > PHOTO_MAX_BYTES) throw new UploadRejected('SIZE');
    const { data: slot } = await api<{ data: UploadCreated }>('/api/v1/media/uploads', {
      method: 'POST',
      body: { purpose, contentType: file.type, sizeBytes: file.size },
    });
    const bytes = await (await fetch(file.uri)).blob();
    const put = await fetch(reachableUrl(slot.upload.url), {
      method: 'PUT',
      headers: slot.upload.headers,
      body: bytes,
    });
    if (!put.ok) throw new UploadRejected('REJECTED');
    const { data: media } = await api<{ data: Media }>(
      `/api/v1/media/${enc(slot.mediaId)}/complete`,
      { method: 'POST' },
    );
    if (media.status !== 'READY') throw new UploadRejected('REJECTED');
    return media;
  },
};
