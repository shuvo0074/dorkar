import { kernelMigration, kernelOutboxTraceMigration, type Migration } from '@dorkar/kernel';
import { m0001Messaging } from './0001_messaging';

/** Explicit, ordered list (bundler-friendly; no filesystem scanning at runtime). */
export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelOutboxTraceMigration,
  m0001Messaging,
];
