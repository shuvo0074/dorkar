import { pseudonymize } from '@dorkar/kernel';

export const DevicePlatforms = ['web', 'android', 'ios'] as const;
export type DevicePlatform = (typeof DevicePlatforms)[number];

export type DeviceTrust = 'UNTRUSTED' | 'TRUSTED' | 'REVOKED';

/**
 * Client-generated random 256-bit secret (base64url). On the web it is a *risk signal* only —
 * it can be copied — so it never grants access by itself. Mobile apps (Stage 3) will replace it
 * with a hardware-backed key pair and challenge signing.
 */
export const DEVICE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const hashDeviceKey = (piiKey: string, deviceKey: string) =>
  pseudonymize(piiKey, `device:${deviceKey}`);

export interface Device {
  id: string;
  accountId: string;
  platform: DevicePlatform;
  label: string | null;
  trust: DeviceTrust;
  createdAt: Date;
  lastSeenAt: Date;
}
