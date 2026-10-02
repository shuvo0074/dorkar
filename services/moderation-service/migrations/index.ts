import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Moderation } from './0001_moderation';

export const migrations: readonly Migration[] = [kernelMigration, m0001Moderation];
