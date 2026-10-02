import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Reputation } from './0001_reputation';

export const migrations: readonly Migration[] = [kernelMigration, m0001Reputation];
