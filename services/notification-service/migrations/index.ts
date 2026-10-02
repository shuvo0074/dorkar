import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Notification } from './0001_notification';

export const migrations: readonly Migration[] = [kernelMigration, m0001Notification];
