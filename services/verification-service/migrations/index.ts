import { kernelMigration, kernelOutboxTraceMigration, type Migration } from '@dorkar/kernel';
import { m0001Verification } from './0001_verification';
import { m0002Phase2Actions } from './0002_phase2_actions';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelOutboxTraceMigration,
  m0001Verification,
  m0002Phase2Actions,
];
