import { kernelIdempotencyMigration, kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Bidding } from './0001_bidding';

/** Explicit, ordered list (bundler-friendly; no filesystem scanning at runtime). */
export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelIdempotencyMigration,
  m0001Bidding,
];
