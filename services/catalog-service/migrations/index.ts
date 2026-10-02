import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Catalog } from './0001_catalog';
import { m0002SeedCategories } from './0002_seed_categories';

export const migrations: readonly Migration[] = [
  kernelMigration,
  m0001Catalog,
  m0002SeedCategories,
];
