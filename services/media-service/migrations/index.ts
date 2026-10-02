import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Media } from './0001_media';

export const migrations: readonly Migration[] = [kernelMigration, m0001Media];
