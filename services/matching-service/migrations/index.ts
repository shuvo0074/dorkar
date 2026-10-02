import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Matching } from './0001_matching';

export const migrations: readonly Migration[] = [kernelMigration, m0001Matching];
