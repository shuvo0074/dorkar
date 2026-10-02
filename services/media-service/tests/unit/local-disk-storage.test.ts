import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { uploadKey } from '../../src/domain/media';
import {
  InvalidKeyError,
  LocalDiskStorage,
} from '../../src/infrastructure/storage/local-disk-storage';

const root = mkdtempSync(join(tmpdir(), 'dorkar-media-unit-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const storage = new LocalDiskStorage({
  root,
  signingKey: 'k'.repeat(40),
  publicBaseUrl: 'http://media.test/',
});
const ID = '0192f0c4-0000-7000-8000-00000000abcd';

const query = (url: string) =>
  Object.fromEntries(new URL(url).searchParams) as Record<string, string>;

describe('LocalDiskStorage', () => {
  it('refuses keys that could escape the root', () => {
    for (const bad of [
      '../etc/passwd',
      'media/../../etc/passwd',
      '/etc/passwd',
      'media/./x',
      'media//x',
      '.hidden',
      'media/x/.env',
      'media\\..\\x',
      'media/x.meta.json',
      'MEDIA/X',
      '',
    ]) {
      expect(() => storage.pathOf(bad), bad).toThrow(InvalidKeyError);
    }
    expect(storage.pathOf(`media/${ID}/thumb.webp`)).toBe(join(root, 'media', ID, 'thumb.webp'));
  });

  it('signs upload URLs for the media id and verifies them in constant time', async () => {
    const t = await storage.createUploadTarget(uploadKey(ID), 'image/png', 10, 60);
    expect(t.method).toBe('PUT');
    expect(t.url).toMatch(`http://media.test/api/v1/media/uploads/${ID}/content?`);
    expect(t.headers).toEqual({ 'content-type': 'image/png' });
    const { expires, sig } = query(t.url);
    expect(storage.verifyUpload(ID, expires!, sig!)).toBe(true);
    expect(storage.verifyUpload(ID, expires!, `${sig!.slice(0, -1)}A`)).toBe(false);
    expect(storage.verifyUpload(ID, String(Number(expires) + 1), sig!)).toBe(false);
    expect(storage.verifyUpload(ID.replace('a', 'b'), expires!, sig!)).toBe(false);
    expect(storage.verifyUpload(ID, 'soon', sig!)).toBe(false);
    // a read signature is not an upload signature
    const read = query(await storage.signedReadUrl(`media/${ID}/original`, 60));
    expect(storage.verifyUpload(ID, read.expires!, read.sig!)).toBe(false);
  });

  it('rejects expired signatures', async () => {
    const t = await storage.createUploadTarget(uploadKey(ID), 'image/png', 10, -1);
    const { expires, sig } = query(t.url);
    expect(storage.verifyUpload(ID, expires!, sig!)).toBe(false);
    const r = query(await storage.signedReadUrl(`media/${ID}/original`, -1));
    expect(storage.verifyRead(`media/${ID}/original`, r.expires!, r.sig!)).toBe(false);
  });

  it('streams exactly the declared size to disk', async () => {
    const key = uploadKey('0192f0c4-0000-7000-8000-000000000001');
    await storage.writeStream(
      key,
      Readable.from([Buffer.alloc(6), Buffer.alloc(4)]),
      10,
      'image/png',
    );
    expect((await storage.get(key))?.length).toBe(10);
    expect((await storage.open(key))?.contentType).toBe('image/png');

    const big = uploadKey('0192f0c4-0000-7000-8000-000000000002');
    await expect(
      storage.writeStream(big, Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10, 'image/png'),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(await storage.get(big)).toBeNull();

    const small = uploadKey('0192f0c4-0000-7000-8000-000000000003');
    await expect(
      storage.writeStream(small, Readable.from([Buffer.alloc(3)]), 10, 'image/png'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await storage.get(small)).toBeNull();
  });

  it('puts, reads and deletes objects idempotently', async () => {
    const key = `media/${ID}/original`;
    await storage.put(key, Buffer.from('abc'), 'application/pdf');
    expect((await storage.get(key))?.toString()).toBe('abc');
    await storage.delete(key);
    await storage.delete(key);
    expect(await storage.get(key)).toBeNull();
    expect(await storage.open(key)).toBeNull();
  });
});
