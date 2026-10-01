/**
 * Bootstrap/break-glass role grant: `grant-role <phone> <ROLE>`.
 * Day-to-day grants go through the admin API (`role:grant`); this CLI exists so the very first
 * SUPER_ADMIN can be created. Every use is written to the audit log.
 */
import { normalizeBdPhone, Roles, type Role } from '@dorkar/contracts';
import { createDatabase, createLogger, systemContext, uuidv7 } from '@dorkar/kernel';
import { loadIdentityConfig } from '../config/env';
import type { IdentityDB } from '../infrastructure/db-schema';
import { createPgUnitOfWork } from '../infrastructure/pg-unit-of-work';

const [phoneArg, roleArg] = process.argv.slice(2);
const phone = normalizeBdPhone(phoneArg ?? '');
if (!phone || !Roles.includes(roleArg as Role)) {
  console.error(`usage: grant-role <bd-phone> <${Roles.join('|')}>`);
  process.exit(2);
}

const config = loadIdentityConfig();
const logger = createLogger({
  service: 'identity-cli',
  version: 'n/a',
  env: config.NODE_ENV,
  level: 'info',
});
const database = createDatabase<IdentityDB>(config);
const uow = createPgUnitOfWork(database.db);

try {
  await uow.transaction(async (r) => {
    const { account } = await r.accounts.getOrCreateByPhone(uuidv7(), phone);
    await r.accounts.grantRole(account.id, roleArg as Role, null);
    await r.audit(systemContext(`cli-${uuidv7()}`), {
      action: 'admin.role_granted',
      actorType: 'SYSTEM',
      targetType: 'account',
      targetId: account.id,
      metadata: { role: roleArg, via: 'cli' },
    });
    logger.info({ accountId: account.id, role: roleArg }, 'role granted');
  });
} finally {
  await database.close();
}
