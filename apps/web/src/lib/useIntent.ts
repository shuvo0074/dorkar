import { useCallback, useState } from 'react';
import { intentKey } from './http';

/**
 * One idempotency key per user intent: stable across retries of the same submission (a double
 * tap or a flaky network never makes two offers), renewed once that intent succeeds.
 */
export function useIntent() {
  const [key, setKey] = useState(intentKey);
  const renew = useCallback(() => setKey(intentKey()), []);
  return { key, renew };
}
