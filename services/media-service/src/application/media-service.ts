import { MediaEvents } from '@dorkar/contracts';
import {
  AppError,
  Errors,
  sha256,
  uuidv7,
  type Logger,
  type RequestContext,
  type ServiceRuntime,
} from '@dorkar/kernel';
import {
  allKeys,
  assertPendingQuota,
  assertTransition,
  assertUploadAllowed,
  canRead,
  checkSniffedType,
  GRANTING_SERVICE,
  grantProblem,
  needsGrant,
  isImage,
  originalKey,
  READ_URL_TTL_SECONDS,
  UPLOAD_TTL_SECONDS,
  uploadKey,
  variantKey,
  visibilityFor,
  type GrantablePurpose,
  type GrantProblem,
  type Media,
  type MediaPurpose,
  type RejectionReason,
  type UploadContentType,
  type Variants,
} from '../domain/media';
import {
  ImageDecodeError,
  type ContentSniffer,
  type ImageProcessor,
  type MalwareScanner,
  type MediaStore,
  type MediaUnitOfWork,
  type ObjectStorage,
  type ReadyPatch,
  type UploadTarget,
} from './ports';

export interface MediaView {
  media: Media;
  urls: { original?: string; thumb?: string; medium?: string };
  urlsExpireAt: Date | null;
}

type Outcome =
  | { ok: true; patch: ReadyPatch; written: string[] }
  | {
      ok: false;
      reason: RejectionReason;
      facts: { sniffedMime: string | null; sizeBytes: number; sha256: string | null };
    };

const requireActor = (ctx: RequestContext) => {
  if (!ctx.actor) throw Errors.unauthenticated();
  return ctx.actor;
};

/** Verification documents are sensitive: every lifecycle step on them is audited. */
const audited = (purpose: MediaPurpose) => purpose === 'VERIFICATION';

export interface GrantInput {
  ownerId: string;
  mediaIds: string[];
  accountIds: string[];
  purpose: GrantablePurpose;
}

export interface MediaDeps {
  uow: MediaUnitOfWork;
  event: ServiceRuntime<never>['event'];
  storage: ObjectStorage;
  sniffer: ContentSniffer;
  images: ImageProcessor;
  scanner: MalwareScanner;
  logger: Logger;
}

/** Media use cases. Bytes go to object storage; Postgres holds metadata only. */
export class MediaService {
  constructor(private readonly d: MediaDeps) {}

  async createUpload(
    input: { purpose: MediaPurpose; contentType: UploadContentType; sizeBytes: number },
    ctx: RequestContext,
  ): Promise<{ media: Media; upload: UploadTarget }> {
    const actor = requireActor(ctx);
    assertUploadAllowed(input.purpose, input.contentType, input.sizeBytes);
    const id = uuidv7();
    const key = uploadKey(id);
    const expiresAt = new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000);

    const media = await this.d.uow.transaction(async (s) => {
      await s.lockOwner(actor.id);
      assertPendingQuota(await s.countPending(actor.id));
      const m = await s.insert({
        id,
        ownerId: actor.id,
        purpose: input.purpose,
        visibility: visibilityFor(input.purpose),
        declaredContentType: input.contentType,
        declaredSize: input.sizeBytes,
        storageKey: key,
        expiresAt,
      });
      if (audited(m.purpose)) {
        await s.audit(ctx, {
          action: 'media.upload_created',
          targetType: 'media',
          targetId: m.id,
          metadata: { purpose: m.purpose, contentType: m.declaredContentType },
        });
      }
      return m;
    });
    const upload = await this.d.storage.createUploadTarget(
      key,
      input.contentType,
      input.sizeBytes,
      UPLOAD_TTL_SECONDS,
    );
    return { media, upload: { ...upload, expiresAt } };
  }

  /** The pending upload behind a direct-upload URL, or null if it no longer accepts bytes. */
  async pendingUpload(id: string): Promise<Media | null> {
    const m = await this.d.uow.store.get(id);
    return m && m.status === 'PENDING_UPLOAD' && !m.expired ? m : null;
  }

  /**
   * Validates and processes the uploaded bytes synchronously. Idempotent: completing a READY
   * object returns it unchanged.
   */
  async complete(id: string, ctx: RequestContext): Promise<Media> {
    const actor = requireActor(ctx);
    const m = await this.d.uow.store.get(id);
    if (!m || m.ownerId !== actor.id || m.status === 'DELETED') throw Errors.notFound('Media');
    if (m.status === 'READY') return m;
    assertTransition(m.status, 'READY');
    if (m.expired) {
      throw uploadConflict('The upload window has closed. Start a new upload.', 'UPLOAD_EXPIRED');
    }
    const bytes = await this.d.storage.get(m.storageKey);
    if (!bytes) {
      throw uploadConflict('No file has been uploaded yet.', 'UPLOAD_NOT_RECEIVED');
    }

    const outcome = await this.process(m, bytes);

    if (outcome.ok) {
      const ready = await this.d.uow.transaction(async (s) => {
        const r = await s.markReady(m.id, m.version, outcome.patch);
        if (!r) return null;
        await s.outbox(
          this.d.event(
            MediaEvents.MediaReady,
            r.id,
            { mediaId: r.id, ownerId: r.ownerId, purpose: r.purpose },
            ctx,
          ),
        );
        if (audited(r.purpose)) {
          await s.audit(ctx, {
            action: 'media.completed',
            targetType: 'media',
            targetId: r.id,
            metadata: { purpose: r.purpose, status: 'READY', mime: r.sniffedMime },
          });
        }
        return r;
      });
      if (ready) {
        await this.bestEffortDelete([uploadKey(m.id)]);
        return ready;
      }
      return this.afterLostRace(m.id, outcome.written);
    }

    const rejected = await this.d.uow.transaction(async (s) => {
      const r = await s.markRejected(m.id, m.version, outcome.reason, outcome.facts);
      if (!r) return null;
      await s.outbox(
        this.d.event(
          MediaEvents.MediaRejected,
          r.id,
          { mediaId: r.id, ownerId: r.ownerId, purpose: r.purpose, reason: outcome.reason },
          ctx,
        ),
      );
      if (audited(r.purpose)) {
        await s.audit(ctx, {
          action: 'media.completed',
          targetType: 'media',
          targetId: r.id,
          metadata: { purpose: r.purpose, status: 'REJECTED', reason: outcome.reason },
        });
      }
      return r;
    });
    if (rejected) {
      await this.bestEffortDelete(allKeys(rejected));
      return rejected;
    }
    return this.afterLostRace(m.id, []);
  }

  async view(id: string, ctx: RequestContext): Promise<MediaView> {
    const m = await this.d.uow.store.get(id);
    if (!m) throw Errors.notFound('Media');
    const granted = needsGrant(m, ctx.actor)
      ? await this.d.uow.store.hasGrant(m.id, ctx.actor.id)
      : false;
    if (!canRead(m, ctx.actor, granted)) throw Errors.notFound('Media');
    if (m.status !== 'READY') return { media: m, urls: {}, urlsExpireAt: null };

    const sign = (key: string) => this.d.storage.signedReadUrl(key, READ_URL_TTL_SECONDS);
    const urls: MediaView['urls'] = { original: await sign(m.storageKey) };
    if (m.variants.thumb) urls.thumb = await sign(m.variants.thumb.key);
    if (m.variants.medium) urls.medium = await sign(m.variants.medium.key);
    return { media: m, urls, urlsExpireAt: new Date(Date.now() + READ_URL_TTL_SECONDS * 1000) };
  }

  async delete(id: string, ctx: RequestContext): Promise<void> {
    const actor = requireActor(ctx);
    const m = await this.d.uow.store.get(id);
    if (!m || m.ownerId !== actor.id || m.status === 'DELETED') throw Errors.notFound('Media');
    const deleted = await this.d.uow.transaction(async (s) => {
      const r = await s.markDeleted(m.id, m.version, m.status);
      if (!r) return null;
      if (audited(r.purpose)) {
        await s.audit(ctx, {
          action: 'media.deleted',
          targetType: 'media',
          targetId: r.id,
          metadata: { purpose: r.purpose, previousStatus: m.status },
        });
      }
      return r;
    });
    if (!deleted) {
      throw Errors.conflict('The media changed while deleting it. Try again.');
    }
    await this.bestEffortDelete(allKeys(deleted));
  }

  /**
   * Internal: let other participants (of a conversation or dispute case) read an owner's private
   * media. All-or-nothing; replays add nothing and are not re-audited.
   */
  async grant(input: GrantInput, ctx: RequestContext): Promise<{ created: number }> {
    const mediaIds = [...new Set(input.mediaIds)];
    const accountIds = [...new Set(input.accountIds)].filter((a) => a !== input.ownerId);
    const service = GRANTING_SERVICE[input.purpose];
    return this.d.uow.transaction(async (s) => {
      const found = new Map((await s.lockForGrant(mediaIds)).map((m) => [m.id, m]));
      const problems: Array<{ mediaId: string; problem: GrantProblem }> = [];
      for (const id of mediaIds) {
        const problem = grantProblem(found.get(id) ?? null, input.ownerId, input.purpose);
        if (problem) problems.push({ mediaId: id, problem });
      }
      if (problems.length > 0) {
        throw new AppError('BUSINESS_RULE_VIOLATION', 'Some media cannot be shared.', {
          rule: 'MEDIA_NOT_GRANTABLE',
          problems,
        });
      }
      const created = await s.insertGrants(
        mediaIds.flatMap((mediaId) =>
          accountIds.map((accountId) => ({ mediaId, accountId, grantedByService: service })),
        ),
      );
      const byMedia = new Map<string, string[]>();
      for (const g of created)
        byMedia.set(g.mediaId, [...(byMedia.get(g.mediaId) ?? []), g.accountId]);
      for (const [mediaId, accounts] of byMedia) {
        await s.audit(ctx, {
          action: 'media.access_granted',
          actorType: 'SYSTEM',
          targetType: 'media',
          targetId: mediaId,
          metadata: { purpose: input.purpose, grantedBy: service, accountIds: accounts },
        });
      }
      return { created: created.length };
    });
  }

  /** Job: abandon uploads never completed in time and remove whatever bytes they left. */
  async expirePending(s: MediaStore, limit = 200): Promise<number> {
    const rows = await s.claimExpiredPending(limit);
    for (const m of rows) {
      // Bytes first: if the transaction later fails, the next run simply retries (delete is idempotent).
      await Promise.all(allKeys(m).map((k) => this.d.storage.delete(k)));
      await s.markDeleted(m.id, m.version, 'PENDING_UPLOAD');
    }
    return rows.length;
  }

  // ---- internals

  private async process(m: Media, bytes: Buffer): Promise<Outcome> {
    const digest = sha256(bytes).toString('hex');
    const sniffed = await this.d.sniffer.sniff(bytes);
    const facts = { sniffedMime: sniffed, sizeBytes: bytes.length, sha256: digest };
    if (bytes.length !== m.declaredSize) return { ok: false, reason: 'SIZE_MISMATCH', facts };
    const mismatch = checkSniffedType(m.purpose, m.declaredContentType, sniffed);
    if (mismatch) return { ok: false, reason: mismatch, facts };
    const mime = sniffed as UploadContentType;

    const scan = await this.d.scanner.scan(bytes, mime);
    if (!scan.clean) {
      this.d.logger.warn({ mediaId: m.id, signature: scan.signature }, 'malware detected');
      return { ok: false, reason: 'MALWARE_DETECTED', facts };
    }

    const key = originalKey(m.id);
    if (!isImage(mime)) {
      await this.d.storage.put(key, bytes, mime);
      return {
        ok: true,
        written: [key],
        patch: {
          sniffedMime: mime,
          sizeBytes: bytes.length,
          sha256: digest,
          storageKey: key,
          variants: {},
          width: null,
          height: null,
        },
      };
    }

    let img;
    try {
      img = await this.d.images.process(bytes, mime);
    } catch (err) {
      if (err instanceof ImageDecodeError) {
        this.d.logger.info({ mediaId: m.id, err: err.message }, 'image rejected');
        return { ok: false, reason: 'UNREADABLE_IMAGE', facts };
      }
      throw err;
    }
    const variants: Variants = {};
    const written = [key];
    await this.d.storage.put(key, img.original.body, mime);
    for (const v of img.variants) {
      const vk = variantKey(m.id, v.name);
      await this.d.storage.put(vk, v.body, 'image/webp');
      written.push(vk);
      variants[v.name] = { key: vk, width: v.width, height: v.height };
    }
    return {
      ok: true,
      written,
      patch: {
        sniffedMime: mime,
        // Size and digest describe what the client uploaded, for dedupe and forensics.
        sizeBytes: bytes.length,
        sha256: digest,
        storageKey: key,
        variants,
        width: img.original.width,
        height: img.original.height,
      },
    };
  }

  /** A concurrent request changed the row first; keep its result and clean up after ourselves. */
  private async afterLostRace(id: string, written: string[]): Promise<Media> {
    const current = await this.d.uow.store.get(id);
    if (current?.status === 'READY') return current;
    await this.bestEffortDelete(written);
    if (!current || current.status === 'DELETED') throw Errors.notFound('Media');
    return current;
  }

  private async bestEffortDelete(keys: string[]): Promise<void> {
    await Promise.all(
      keys.map((k) =>
        this.d.storage.delete(k).catch((err: unknown) => {
          this.d.logger.warn({ err, key: k }, 'object delete failed; left for cleanup');
        }),
      ),
    );
  }
}

function uploadConflict(message: string, rule: string) {
  return Errors.conflict(message, { rule });
}
