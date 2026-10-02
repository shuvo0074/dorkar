import {
  kernelIdempotencyMigration,
  kernelMigration,
  kernelOutboxTraceMigration,
  type Migration,
} from '@dorkar/kernel';
import { m0001Dispute } from './0001_dispute';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelIdempotencyMigration,
  kernelOutboxTraceMigration,
  m0001Dispute,
];
