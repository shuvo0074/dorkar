import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Notification } from './0001_notification';
import { m0002PushAndPhase2 } from './0002_push_and_phase2';

export const migrations: readonly Migration[] = [
  kernelMigration,
  m0001Notification,
  m0002PushAndPhase2,
];
