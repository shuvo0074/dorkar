import { createAsyncStorage } from '@react-native-async-storage/async-storage';

/**
 * Small per-device conveniences (language, composer draft, device key), readable synchronously
 * after `hydrateStorage()` runs once at startup. Never for anything secret: the refresh token
 * goes to the keychain.
 */
const store = createAsyncStorage('dorkar');
const KEYS = ['dorkar.lang', 'dorkar.needDraft', 'dorkar.deviceKey'] as const;
export type StorageKey = (typeof KEYS)[number];

const cache = new Map<StorageKey, string>();

export async function hydrateStorage(): Promise<void> {
  try {
    const values = await store.getMany([...KEYS]);
    for (const k of KEYS) {
      const v = values[k];
      if (typeof v === 'string') cache.set(k, v);
    }
  } catch {
    // conveniences only: start with defaults
  }
}

export const kv = {
  get: (k: StorageKey) => cache.get(k) ?? null,
  set(k: StorageKey, v: string) {
    cache.set(k, v);
    store.setItem(k, v).catch(() => {});
  },
  remove(k: StorageKey) {
    cache.delete(k);
    store.removeItem(k).catch(() => {});
  },
};
