import { Platform } from 'react-native';

/**
 * Where the gateway is. In development: this machine (the Android emulator reaches it at
 * 10.0.2.2); for a physical phone set DEV_API_HOST to this machine's LAN address. Release builds
 * need the production address here before they ship.
 */
const DEV_API_HOST = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
const RELEASE_API_URL = 'https://api.dorkar.example';

export const API_URL = __DEV__ ? `http://${DEV_API_HOST}:4000` : RELEASE_API_URL;

/** Dev storage links name localhost, which means the emulator itself on Android. */
export function reachableUrl(url: string): string {
  return __DEV__
    ? url.replace(/^(https?:\/\/)(localhost|127\.0\.0\.1)(?=[:/])/, `$1${DEV_API_HOST}`)
    : url;
}
