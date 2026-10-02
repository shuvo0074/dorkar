import { kernelMigration, kernelOutboxTraceMigration, type Migration } from '@dorkar/kernel';
import { m0001Profile } from './0001_profile';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelOutboxTraceMigration,
  m0001Profile,
];
