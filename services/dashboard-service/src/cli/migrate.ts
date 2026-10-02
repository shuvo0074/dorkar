import { runMigrateCli } from '@dorkar/kernel';
import { migrations } from '../../migrations';

await runMigrateCli({ service: 'dashboard', defaultSchema: 'dashboard', migrations });
