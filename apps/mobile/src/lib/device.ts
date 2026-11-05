import { Platform } from 'react-native';
import { kv } from './storage';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A random per-install key: a risk signal only, 43 base64url characters as the API expects. */
export function deviceKey(): string {
  const existing = kv.get('dorkar.deviceKey');
  if (existing && /^[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(43));
  const created = Array.from(bytes, (b) => ALPHABET[b & 63]).join('');
  kv.set('dorkar.deviceKey', created);
  return created;
}

export const devicePlatform = (): 'ios' | 'android' => (Platform.OS === 'ios' ? 'ios' : 'android');

/** "Dorkar app on Android": shown to the user in their device list. */
export const deviceLabel = () => `Dorkar app on ${Platform.OS === 'ios' ? 'iOS' : 'Android'}`;
