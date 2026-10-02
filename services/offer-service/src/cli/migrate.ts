import { runMigrateCli } from '@dorkar/kernel';
import { migrations } from '../../migrations';

await runMigrateCli({ service: 'offer', defaultSchema: 'offer', migrations });
