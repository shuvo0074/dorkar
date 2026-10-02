import { runMigrateCli } from '@dorkar/kernel';
import { migrations } from '../../migrations';

await runMigrateCli({ service: 'bidding', defaultSchema: 'bidding', migrations });
