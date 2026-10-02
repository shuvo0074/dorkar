import { appendAudit, appendToOutbox } from '@dorkar/kernel';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { MediaStore, MediaUnitOfWork } from '../application/ports';
import type { Media, UploadContentType } from '../domain/media';
import type { MediaDB } from './db-schema';

type Executor = Kysely<MediaDB> | Transaction<MediaDB>;
type Row = Selectable<MediaDB['media_objects']> & { expired: boolean };

const toMedia = (r: Row): Media => ({
  id: r.id,
  ownerId: r.owner_id,
  purpose: r.purpose,
  visibility: r.visibility,
  status: r.status,
  declaredContentType: r.declared_content_type,
  declaredSize: r.declared_size,
  sniffedMime: r.sniffed_mime as UploadContentType | null,
  sizeBytes: r.size_bytes,
  sha256: r.sha256,
  storageKey: r.storage_key,
  variants: r.variants,
  width: r.width,
  height: r.height,
  rejectionReason: r.rejection_reason,
  createdAt: r.created_at,
  readyAt: r.ready_at,
  expiresAt: r.expires_at,
  expired: r.expired,
  version: r.version,
});

/** Deadlines are compared with the database clock. */
const expired = sql<boolean>`(status = 'PENDING_UPLOAD' and expires_at <= now())`.as('expired');

export function pgMediaStore(db: Executor): MediaStore {
  return {
    async get(id) {
      const r = await db
        .selectFrom('media_objects')
        .selectAll()
        .select(expired)
        .where('id', '=', id)
        .executeTakeFirst();
      return r ? toMedia(r) : null;
    },
    async lockForGrant(ids) {
      if (ids.length === 0) return [];
      const rows = await db
        .selectFrom('media_objects')
        .selectAll()
        .select(expired)
        .where('id', 'in', [...ids])
        .orderBy('id')
        .forShare()
        .execute();
      return rows.map(toMedia);
    },
    async hasGrant(mediaId, accountId) {
      const r = await db
        .selectFrom('media_grants')
        .select('media_id')
        .where('media_id', '=', mediaId)
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return !!r;
    },
    async insertGrants(grants) {
      if (grants.length === 0) return [];
      const rows = await db
        .insertInto('media_grants')
        .values(
          grants.map((g) => ({
            media_id: g.mediaId,
            account_id: g.accountId,
            granted_by_service: g.grantedByService,
          })),
        )
        .onConflict((oc) => oc.columns(['media_id', 'account_id']).doNothing())
        .returning(['media_id', 'account_id', 'granted_by_service'])
        .execute();
      return rows.map((r) => ({
        mediaId: r.media_id,
        accountId: r.account_id,
        grantedByService: r.granted_by_service,
      }));
    },
    async lockOwner(ownerId) {
      await sql`select pg_advisory_xact_lock(hashtext(${`media:owner:${ownerId}`}))`.execute(db);
    },
    async countPending(ownerId) {
      const r = await db
        .selectFrom('media_objects')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('owner_id', '=', ownerId)
        .where('status', '=', 'PENDING_UPLOAD')
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirstOrThrow();
      return Number(r.n);
    },
    async insert(m) {
      const r = await db
        .insertInto('media_objects')
        .values({
          id: m.id,
          owner_id: m.ownerId,
          purpose: m.purpose,
          visibility: m.visibility,
          declared_content_type: m.declaredContentType,
          declared_size: m.declaredSize,
          storage_key: m.storageKey,
          expires_at: m.expiresAt,
        })
        .returningAll()
        .returning(sql<boolean>`false`.as('expired'))
        .executeTakeFirstOrThrow();
      return toMedia(r);
    },
    async markReady(id, version, p) {
      const r = await db
        .updateTable('media_objects')
        .set({
          status: 'READY',
          sniffed_mime: p.sniffedMime,
          size_bytes: p.sizeBytes,
          sha256: p.sha256,
          storage_key: p.storageKey,
          variants: JSON.stringify(p.variants),
          width: p.width,
          height: p.height,
          ready_at: sql<Date>`now()`,
          expires_at: null,
          version: version + 1,
        })
        .where('id', '=', id)
        .where('status', '=', 'PENDING_UPLOAD')
        .where('version', '=', version)
        .returningAll()
        .returning(sql<boolean>`false`.as('expired'))
        .executeTakeFirst();
      return r ? toMedia(r) : null;
    },
    async markRejected(id, version, reason, f) {
      const r = await db
        .updateTable('media_objects')
        .set({
          status: 'REJECTED',
          rejection_reason: reason,
          sniffed_mime: f.sniffedMime,
          size_bytes: f.sizeBytes,
          sha256: f.sha256,
          expires_at: null,
          version: version + 1,
        })
        .where('id', '=', id)
        .where('status', '=', 'PENDING_UPLOAD')
        .where('version', '=', version)
        .returningAll()
        .returning(sql<boolean>`false`.as('expired'))
        .executeTakeFirst();
      return r ? toMedia(r) : null;
    },
    async markDeleted(id, version, from) {
      const r = await db
        .updateTable('media_objects')
        .set({ status: 'DELETED', expires_at: null, version: version + 1 })
        .where('id', '=', id)
        .where('status', '=', from)
        .where('version', '=', version)
        .returningAll()
        .returning(sql<boolean>`false`.as('expired'))
        .executeTakeFirst();
      return r ? toMedia(r) : null;
    },
    async claimExpiredPending(limit) {
      const rows = await db
        .selectFrom('media_objects')
        .selectAll()
        .select(sql<boolean>`true`.as('expired'))
        .where('status', '=', 'PENDING_UPLOAD')
        .where('expires_at', '<=', sql<Date>`now()`)
        .orderBy('expires_at')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      return rows.map(toMedia);
    },
    outbox: (events) => appendToOutbox(db, events),
    audit: (ctx, entry) => appendAudit(db, ctx, entry),
  };
}

export function pgMediaUnitOfWork(db: Kysely<MediaDB>): MediaUnitOfWork {
  return {
    store: pgMediaStore(db),
    transaction: (fn) => db.transaction().execute((trx) => fn(pgMediaStore(trx))),
  };
}
