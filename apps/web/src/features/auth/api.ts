import type { AccountStatus, Role } from '@dorkar/contracts';
import { api } from '../../lib/http';

export interface Account {
  id: string;
  phoneMasked: string;
  status: AccountStatus;
  roles: Role[];
  createdAt: string;
}

export interface OtpChallenge {
  challengeId: string;
  expiresAt: string;
  resendAfterSeconds: number;
}

export interface SignedIn {
  accessToken: string;
  accessTokenExpiresAt: string;
  account: Account;
  isNewAccount: boolean;
}

export const authApi = {
  requestOtp: (phone: string, deviceKey: string) =>
    api<{ data: OtpChallenge }>('/api/v1/auth/request-otp', {
      method: 'POST',
      auth: false,
      body: { phone, deviceKey },
    }).then((r) => r.data),

  verifyOtp: (input: {
    challengeId: string;
    code: string;
    device: { key: string; platform: 'web'; label: string };
  }) =>
    api<{ data: SignedIn }>('/api/v1/auth/verify-otp', {
      method: 'POST',
      auth: false,
      body: input,
    }).then((r) => r.data),

  logout: () => api<void>('/api/v1/auth/logout', { method: 'POST' }),
  logoutAll: () =>
    api<{ data: { revokedSessions: number } }>('/api/v1/auth/logout-all', { method: 'POST' }),

  me: () => api<{ data: Account }>('/api/v1/me/account').then((r) => r.data),
};
