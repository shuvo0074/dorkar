import { kernelMigration, type Migration } from '@dorkar/kernel';
import { m0001Catalog } from './0001_catalog';
import { m0002SeedCategories } from './0002_seed_categories';
import { m0003StockReservations } from './0003_stock_reservations';

export const migrations: readonly Migration[] = [
  kernelMigration,
  m0001Catalog,
  m0002SeedCategories,
  m0003StockReservations,
];
