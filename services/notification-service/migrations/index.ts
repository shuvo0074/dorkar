import { kernelMigration, kernelOutboxTraceMigration, type Migration } from '@dorkar/kernel';
import { m0001Notification } from './0001_notification';
import { m0002PushAndPhase2 } from './0002_push_and_phase2';
import { m0003MsCreatedAt } from './0003_ms_created_at';

export const migrations: readonly Migration[] = [
  kernelMigration,
  kernelOutboxTraceMigration,
  m0001Notification,
  m0002PushAndPhase2,
  m0003MsCreatedAt,
];
