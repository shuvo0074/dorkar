import { kernelMigration, kernelOutboxTraceMigration, type Migration } from '@dorkar/kernel';
import { m0001Moderation } from './0001_moderation';
import { m0002Phase2Targets } from './0002_phase2_targets';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelOutboxTraceMigration,
  m0001Moderation,
  m0002Phase2Targets,
];
