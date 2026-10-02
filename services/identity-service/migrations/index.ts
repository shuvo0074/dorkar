import { kernelMigration, kernelOutboxTraceMigration, type Migration } from '@dorkar/kernel';
import { m0001Identity } from './0001_identity';

/** Explicit, ordered list (bundler-friendly; no filesystem scanning at runtime). */
export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelOutboxTraceMigration,
  m0001Identity,
];
