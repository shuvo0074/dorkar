import { runMigrateCli } from '@dorkar/kernel';
import { migrations } from '../../migrations';

await runMigrateCli({ service: 'rental', defaultSchema: 'rental', migrations });
