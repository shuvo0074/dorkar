import { api } from '../../lib/http';

export type MediaPurpose =
  'LISTING' | 'NEED' | 'OFFER' | 'AVATAR' | 'VERIFICATION' | 'MESSAGE' | 'DISPUTE' | 'LEND_ITEM';

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

export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export class UploadRejected extends Error {
  constructor(readonly reason: 'TYPE' | 'SIZE' | 'REJECTED') {
    super(reason);
  }
}

/**
 * In development the API hands out upload links on the gateway's own origin; the app reaches
 * the gateway through its dev proxy, so the same path is used same-origin. Real storage links
 * (another host) are used as given.
 */
function uploadTarget(url: string): string {
  try {
    const u = new URL(url, location.href);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return local && u.origin !== location.origin && u.pathname.startsWith('/api/')
      ? `${u.pathname}${u.search}`
      : u.toString();
  } catch {
    return url;
  }
}

const enc = encodeURIComponent;

export const mediaApi = {
  get: (id: string) => api<{ data: Media }>(`/api/v1/media/${enc(id)}`).then((r) => r.data),
  remove: (id: string) => api<void>(`/api/v1/media/${enc(id)}`, { method: 'DELETE' }),

  /** Signed upload: ask for a slot, put the bytes, then have the server check and process them. */
  async upload(file: File, purpose: MediaPurpose): Promise<Media> {
    if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) throw new UploadRejected('TYPE');
    if (file.size > PHOTO_MAX_BYTES) throw new UploadRejected('SIZE');
    const { data: slot } = await api<{ data: UploadCreated }>('/api/v1/media/uploads', {
      method: 'POST',
      body: { purpose, contentType: file.type, sizeBytes: file.size },
    });
    const put = await fetch(uploadTarget(slot.upload.url), {
      method: 'PUT',
      headers: slot.upload.headers,
      body: file,
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
