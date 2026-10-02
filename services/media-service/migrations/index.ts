import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Media } from './0001_media';
import { m0002MediaGrants } from './0002_media_grants';

export const migrations: readonly Migration[] = [kernelMigration, m0001Media, m0002MediaGrants];
