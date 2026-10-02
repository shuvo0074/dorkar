import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Verification } from './0001_verification';

export const migrations: readonly Migration[] = [kernelMigration, m0001Verification];
