import {
  kernelIdempotencyMigration,
  kernelMigration,
  kernelOutboxTraceMigration,
  type Migration,
} from '@dorkar/kernel';
import { m0001Lending } from './0001_lending';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelIdempotencyMigration,
  kernelOutboxTraceMigration,
  m0001Lending,
];
