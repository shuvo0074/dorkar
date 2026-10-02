import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Dashboard } from './0001_dashboard';

export const migrations: readonly Migration[] = [kernelMigration, m0001Dashboard];
