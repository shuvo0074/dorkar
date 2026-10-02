import { runMigrateCli } from '@dorkar/kernel';
import { migrations } from '../../migrations';

await runMigrateCli({ service: 'matching', defaultSchema: 'matching', migrations });
