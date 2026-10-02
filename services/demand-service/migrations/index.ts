import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Demand } from './0001_demand';

export const migrations: readonly Migration[] = [kernelMigration, m0001Demand];
