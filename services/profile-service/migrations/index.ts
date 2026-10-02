import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Profile } from './0001_profile';

export const migrations: readonly Migration[] = [kernelMigration, m0001Profile];
