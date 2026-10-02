import { kernelIdempotencyMigration, kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Transaction } from './0001_transaction';
import { m0002Phase2 } from './0002_phase2_sources_returns_disputes';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelIdempotencyMigration,
  m0001Transaction,
  m0002Phase2,
];
