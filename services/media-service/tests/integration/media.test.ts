import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Role } from '@dorkar/contracts';
import { startTestService, TEST_INTERNAL_TOKEN, type TestService } from '@dorkar/kernel/testing';
import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrations } from '../../migrations';
import { buildMediaService } from '../../src/app';
import { originalKey, uploadKey, MB } from '../../src/domain/media';
import { pgMediaStore } from '../../src/infrastructure/pg-media-store';
import { LocalDiskStorage } from '../../src/infrastructure/storage/local-disk-storage';
import { jpegWithGps, pathOf, pdf, png, textAsJpg } from '../fixtures';

const SIGNING_KEY = 'media-test-signing-key-0123456789abcdef';
const BASE = 'http://media.test';
const dir = mkdtempSync(join(tmpdir(), 'dorkar-media-it-'));
/** Same key and root as the service: lets tests forge expired-but-validly-signed URLs. */
const forger = new LocalDiskStorage({ root: dir, signingKey: SIGNING_KEY, publicBaseUrl: BASE });

let t: TestService<Awaited<ReturnType<typeof buildMediaService>>>;
const app = () => t.svc.runtime.app;
const db = () => t.svc.runtime.db;

beforeAll(async () => {
  t = await startTestService({
    schemaPrefix: 'media',
    migrations,
    env: { MEDIA_LOCAL_DIR: dir, MEDIA_SIGNING_KEY: SIGNING_KEY, MEDIA_PUBLIC_BASE_URL: BASE },
    build: (env, logger, verifier) => buildMediaService(env, logger, { verifier }),
  });
});
afterAll(async () => {
  await t.close();
  rmSync(dir, { recursive: true, force: true });
});

type Purpose =
  'LISTING' | 'NEED' | 'OFFER' | 'AVATAR' | 'VERIFICATION' | 'MESSAGE' | 'DISPUTE' | 'LEND_ITEM';
type CT = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

const outboxTypes = async (id: string) =>
  (await db().selectFrom('outbox').selectAll().where('aggregate_id', '=', id).execute()).map(
    (r) => r.type,
  );

const startUpload = async (
  owner: string,
  body: { purpose: Purpose; contentType: CT; sizeBytes: number },
) =>
  app().inject({
    method: 'POST',
    url: '/api/v1/media/uploads',
    headers: await t.auth.as(owner),
    payload: body,
  });

/** Create the target and PUT the bytes the way a client would. */
async function upload(owner: string, purpose: Purpose, contentType: CT, bytes: Buffer) {
  const res = await startUpload(owner, { purpose, contentType, sizeBytes: bytes.length });
  expect(res.statusCode).toBe(201);
  const { mediaId, upload: target } = res.json().data;
  const put = await app().inject({
    method: 'PUT',
    url: pathOf(target.url),
    headers: target.headers,
    payload: bytes,
  });
  expect(put.statusCode).toBe(204);
  return { mediaId: mediaId as string, target };
}

const complete = async (owner: string, id: string) =>
  app().inject({
    method: 'POST',
    url: `/api/v1/media/${id}/complete`,
    headers: await t.auth.as(owner),
  });

const view = async (id: string, as?: { sub: string; roles?: Role[] }) =>
  app().inject({
    url: `/api/v1/media/${id}`,
    ...(as ? { headers: await t.auth.as(as.sub, as.roles) } : {}),
  });

const fetchFile = (url: string) => app().inject({ url: pathOf(url) });

describe('upload targets', () => {
  it('returns a signed 15-minute PUT target', async () => {
    const res = await startUpload(randomUUID(), {
      purpose: 'LISTING',
      contentType: 'image/png',
      sizeBytes: 1234,
    });
    expect(res.statusCode).toBe(201);
    const d = res.json().data;
    expect(d.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/png' } });
    expect(d.upload.url).toMatch(
      new RegExp(`^${BASE}/api/v1/media/uploads/${d.mediaId}/content\\?expires=\\d+&sig=`),
    );
    const ttl = new Date(d.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(14 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
  });

  it('validates type, purpose, size and input shape', async () => {
    const owner = randomUUID();
    const go = (body: Record<string, unknown>) =>
      startUpload(owner, {
        purpose: 'LISTING',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        ...body,
      } as never);

    const gif = await go({ contentType: 'image/gif' });
    expect(gif.statusCode).toBe(400);
    const pdfForListing = await go({ contentType: 'application/pdf' });
    expect(pdfForListing.statusCode).toBe(422);
    expect(pdfForListing.json().error.details.rule).toBe('TYPE_NOT_ALLOWED');
    const huge = await go({ sizeBytes: 10 * MB + 1 });
    expect(huge.statusCode).toBe(422);
    expect(huge.json().error.details.rule).toBe('FILE_TOO_LARGE');
    const bigPdf = await go({
      purpose: 'VERIFICATION',
      contentType: 'application/pdf',
      sizeBytes: 5 * MB + 1,
    });
    expect(bigPdf.json().error.details.rule).toBe('FILE_TOO_LARGE');
    expect((await go({ sizeBytes: 0 })).statusCode).toBe(400);
    expect((await go({ filename: 'x.jpg' })).statusCode).toBe(400);
    expect((await go({ purpose: 'BANNER' })).statusCode).toBe(400);
    const anon = await app().inject({
      method: 'POST',
      url: '/api/v1/media/uploads',
      payload: { purpose: 'LISTING', contentType: 'image/png', sizeBytes: 10 },
    });
    expect(anon.statusCode).toBe(401);
  });

  it('enforces the pending-upload quota, also under concurrency', async () => {
    const owner = randomUUID();
    const body = { purpose: 'NEED', contentType: 'image/png', sizeBytes: 10 } as const;
    const results = await Promise.all(Array.from({ length: 34 }, () => startUpload(owner, body)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(30);
    expect(codes.filter((c) => c === 422)).toHaveLength(4);
    expect(results.find((r) => r.statusCode === 422)!.json().error.details.rule).toBe(
      'UPLOAD_LIMIT',
    );
    // Others are unaffected.
    expect((await startUpload(randomUUID(), body)).statusCode).toBe(201);
  });
});

describe('local signed PUT', () => {
  it('rejects bad and expired signatures', async () => {
    const owner = randomUUID();
    const bytes = await png();
    const res = await startUpload(owner, {
      purpose: 'LISTING',
      contentType: 'image/png',
      sizeBytes: bytes.length,
    });
    const { mediaId, upload: target } = res.json().data;
    const url = new URL(target.url);
    const put = (u: URL, headers = target.headers) =>
      app().inject({ method: 'PUT', url: `${u.pathname}${u.search}`, headers, payload: bytes });

    const tampered = new URL(url);
    tampered.searchParams.set('sig', `${url.searchParams.get('sig')!.slice(0, -2)}xx`);
    expect((await put(tampered)).statusCode).toBe(403);

    const extended = new URL(url);
    extended.searchParams.set('expires', String(Number(url.searchParams.get('expires')) + 3600));
    expect((await put(extended)).statusCode).toBe(403);

    const otherId = new URL(url.toString().replace(mediaId, randomUUID()));
    expect((await put(otherId)).statusCode).toBe(403);

    const expired = await forger.createUploadTarget(uploadKey(mediaId), 'image/png', 1, -5);
    expect((await put(new URL(expired.url))).statusCode).toBe(403);

    expect((await put(url, { 'content-type': 'image/jpeg' })).statusCode).toBe(403);
    expect((await put(url)).statusCode).toBe(204);
  });

  it('accepts exactly the declared size', async () => {
    const res = await startUpload(randomUUID(), {
      purpose: 'LISTING',
      contentType: 'image/png',
      sizeBytes: 100,
    });
    const { mediaId, upload: target } = res.json().data;
    const put = (payload: Buffer) =>
      app().inject({ method: 'PUT', url: pathOf(target.url), headers: target.headers, payload });
    expect((await put(Buffer.alloc(101))).statusCode).toBe(413);
    expect((await put(Buffer.alloc(99))).statusCode).toBe(400);
    expect(await t.svc.storage.get(uploadKey(mediaId))).toBeNull();
    // Larger than the 256 KB JSON body limit is fine for uploads.
    const big = await startUpload(randomUUID(), {
      purpose: 'LISTING',
      contentType: 'image/png',
      sizeBytes: 600 * 1024,
    });
    const bigTarget = big.json().data.upload;
    const ok = await app().inject({
      method: 'PUT',
      url: pathOf(bigTarget.url),
      headers: bigTarget.headers,
      payload: Buffer.alloc(600 * 1024),
    });
    expect(ok.statusCode).toBe(204);
  });
});

describe('completion', () => {
  it('processes a JPEG: READY, stripped EXIF/GPS, WebP variants, MediaReady', async () => {
    const owner = randomUUID();
    const input = await jpegWithGps();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const { mediaId } = await upload(owner, 'LISTING', 'image/jpeg', input);

    const res = await complete(owner, mediaId);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d).toMatchObject({
      id: mediaId,
      purpose: 'LISTING',
      status: 'READY',
      contentType: 'image/jpeg',
      width: 2000,
      height: 1500,
      rejectionReason: null,
    });

    // The stored original is the re-encoded file, without metadata; the raw upload is gone.
    const row = await db()
      .selectFrom('media_objects')
      .selectAll()
      .where('id', '=', mediaId)
      .executeTakeFirstOrThrow();
    expect(row.storage_key).toBe(originalKey(mediaId));
    expect(row.size_bytes).toBe(input.length);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.visibility).toBe('PUBLIC');
    const stored = (await t.svc.storage.get(row.storage_key))!;
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    expect(stored.includes(Buffer.from('secret owner'))).toBe(false);
    expect(await t.svc.storage.get(uploadKey(mediaId))).toBeNull();

    const thumb = await fetchFile(d.urls.thumb);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(thumb.headers['x-content-type-options']).toBe('nosniff');
    expect(thumb.headers['content-disposition']).toBe('inline');
    expect(await sharp(thumb.rawPayload).metadata()).toMatchObject({
      format: 'webp',
      width: 320,
    });
    const medium = await fetchFile(d.urls.medium);
    expect((await sharp(medium.rawPayload).metadata()).width).toBe(1280);
    const original = await fetchFile(d.urls.original);
    expect(original.headers['content-type']).toBe('image/jpeg');
    expect((await sharp(original.rawPayload).metadata()).exif).toBeUndefined();

    expect(await outboxTypes(mediaId)).toEqual(['media.MediaReady']);
  });

  it('is idempotent once READY', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(owner, 'AVATAR', 'image/png', await png());
    const first = await complete(owner, mediaId);
    const second = await complete(owner, mediaId);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.status).toBe('READY');
    expect(second.json().data.createdAt).toBe(first.json().data.createdAt);
    expect(await outboxTypes(mediaId)).toEqual(['media.MediaReady']);
  });

  it('rejects a text file renamed .jpg: REJECTED, MediaRejected, bytes deleted', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(owner, 'NEED', 'image/jpeg', textAsJpg());
    const res = await complete(owner, mediaId);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'TYPE_MISMATCH',
      urls: {},
    });
    expect(await outboxTypes(mediaId)).toEqual(['media.MediaRejected']);
    const event = await db()
      .selectFrom('outbox')
      .select('payload')
      .where('aggregate_id', '=', mediaId)
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({ mediaId, ownerId: owner, reason: 'TYPE_MISMATCH' });
    expect(await t.svc.storage.get(uploadKey(mediaId))).toBeNull();
    // Rejected is final.
    expect((await complete(owner, mediaId)).statusCode).toBe(409);
    // Hidden from others.
    expect((await view(mediaId, { sub: randomUUID() })).statusCode).toBe(404);
  });

  it('rejects a real image whose type differs from the declared one', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(owner, 'OFFER', 'image/jpeg', await png());
    expect((await complete(owner, mediaId)).json().data.rejectionReason).toBe('TYPE_MISMATCH');
  });

  it('accepts PDFs only for verification, with a magic-byte check', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(owner, 'VERIFICATION', 'application/pdf', pdf());
    const res = await complete(owner, mediaId);
    expect(res.json().data).toMatchObject({
      status: 'READY',
      contentType: 'application/pdf',
      width: null,
    });
    const urls = res.json().data.urls;
    expect(Object.keys(urls)).toEqual(['original']);
    const file = await fetchFile(urls.original);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe('attachment');
    expect(file.headers['x-content-type-options']).toBe('nosniff');

    // A PDF declared as an image for a listing is caught by sniffing.
    const sneaky = await upload(owner, 'LISTING', 'image/png', pdf());
    expect((await complete(owner, sneaky.mediaId)).json().data.rejectionReason).toBe(
      'TYPE_MISMATCH',
    );
  });

  it('requires the bytes, the owner and a live upload window', async () => {
    const owner = randomUUID();
    const res = await startUpload(owner, {
      purpose: 'LISTING',
      contentType: 'image/png',
      sizeBytes: 10,
    });
    const id = res.json().data.mediaId;
    const early = await complete(owner, id);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.details.rule).toBe('UPLOAD_NOT_RECEIVED');
    expect((await complete(randomUUID(), id)).statusCode).toBe(404);
    expect((await complete(owner, randomUUID())).statusCode).toBe(404);

    await db()
      .updateTable('media_objects')
      .set({ expires_at: sql<Date>`now() - interval '1 minute'` })
      .where('id', '=', id)
      .execute();
    const late = await complete(owner, id);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.details.rule).toBe('UPLOAD_EXPIRED');
  });
});

describe('visibility', () => {
  it('serves public READY media to anyone, unfinished media only to the owner', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(owner, 'LISTING', 'image/png', await png());
    expect((await view(mediaId)).statusCode).toBe(404);
    expect((await view(mediaId, { sub: owner })).json().data.status).toBe('PENDING_UPLOAD');
    await complete(owner, mediaId);
    const anon = await view(mediaId);
    expect(anon.statusCode).toBe(200);
    expect(anon.json().data.urls.thumb).toMatch(/^http:\/\/media\.test\/api\/v1\/media\/files\//);
    expect(anon.headers['cache-control']).toBe('private, no-store');
  });

  it('keeps verification media private: owner and verification:nid:read only', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(
      owner,
      'VERIFICATION',
      'image/jpeg',
      await jpegWithGps(800, 600),
    );
    expect((await complete(owner, mediaId)).json().data.status).toBe('READY');

    expect((await view(mediaId)).statusCode).toBe(404);
    expect((await view(mediaId, { sub: randomUUID() })).statusCode).toBe(404);
    expect((await view(mediaId, { sub: randomUUID(), roles: ['ADMIN'] })).statusCode).toBe(404);
    expect((await view(mediaId, { sub: owner })).statusCode).toBe(200);
    const reviewer = await view(mediaId, { sub: randomUUID(), roles: ['SUPER_ADMIN'] });
    expect(reviewer.statusCode).toBe(200);
    expect((await fetchFile(reviewer.json().data.urls.original)).statusCode).toBe(200);

    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'metadata', 'actor_id'])
      .where('target_id', '=', mediaId)
      .orderBy('occurred_at')
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['media.upload_created', 'media.completed']);
    expect(audit.every((a) => a.actor_id === owner)).toBe(true);
    expect(JSON.stringify(audit)).not.toMatch(/sha|key|uploads\/|media\//);
  });

  it('does not audit non-verification media', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(owner, 'LISTING', 'image/png', await png());
    await complete(owner, mediaId);
    const n = await db()
      .selectFrom('audit_log')
      .select('id')
      .where('target_id', '=', mediaId)
      .execute();
    expect(n).toHaveLength(0);
  });
});

describe('signed reads', () => {
  let thumbUrl: URL;
  let mediaId: string;

  beforeAll(async () => {
    const owner = randomUUID();
    ({ mediaId } = await upload(owner, 'LISTING', 'image/png', await png()));
    thumbUrl = new URL((await complete(owner, mediaId)).json().data.urls.thumb);
  });

  it('refuses tampered, re-targeted and expired signatures', async () => {
    const get = (u: URL) => app().inject({ url: `${u.pathname}${u.search}` });
    expect((await get(thumbUrl)).statusCode).toBe(200);

    const tampered = new URL(thumbUrl);
    tampered.searchParams.set('sig', `A${thumbUrl.searchParams.get('sig')!.slice(1)}`);
    expect((await get(tampered)).statusCode).toBe(403);

    const otherFile = new URL(thumbUrl.toString().replace('thumb.webp', 'medium.webp'));
    expect((await get(otherFile)).statusCode).toBe(403);

    const noSig = new URL(thumbUrl);
    noSig.searchParams.delete('sig');
    expect((await get(noSig)).statusCode).toBe(400);

    const expired = new URL(await forger.signedReadUrl(`media/${mediaId}/thumb.webp`, -5));
    expect((await get(expired)).statusCode).toBe(403);
  });

  it('rejects path traversal and never serves raw uploads', async () => {
    const q = thumbUrl.search;
    for (const p of [
      `/api/v1/media/files/../../../../etc/passwd${q}`,
      `/api/v1/media/files/%2e%2e%2f%2e%2e%2fetc%2fpasswd${q}`,
      `/api/v1/media/files/media/${mediaId}/..%2f..%2f..%2fpackage.json${q}`,
      `/api/v1/media/files/media%2f${mediaId}%2f..%2f..%2fuploads%2f${mediaId}${q}`,
      `/api/v1/media/files/media/${mediaId}/original.meta.json${q}`,
    ]) {
      const res = await app().inject({ url: p });
      expect([400, 403, 404], p).toContain(res.statusCode);
    }
    // Even with a valid signature, the raw upload area is not servable.
    const raw = new URL(await forger.signedReadUrl(uploadKey(mediaId), 60));
    expect((await app().inject({ url: `${raw.pathname}${raw.search}` })).statusCode).toBe(404);
  });
});

describe('deletion', () => {
  it('lets only the owner delete; objects are removed and the media disappears', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(owner, 'VERIFICATION', 'image/png', await png());
    const urls = (await complete(owner, mediaId)).json().data.urls;

    const stranger = await app().inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}`,
      headers: await t.auth.as(randomUUID(), ['SUPER_ADMIN']),
    });
    expect(stranger.statusCode).toBe(404);

    const res = await app().inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}`,
      headers: await t.auth.as(owner),
    });
    expect(res.statusCode).toBe(204);
    expect((await view(mediaId, { sub: owner })).statusCode).toBe(404);
    expect((await fetchFile(urls.original)).statusCode).toBe(404);
    expect((await fetchFile(urls.thumb)).statusCode).toBe(404);
    expect(await t.svc.storage.get(originalKey(mediaId))).toBeNull();

    const again = await app().inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}`,
      headers: await t.auth.as(owner),
    });
    expect(again.statusCode).toBe(404);

    const actions = await db()
      .selectFrom('audit_log')
      .select('action')
      .where('target_id', '=', mediaId)
      .execute();
    expect(actions.map((a) => a.action)).toContain('media.deleted');
  });
});

describe('pending expiry job', () => {
  it('abandons expired uploads, deletes their bytes, and leaves live ones alone', async () => {
    const owner = randomUUID();
    const stale = await upload(owner, 'NEED', 'image/png', await png());
    const live = await upload(owner, 'NEED', 'image/png', await png());
    await db()
      .updateTable('media_objects')
      .set({ expires_at: sql<Date>`now() - interval '1 second'` })
      .where('id', '=', stale.mediaId)
      .execute();

    // The direct upload URL stops working once the window closes.
    const putLate = await app().inject({
      method: 'PUT',
      url: pathOf(stale.target.url),
      headers: stale.target.headers,
      payload: await png(),
    });
    expect(putLate.statusCode).toBe(404);

    const n = await db()
      .transaction()
      .execute((trx) => t.svc.media.expirePending(pgMediaStore(trx)));
    expect(n).toBeGreaterThanOrEqual(1);

    const rows = await db()
      .selectFrom('media_objects')
      .select(['id', 'status'])
      .where('id', 'in', [stale.mediaId, live.mediaId])
      .execute();
    const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(status[stale.mediaId]).toBe('DELETED');
    expect(status[live.mediaId]).toBe('PENDING_UPLOAD');
    expect(await t.svc.storage.get(uploadKey(stale.mediaId))).toBeNull();
    expect(await t.svc.storage.get(uploadKey(live.mediaId))).not.toBeNull();
  });
});

describe('phase 2 purposes', () => {
  it('serves lend-item media publicly', async () => {
    const owner = randomUUID();
    const { mediaId } = await upload(owner, 'LEND_ITEM', 'image/png', await png());
    expect((await complete(owner, mediaId)).json().data.status).toBe('READY');
    expect((await view(mediaId)).statusCode).toBe(200);
  });

  it('keeps message and dispute media private and image-only', async () => {
    for (const purpose of ['MESSAGE', 'DISPUTE'] as const) {
      const owner = randomUUID();
      const pdfRes = await startUpload(owner, {
        purpose,
        contentType: 'application/pdf',
        sizeBytes: 100,
      });
      expect(pdfRes.statusCode).toBe(422);
      expect(pdfRes.json().error.details.rule).toBe('TYPE_NOT_ALLOWED');
      const big = await startUpload(owner, {
        purpose,
        contentType: 'image/png',
        sizeBytes: 10 * MB + 1,
      });
      expect(big.json().error.details.rule).toBe('FILE_TOO_LARGE');

      const { mediaId } = await upload(owner, purpose, 'image/png', await png());
      expect((await complete(owner, mediaId)).json().data.status).toBe('READY');
      const row = await db()
        .selectFrom('media_objects')
        .select('visibility')
        .where('id', '=', mediaId)
        .executeTakeFirstOrThrow();
      expect(row.visibility).toBe('PRIVATE');
      expect((await view(mediaId)).statusCode).toBe(404);
      expect((await view(mediaId, { sub: randomUUID() })).statusCode).toBe(404);
      expect((await view(mediaId, { sub: owner })).statusCode).toBe(200);
    }
  });

  it('lets the purpose staff permission read private media', async () => {
    const owner = randomUUID();
    const evidence = await upload(owner, 'DISPUTE', 'image/png', await png());
    await complete(owner, evidence.mediaId);
    const message = await upload(owner, 'MESSAGE', 'image/png', await png());
    await complete(owner, message.mediaId);

    const support = { sub: randomUUID(), roles: ['SUPPORT'] as Role[] };
    const moderator = { sub: randomUUID(), roles: ['MODERATOR'] as Role[] };
    const viaSupport = await view(evidence.mediaId, support);
    expect(viaSupport.statusCode).toBe(200);
    expect((await fetchFile(viaSupport.json().data.urls.original)).statusCode).toBe(200);
    expect((await view(evidence.mediaId, moderator)).statusCode).toBe(404);
    expect((await view(message.mediaId, moderator)).statusCode).toBe(200);
    expect((await view(message.mediaId, support)).statusCode).toBe(404);
  });
});

describe('internal grants', () => {
  const grant = (body: Record<string, unknown>, token: string | null = TEST_INTERNAL_TOKEN) =>
    app().inject({
      method: 'POST',
      url: '/internal/v1/media/grants',
      headers: token ? { 'x-internal-token': token } : {},
      payload: body,
    });

  async function ready(owner: string, purpose: Purpose) {
    const { mediaId } = await upload(owner, purpose, 'image/png', await png());
    expect((await complete(owner, mediaId)).json().data.status).toBe('READY');
    return mediaId;
  }

  it('requires the internal token and validates the body', async () => {
    const owner = randomUUID();
    const mediaId = await ready(owner, 'MESSAGE');
    const body = {
      ownerId: owner,
      mediaIds: [mediaId],
      accountIds: [randomUUID()],
      purpose: 'MESSAGE',
    };
    expect((await grant(body, null)).statusCode).toBe(403);
    expect((await grant(body, 'wrong-token-wrong-token-wrong-token-wrong')).statusCode).toBe(403);
    const user = await app().inject({
      method: 'POST',
      url: '/internal/v1/media/grants',
      headers: await t.auth.as(owner, ['SUPER_ADMIN']),
      payload: body,
    });
    expect(user.statusCode).toBe(403);

    const many = Array.from({ length: 11 }, () => randomUUID());
    expect((await grant({ ...body, mediaIds: many })).statusCode).toBe(400);
    expect((await grant({ ...body, accountIds: many })).statusCode).toBe(400);
    expect((await grant({ ...body, accountIds: [] })).statusCode).toBe(400);
    expect((await grant({ ...body, purpose: 'VERIFICATION' })).statusCode).toBe(400);
    expect((await grant({ ...body, extra: 1 })).statusCode).toBe(400);
  });

  it('gives grantees read access to READY media; others still get 404', async () => {
    const owner = randomUUID();
    const peer = randomUUID();
    const stranger = randomUUID();
    const mediaId = await ready(owner, 'MESSAGE');
    expect((await view(mediaId, { sub: peer })).statusCode).toBe(404);

    const res = await grant({
      ownerId: owner,
      mediaIds: [mediaId],
      accountIds: [peer],
      purpose: 'MESSAGE',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.created).toBe(1);

    const viaGrant = await view(mediaId, { sub: peer });
    expect(viaGrant.statusCode).toBe(200);
    expect((await fetchFile(viaGrant.json().data.urls.thumb)).statusCode).toBe(200);
    expect((await view(mediaId, { sub: stranger })).statusCode).toBe(404);
    expect((await view(mediaId)).statusCode).toBe(404);

    const row = await db()
      .selectFrom('media_grants')
      .selectAll()
      .where('media_id', '=', mediaId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ account_id: peer, granted_by_service: 'messaging-service' });

    // Deleting the media revokes everything.
    await app().inject({
      method: 'DELETE',
      url: `/api/v1/media/${mediaId}`,
      headers: await t.auth.as(owner),
    });
    expect((await view(mediaId, { sub: peer })).statusCode).toBe(404);
  });

  it('is idempotent and audits only new grants', async () => {
    const owner = randomUUID();
    const a = await ready(owner, 'DISPUTE');
    const b = await ready(owner, 'DISPUTE');
    const peers = [randomUUID(), randomUUID()];
    const body = { ownerId: owner, mediaIds: [a, b], accountIds: peers, purpose: 'DISPUTE' };
    expect((await grant(body)).json().data.created).toBe(4);
    expect((await grant(body)).json().data.created).toBe(0);
    // Adding a participant later grants only what is new; the owner is skipped.
    const late = randomUUID();
    const more = await grant({ ...body, accountIds: [...peers, late, owner] });
    expect(more.json().data.created).toBe(2);

    const grants = await db()
      .selectFrom('media_grants')
      .select(['account_id', 'granted_by_service'])
      .where('media_id', 'in', [a, b])
      .execute();
    expect(grants).toHaveLength(6);
    expect(grants.every((g) => g.granted_by_service === 'dispute-service')).toBe(true);

    const audit = await db()
      .selectFrom('audit_log')
      .select(['action', 'actor_type', 'metadata'])
      .where('target_id', '=', a)
      .where('action', '=', 'media.access_granted')
      .orderBy('occurred_at')
      .execute();
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ actor_type: 'SYSTEM' });
    expect(audit[1]!.metadata).toMatchObject({ purpose: 'DISPUTE', accountIds: [late] });
    expect((await view(a, { sub: late })).statusCode).toBe(200);
  });

  it('refuses media that is missing, not owned, of another purpose or deleted, writing nothing', async () => {
    const owner = randomUUID();
    const good = await ready(owner, 'MESSAGE');
    const other = await ready(randomUUID(), 'MESSAGE');
    const evidence = await ready(owner, 'DISPUTE');
    const gone = await ready(owner, 'MESSAGE');
    await app().inject({
      method: 'DELETE',
      url: `/api/v1/media/${gone}`,
      headers: await t.auth.as(owner),
    });
    const missing = randomUUID();
    const peer = randomUUID();

    const res = await grant({
      ownerId: owner,
      mediaIds: [good, other, evidence, gone, missing],
      accountIds: [peer],
      purpose: 'MESSAGE',
    });
    expect(res.statusCode).toBe(422);
    const details = res.json().error.details;
    expect(details.rule).toBe('MEDIA_NOT_GRANTABLE');
    expect(details.problems).toEqual(
      expect.arrayContaining([
        { mediaId: other, problem: 'NOT_OWNED' },
        { mediaId: evidence, problem: 'WRONG_PURPOSE' },
        { mediaId: gone, problem: 'DELETED' },
        { mediaId: missing, problem: 'NOT_FOUND' },
      ]),
    );
    expect(details.problems).toHaveLength(4);
    const written = await db()
      .selectFrom('media_grants')
      .select('media_id')
      .where('account_id', '=', peer)
      .execute();
    expect(written).toHaveLength(0);
    expect((await view(good, { sub: peer })).statusCode).toBe(404);
  });
});
