import {
  kernelIdempotencyMigration,
  kernelMigration,
  kernelOutboxTraceMigration,
  type Migration,
} from '@dorkar/kernel';
import { m0001Offer } from './0001_offer';

/** Explicit, ordered list (bundler-friendly; no filesystem scanning at runtime). */
export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelIdempotencyMigration,
  kernelOutboxTraceMigration,
  m0001Offer,
];
