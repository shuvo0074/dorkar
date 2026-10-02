import type { Readable } from 'node:stream';
import { AppError, Errors, type FastifyPluginAsyncZod } from '@dorkar/kernel';
import { z } from 'zod';
import type { MediaService } from '../../application/media-service';
import { isServableKey } from '../../domain/media';
import { errors } from './schemas';

/** What the routes need from the local-disk adapter (it plays the role of S3 here). */
export interface SignedLocalStore {
  verifyUpload(mediaId: string, expires: string, sig: string): boolean;
  verifyRead(key: string, expires: string, sig: string): boolean;
  writeStream(key: string, body: Readable, sizeBytes: number, contentType: string): Promise<void>;
  open(key: string): Promise<{ body: Readable; contentType: string; size: number } | null>;
}

export interface LocalStorageRouteDeps {
  media: MediaService;
  store: SignedLocalStore;
}

const Signed = z.strictObject({ expires: z.string().max(20), sig: z.string().max(128) });
const badSignature = () => Errors.forbidden('Invalid or expired signature.');
const mediaType = (header: string | undefined) => header?.split(';')[0]?.trim().toLowerCase();

/**
 * Endpoints that stand in for the object store when MEDIA_STORAGE=local: the signed direct
 * upload (PUT, streamed, not subject to the JSON body limit) and signed reads.
 * Authorization is the URL signature, exactly like an S3 pre-signed URL.
 */
export const localStorageRoutes: FastifyPluginAsyncZod<LocalStorageRouteDeps> = async (
  app,
  { media, store },
) => {
  // Encapsulated: only this plugin's routes take raw bodies of any type, as a stream.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

  app.put(
    '/api/v1/media/uploads/:id/content',
    {
      schema: {
        tags: ['media'],
        summary: 'Signed direct upload (development storage)',
        params: z.strictObject({ id: z.uuid() }),
        querystring: Signed,
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!store.verifyUpload(id, req.query.expires, req.query.sig)) throw badSignature();
      const m = await media.pendingUpload(id);
      if (!m) throw Errors.notFound('Upload');
      // The content type is part of the signed contract, as with S3.
      if (mediaType(req.headers['content-type']) !== m.declaredContentType) throw badSignature();
      const length = req.headers['content-length'];
      if (length !== undefined && Number(length) !== m.declaredSize) {
        throw Number(length) > m.declaredSize
          ? new AppError('PAYLOAD_TOO_LARGE', 'The upload is larger than declared.')
          : Errors.validation('The upload size does not match the declared size.');
      }
      await store.writeStream(m.storageKey, req.raw, m.declaredSize, m.declaredContentType);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/api/v1/media/files/*',
    {
      schema: {
        tags: ['media'],
        summary: 'Signed read (development storage)',
        params: z.strictObject({ '*': z.string().max(256) }),
        querystring: Signed,
        response: errors,
      },
    },
    async (req, reply) => {
      const key = req.params['*'];
      // Allowlist of server-generated keys: no traversal, never the raw upload.
      if (!isServableKey(key)) throw Errors.notFound('File');
      if (!store.verifyRead(key, req.query.expires, req.query.sig)) throw badSignature();
      const file = await store.open(key);
      if (!file) throw Errors.notFound('File');
      const isImage = file.contentType.startsWith('image/');
      return (
        reply
          .headers({
            'content-type': file.contentType,
            'content-length': String(file.size),
            'x-content-type-options': 'nosniff',
            'content-disposition': isImage ? 'inline' : 'attachment',
            'content-security-policy': "default-src 'none'; sandbox",
            'cache-control': 'private, max-age=600',
          })
          // Streams bypass the serializer; the response schema only documents errors.
          .send(file.body as never)
      );
    },
  );
};
