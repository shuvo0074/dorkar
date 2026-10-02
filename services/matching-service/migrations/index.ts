import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Matching } from './0001_matching';
import { m0002MsCreatedAt } from './0002_ms_created_at';

export const migrations: readonly Migration[] = [kernelMigration, m0001Matching, m0002MsCreatedAt];
