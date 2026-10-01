import type { BdPhoneE164 } from '@dorkar/contracts';
import { appendAudit, appendToOutbox } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { IdentityRepositories, UnitOfWork } from '../application/ports';
import type { Account } from '../domain/account';
import type { Device } from '../domain/device';
import type { IdentityDB } from './db-schema';

type Executor = Kysely<IdentityDB> | Transaction<IdentityDB>;

const toAccount = (r: Selectable<IdentityDB['accounts']>): Account => ({
  id: r.id,
  phoneE164: r.phone_e164,
  status: r.status,
  createdAt: r.created_at,
});

const toDevice = (r: Selectable<IdentityDB['devices']>): Device => ({
  id: r.id,
  accountId: r.account_id,
  platform: r.platform,
  label: r.label,
  trust: r.trust,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

function repositories(db: Executor): IdentityRepositories {
  return {
    accounts: {
      async findById(id, opts) {
        let q = db.selectFrom('accounts').selectAll().where('id', '=', id);
        if (opts?.forUpdate) q = q.forUpdate();
        const row = await q.executeTakeFirst();
        return row ? toAccount(row) : null;
      },
      async getOrCreateByPhone(id, phone: BdPhoneE164) {
        const inserted = await db
          .insertInto('accounts')
          .values({ id, phone_e164: phone })
          .onConflict((oc) => oc.column('phone_e164').doNothing())
          .returningAll()
          .executeTakeFirst();
        if (inserted) return { account: toAccount(inserted), created: true };
        const existing = await db
          .selectFrom('accounts')
          .selectAll()
          .where('phone_e164', '=', phone)
          .executeTakeFirstOrThrow();
        return { account: toAccount(existing), created: false };
      },
      async updateStatus(id, from, to, reason) {
        const r = await db
          .updateTable('accounts')
          .set((eb) => ({
            status: to,
            status_reason: reason,
            updated_at: new Date(),
            version: eb('version', '+', 1),
          }))
          .where('id', '=', id)
          .where('status', '=', from)
          .executeTakeFirst();
        return r.numUpdatedRows === 1n;
      },
      async roles(id) {
        const rows = await db
          .selectFrom('role_grants')
          .select('role')
          .where('account_id', '=', id)
          .execute();
        return rows.map((r) => r.role);
      },
      async grantRole(id, role, grantedBy) {
        await db
          .insertInto('role_grants')
          .values({ account_id: id, role, granted_by: grantedBy })
          .onConflict((oc) => oc.columns(['account_id', 'role']).doNothing())
          .execute();
      },
    },

    otp: {
      async create(c) {
        const row = await db
          .insertInto('otp_challenges')
          .values({
            id: c.id,
            phone_e164: c.phone,
            code_hash: c.codeHash,
            max_attempts: c.maxAttempts,
            // DB clock for both creation and checks: no app/DB skew on expiry.
            expires_at: sql<Date>`now() + make_interval(secs => ${c.ttlSeconds})`,
            ip_hash: c.ipHash,
            device_key_hash: c.deviceKeyHash,
          })
          .returning('expires_at')
          .executeTakeFirstOrThrow();
        return { expiresAt: row.expires_at };
      },
      async registerAttempt(id) {
        const row = await db
          .updateTable('otp_challenges')
          .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
          .where('id', '=', id)
          .where('consumed_at', 'is', null)
          .where('expires_at', '>', sql<Date>`now()`)
          .where((eb) => eb('attempts', '<', eb.ref('max_attempts')))
          .returning(['phone_e164', 'code_hash', 'attempts', 'max_attempts'])
          .executeTakeFirst();
        return row
          ? {
              phone: row.phone_e164 as BdPhoneE164,
              codeHash: row.code_hash,
              attempts: row.attempts,
              maxAttempts: row.max_attempts,
            }
          : null;
      },
      async consume(id) {
        const r = await db
          .updateTable('otp_challenges')
          .set({ consumed_at: sql<Date>`now()` })
          .where('id', '=', id)
          .where('consumed_at', 'is', null)
          .executeTakeFirst();
        return r.numUpdatedRows === 1n;
      },
    },

    devices: {
      async upsert(d) {
        const row = await db
          .insertInto('devices')
          .values({
            id: d.id,
            account_id: d.accountId,
            key_hash: d.keyHash,
            platform: d.platform,
            label: d.label,
          })
          .onConflict((oc) =>
            oc.columns(['account_id', 'key_hash']).doUpdateSet((eb) => ({
              platform: eb.ref('excluded.platform'),
              label: sql<string | null>`coalesce(excluded.label, devices.label)`,
              last_seen_at: sql<Date>`now()`,
              // Re-proving the phone on a previously revoked device re-registers it, untrusted.
              trust: sql<
                Device['trust']
              >`case when devices.trust = 'REVOKED' then 'UNTRUSTED' else devices.trust end`,
              revoked_at: null,
            })),
          )
          .returningAll()
          .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
          .executeTakeFirstOrThrow();
        return { device: toDevice(row), created: row.inserted };
      },
      async listForAccount(accountId) {
        const rows = await db
          .selectFrom('devices')
          .selectAll()
          .where('account_id', '=', accountId)
          .where('revoked_at', 'is', null)
          .orderBy('last_seen_at', 'desc')
          .limit(100)
          .execute();
        return rows.map(toDevice);
      },
      async revoke(accountId, deviceId) {
        const r = await db
          .updateTable('devices')
          .set({ trust: 'REVOKED', revoked_at: sql<Date>`now()` })
          .where('id', '=', deviceId)
          .where('account_id', '=', accountId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        return r.numUpdatedRows === 1n;
      },
      async touch(deviceId) {
        await db
          .updateTable('devices')
          .set({ last_seen_at: sql<Date>`now()` })
          .where('id', '=', deviceId)
          .execute();
      },
    },

    sessions: {
      async create(s) {
        await db
          .insertInto('sessions')
          .values({
            id: s.id,
            account_id: s.accountId,
            device_id: s.deviceId,
            expires_at: s.expiresAt,
            ip_hash: s.ipHash,
            user_agent: s.userAgent,
          })
          .execute();
      },
      async isActive(sessionId, accountId) {
        const row = await db
          .selectFrom('sessions')
          .innerJoin('accounts', 'accounts.id', 'sessions.account_id')
          .select('sessions.id')
          .where('sessions.id', '=', sessionId)
          .where('sessions.account_id', '=', accountId)
          .where('sessions.revoked_at', 'is', null)
          .where('sessions.expires_at', '>', sql<Date>`now()`)
          .where('accounts.status', '=', 'ACTIVE')
          .executeTakeFirst();
        return !!row;
      },
      async listActive(accountId) {
        const rows = await db
          .selectFrom('sessions')
          .select([
            'id',
            'account_id',
            'device_id',
            'created_at',
            'last_refreshed_at',
            'expires_at',
          ])
          .where('account_id', '=', accountId)
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', sql<Date>`now()`)
          .orderBy('created_at', 'desc')
          .limit(100)
          .execute();
        return rows.map((r) => ({
          id: r.id,
          accountId: r.account_id,
          deviceId: r.device_id,
          createdAt: r.created_at,
          lastRefreshedAt: r.last_refreshed_at,
          expiresAt: r.expires_at,
        }));
      },
      async revoke(sessionId, accountId, reason) {
        const r = await db
          .updateTable('sessions')
          .set({ revoked_at: sql<Date>`now()`, revoke_reason: reason })
          .where('id', '=', sessionId)
          .where('account_id', '=', accountId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        return r.numUpdatedRows === 1n;
      },
      async revokeAllForAccount(accountId, reason) {
        const r = await db
          .updateTable('sessions')
          .set({ revoked_at: sql<Date>`now()`, revoke_reason: reason })
          .where('account_id', '=', accountId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        return Number(r.numUpdatedRows);
      },
      async revokeForDevice(accountId, deviceId, reason) {
        const r = await db
          .updateTable('sessions')
          .set({ revoked_at: sql<Date>`now()`, revoke_reason: reason })
          .where('account_id', '=', accountId)
          .where('device_id', '=', deviceId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        return Number(r.numUpdatedRows);
      },
      async markRefreshed(sessionId) {
        await db
          .updateTable('sessions')
          .set({ last_refreshed_at: sql<Date>`now()` })
          .where('id', '=', sessionId)
          .execute();
      },
    },

    refreshTokens: {
      async insert(t) {
        await db
          .insertInto('refresh_tokens')
          .values({
            id: t.id,
            session_id: t.sessionId,
            token_hash: t.hash,
            expires_at: t.expiresAt,
          })
          .execute();
      },
      async findByHashForUpdate(hash) {
        const row = await db
          .selectFrom('refresh_tokens as rt')
          .innerJoin('sessions as s', 's.id', 'rt.session_id')
          .innerJoin('accounts as a', 'a.id', 's.account_id')
          .select([
            'rt.id',
            'rt.session_id',
            'rt.expires_at',
            'rt.used_at',
            's.account_id',
            's.device_id',
            's.expires_at as session_expires_at',
            's.revoked_at as session_revoked_at',
            'a.status as account_status',
          ])
          .where('rt.token_hash', '=', hash)
          .forUpdate(['rt'])
          .executeTakeFirst();
        if (!row) return null;
        return {
          id: row.id,
          sessionId: row.session_id,
          expiresAt: row.expires_at,
          usedAt: row.used_at,
          session: {
            accountId: row.account_id,
            deviceId: row.device_id,
            expiresAt: row.session_expires_at,
            revokedAt: row.session_revoked_at,
          },
          accountStatus: row.account_status,
        };
      },
      async markUsed(id, replacedBy) {
        await db
          .updateTable('refresh_tokens')
          .set({ used_at: sql<Date>`now()`, replaced_by: replacedBy })
          .where('id', '=', id)
          .execute();
      },
    },

    audit: (ctx, entry) => appendAudit(db, ctx, entry),
    outbox: (events) => appendToOutbox(db, events),
  };
}

export function createPgUnitOfWork(db: Kysely<IdentityDB>): UnitOfWork {
  return {
    repos: repositories(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(repositories(trx))),
  };
}

/** Retention purge (see docs/architecture/04-security.md §6). Returns rows deleted. */
export async function purgeExpired(trx: Transaction<IdentityDB>): Promise<number> {
  const otp = await trx
    .deleteFrom('otp_challenges')
    .where('created_at', '<', sql<Date>`now() - interval '24 hours'`)
    .executeTakeFirst();
  const tokens = await trx
    .deleteFrom('refresh_tokens')
    .where('expires_at', '<', sql<Date>`now() - interval '7 days'`)
    .executeTakeFirst();
  const sessions = await trx
    .deleteFrom('sessions')
    .where('expires_at', '<', sql<Date>`now() - interval '90 days'`)
    .executeTakeFirst();
  return Number(otp.numDeletedRows + tokens.numDeletedRows + sessions.numDeletedRows);
}
