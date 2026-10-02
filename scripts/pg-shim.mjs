// Resolve `pg` from the kernel package (scripts/ has no node_modules of its own).
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve(import.meta.dirname, '../packages/kernel/package.json'));
export default require('pg');
