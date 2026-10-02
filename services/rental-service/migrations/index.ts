import {
  kernelIdempotencyMigration,
  kernelMigration,
  kernelOutboxTraceMigration,
  type Migration,
} from '@dorkar/kernel';
import { m0001Rental } from './0001_rental';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelIdempotencyMigration,
  kernelOutboxTraceMigration,
  m0001Rental,
];
