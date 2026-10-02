import { appendAudit, appendToOutbox, paginate, uuidv7 } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type {
  PolicyInput,
  VerificationStore,
  VerificationUnitOfWork,
  VerificationWrite,
} from '../application/ports';
import { UniqueViolation } from '../application/verification-service';
import type { Policy } from '../domain/policy';
import type { Verification } from '../domain/verification';
import type { VerificationDB } from './db-schema';

type Executor = Kysely<VerificationDB> | Transaction<VerificationDB>;

/** Millisecond precision, so keyset cursors (ISO strings) compare exactly. */
const nowMs = sql<Date>`date_trunc('milliseconds', now())`;

/** Never selects nid_fingerprint: it stays inside the store. */
const VERIFICATION_COLUMNS = [
  'id',
  'account_id',
  'kind',
  'status',
  'provider',
  'provider_ref',
  'nid_last4',
  'reviewed_by',
  'review_note',
  'submitted_at',
  'verified_at',
  'created_at',
  'updated_at',
  'version',
] as const;

type VerificationRow = Pick<
  Selectable<VerificationDB['verifications']>,
  (typeof VERIFICATION_COLUMNS)[number]
>;

const toVerification = (r: VerificationRow): Verification => ({
  id: r.id,
  accountId: r.account_id,
  kind: r.kind,
  status: r.status,
  provider: r.provider,
  providerRef: r.provider_ref,
  nidLast4: r.nid_last4,
  reviewedBy: r.reviewed_by,
  reviewNote: r.review_note,
  submittedAt: r.submitted_at,
  verifiedAt: r.verified_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
});

const toPolicy = (r: Selectable<VerificationDB['policies']>): Policy => ({
  id: r.id,
  name: r.name,
  action: r.action,
  scope: r.scope,
  selector: r.selector,
  requirement: r.requirement,
  kinds: r.kinds,
  active: r.active,
  priority: r.priority,
  version: r.version,
  updatedBy: r.updated_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const policyRow = (p: PolicyInput) => ({
  name: p.name,
  action: p.action,
  scope: p.scope,
  selector: JSON.stringify(p.selector),
  requirement: p.requirement,
  kinds: p.kinds,
  active: p.active,
  priority: p.priority,
});

/** Postgres unique_violation → UniqueViolation(constraint), so use cases can map it to a rule. */
async function uniqueSafe<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505') throw new UniqueViolation(e.constraint ?? 'unknown');
    throw err;
  }
}

const writeColumns = (w: VerificationWrite) => ({
  status: w.status,
  provider: w.provider,
  provider_ref: w.providerRef,
  ...(w.nidLast4 !== undefined ? { nid_last4: w.nidLast4 } : {}),
  ...(w.nidFingerprint !== undefined ? { nid_fingerprint: w.nidFingerprint } : {}),
  ...(w.reviewedBy !== undefined ? { reviewed_by: w.reviewedBy } : {}),
  ...(w.reviewNote !== undefined ? { review_note: w.reviewNote } : {}),
  verified_at: w.verified ? sql<Date>`now()` : null,
  ...(w.submitted ? { submitted_at: nowMs } : {}),
});

export function pgVerificationStore(db: Executor): VerificationStore {
  return {
    async mine(accountId) {
      const rows = await db
        .selectFrom('verifications')
        .select(VERIFICATION_COLUMNS)
        .where('account_id', '=', accountId)
        .orderBy('kind')
        .execute();
      return rows.map(toVerification);
    },
    async byId(id) {
      const r = await db
        .selectFrom('verifications')
        .select(VERIFICATION_COLUMNS)
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      return r ? toVerification(r) : null;
    },
    async current(accountId, kind, lock = false) {
      let q = db
        .selectFrom('verifications')
        .select(VERIFICATION_COLUMNS)
        .where('account_id', '=', accountId)
        .where('kind', '=', kind);
      if (lock) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toVerification(r) : null;
    },
    async nidVerifiedElsewhere(fingerprint, accountId) {
      const r = await db
        .selectFrom('verifications')
        .select('id')
        .where('kind', '=', 'NID')
        .where('status', '=', 'VERIFIED')
        .where('nid_fingerprint', '=', fingerprint)
        .where('account_id', '<>', accountId)
        .executeTakeFirst();
      return !!r;
    },
    async fingerprintOf(id) {
      const r = await db
        .selectFrom('verifications')
        .select('nid_fingerprint')
        .where('id', '=', id)
        .executeTakeFirst();
      return r?.nid_fingerprint ?? null;
    },
    insert(id, accountId, kind, w) {
      return uniqueSafe(async () =>
        toVerification(
          await db
            .insertInto('verifications')
            .values({ id, account_id: accountId, kind, ...writeColumns(w) })
            .returning(VERIFICATION_COLUMNS)
            .executeTakeFirstOrThrow(),
        ),
      );
    },
    transition(v, w) {
      return uniqueSafe(async () => {
        const r = await db
          .updateTable('verifications')
          .set((eb) => ({
            ...writeColumns(w),
            updated_at: sql<Date>`now()`,
            version: eb('version', '+', 1),
          }))
          .where('id', '=', v.id)
          .where('status', '=', v.status)
          .where('version', '=', v.version)
          .returning(VERIFICATION_COLUMNS)
          .executeTakeFirst();
        return r ? toVerification(r) : null;
      });
    },
    async history(verificationId, from, to, actorId, reason) {
      await db
        .insertInto('verification_history')
        .values({
          id: uuidv7(),
          verification_id: verificationId,
          from_status: from,
          to_status: to,
          actor_id: actorId,
          reason,
        })
        .execute();
    },
    async list(filter, after, limit) {
      let q = db
        .selectFrom('verifications')
        .select(VERIFICATION_COLUMNS)
        .where('status', '=', filter.status);
      if (filter.kind) q = q.where('kind', '=', filter.kind);
      if (after) {
        q = q.where((eb) =>
          eb(eb.refTuple('submitted_at', 'id'), '>', eb.tuple(new Date(after.k), after.id)),
        );
      }
      const rows = await q
        .orderBy('submitted_at', 'asc')
        .orderBy('id', 'asc')
        .limit(limit + 1)
        .execute();
      const page = paginate(rows, limit, (r) => ({ k: r.submitted_at.toISOString(), id: r.id }));
      return { items: page.items.map(toVerification), nextCursor: page.nextCursor };
    },
    async verifiedKinds(accountId) {
      const rows = await db
        .selectFrom('verifications')
        .select('kind')
        .where('account_id', '=', accountId)
        .where('status', '=', 'VERIFIED')
        .execute();
      return rows.map((r) => r.kind);
    },

    async policies(after, limit) {
      let q = db.selectFrom('policies').selectAll();
      if (after) q = q.where('id', '>', after.id);
      const rows = await q
        .orderBy('id', 'asc')
        .limit(limit + 1)
        .execute();
      const page = paginate(rows, limit, (r) => ({ k: r.id, id: r.id }));
      return { items: page.items.map(toPolicy), nextCursor: page.nextCursor };
    },
    async activePoliciesFor(action) {
      const rows = await db
        .selectFrom('policies')
        .selectAll()
        .where('active', '=', true)
        .where('action', 'in', [action, 'ANY'])
        .execute();
      return rows.map(toPolicy);
    },
    async policy(id, lock = false) {
      let q = db.selectFrom('policies').selectAll().where('id', '=', id);
      if (lock) q = q.forUpdate();
      const r = await q.executeTakeFirst();
      return r ? toPolicy(r) : null;
    },
    async insertPolicy(id, p, actorId) {
      return toPolicy(
        await db
          .insertInto('policies')
          .values({ id, ...policyRow(p), updated_by: actorId })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    },
    async updatePolicy(id, version, p, actorId) {
      const r = await db
        .updateTable('policies')
        .set((eb) => ({
          ...policyRow(p),
          updated_by: actorId,
          updated_at: sql<Date>`now()`,
          version: eb('version', '+', 1),
        }))
        .where('id', '=', id)
        .where('version', '=', version)
        .returningAll()
        .executeTakeFirst();
      return r ? toPolicy(r) : null;
    },

    async purgeRejectedFingerprints(days) {
      const r = await db
        .updateTable('verifications')
        .set({ nid_fingerprint: null })
        .where('kind', '=', 'NID')
        .where('status', '=', 'REJECTED')
        .where('nid_fingerprint', 'is not', null)
        .where('updated_at', '<', sql<Date>`now() - make_interval(days => ${days})`)
        .executeTakeFirst();
      return Number(r.numUpdatedRows);
    },

    outbox: (events) => appendToOutbox(db, events),
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgVerificationUnitOfWork(db: Kysely<VerificationDB>): VerificationUnitOfWork {
  return {
    store: pgVerificationStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgVerificationStore(trx))),
  };
}
