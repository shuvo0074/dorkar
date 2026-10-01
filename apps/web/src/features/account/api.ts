import { api } from '../../lib/http';

export interface SessionView {
  id: string;
  deviceId: string;
  createdAt: string;
  lastRefreshedAt: string | null;
  expiresAt: string;
  current: boolean;
}

export interface DeviceView {
  id: string;
  platform: 'web' | 'android' | 'ios';
  label: string | null;
  trust: 'UNTRUSTED' | 'TRUSTED' | 'REVOKED';
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export const accountApi = {
  sessions: () => api<{ data: SessionView[] }>('/api/v1/me/sessions').then((r) => r.data),
  devices: () => api<{ data: DeviceView[] }>('/api/v1/me/devices').then((r) => r.data),
  revokeDevice: (id: string) =>
    api<void>(`/api/v1/me/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
