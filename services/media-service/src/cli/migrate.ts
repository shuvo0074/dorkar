import { runMigrateCli } from '@dorkar/kernel';
import { migrations } from '../../migrations';

await runMigrateCli({ service: 'media', defaultSchema: 'media', migrations });
