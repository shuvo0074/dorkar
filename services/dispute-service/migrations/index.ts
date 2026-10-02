import { kernelIdempotencyMigration, kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Dispute } from './0001_dispute';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelIdempotencyMigration,
  m0001Dispute,
];
