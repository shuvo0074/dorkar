import { kernelIdempotencyMigration, kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Transaction } from './0001_transaction';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelIdempotencyMigration,
  m0001Transaction,
];
