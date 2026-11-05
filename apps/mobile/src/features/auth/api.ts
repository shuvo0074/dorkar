import { authApi as webAuthApi, type SignedIn } from '@web/features/auth/api';
import { api, storeRefreshToken } from '../../lib/http';

export * from '@web/features/auth/api';

interface NativeSignedIn extends SignedIn {
  refreshToken: string;
}

/** Native sign-in: the refresh token comes back in the body and goes straight to the keychain. */
export const nativeAuthApi = {
  ...webAuthApi,
  async verifyOtp(input: {
    challengeId: string;
    code: string;
    device: { key: string; platform: 'ios' | 'android'; label: string };
  }): Promise<SignedIn> {
    const { data } = await api<{ data: NativeSignedIn }>('/api/v1/auth/verify-otp', {
      method: 'POST',
      auth: false,
      body: input,
    });
    await storeRefreshToken(data.refreshToken);
    return data;
  },
};
