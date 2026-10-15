import type { DeliveryMode, District, SellerRole } from '@dorkar/contracts';
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

export interface MyProfile {
  id: string;
  displayName: string;
  userType: 'INDIVIDUAL' | 'BUSINESS';
  bio: string | null;
  district: District | null;
  area: string | null;
  locale: 'en' | 'bn';
  avatarMediaId: string | null;
  memberSince: string;
  badges: Array<'PHONE_VERIFIED' | 'NID_VERIFIED' | 'BUSINESS_VERIFIED'>;
  capabilities: SellerCapabilities | null;
}

export interface SellerCapabilities {
  roles: SellerRole[];
  categoryIds: string[];
  serviceDistricts: District[];
  deliveryModes: DeliveryMode[];
  active: boolean;
}

export interface ProfilePatch {
  displayName?: string;
  userType?: 'INDIVIDUAL' | 'BUSINESS';
  bio?: string | null;
  district?: District | null;
  area?: string | null;
  locale?: 'en' | 'bn';
  avatarMediaId?: string | null;
}

export interface MyVerification {
  kind: 'PHONE' | 'NID' | 'BUSINESS';
  status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'REVOKED' | 'EXPIRED';
  verifiedAt: string | null;
  nidLast4: string | null;
}

export const profileApi = {
  get: () => api<{ data: MyProfile }>('/api/v1/me/profile').then((r) => r.data),
  update: (patch: ProfilePatch) =>
    api<{ data: MyProfile }>('/api/v1/me/profile', { method: 'PATCH', body: patch }).then(
      (r) => r.data,
    ),
  setCapabilities: (c: SellerCapabilities) =>
    api<{ data: SellerCapabilities }>('/api/v1/me/seller-capabilities', {
      method: 'PUT',
      body: c,
    }).then((r) => r.data),
  verifications: () =>
    api<{ data: MyVerification[] }>('/api/v1/me/verifications').then((r) => r.data),
  submitNid: (input: { nidNumber: string; dateOfBirth: string; fullName: string }) =>
    api<{ data: { kind: 'NID'; status: MyVerification['status'] } }>(
      '/api/v1/me/verifications/nid',
      { method: 'POST', body: input },
    ).then((r) => r.data),
};
