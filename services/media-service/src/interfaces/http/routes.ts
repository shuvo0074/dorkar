import { MediaPurposes } from '@dorkar/contracts';
import { ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { MediaService, MediaView } from '../../application/media-service';
import { MediaStatuses, UploadContentTypes } from '../../domain/media';
import { errors, iso } from './schemas';

const MediaDto = z.object({
  id: z.uuid(),
  purpose: z.enum(MediaPurposes),
  status: z.enum(MediaStatuses),
  /** Type established from the bytes (null until processed). */
  contentType: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  rejectionReason: z.string().nullable(),
  createdAt: iso,
  /** Short-lived signed URLs; present only when READY. */
  urls: z.object({
    original: z.url().optional(),
    thumb: z.url().optional(),
    medium: z.url().optional(),
  }),
  urlsExpireAt: iso.nullable(),
});

const toDto = ({ media: m, urls, urlsExpireAt }: MediaView): z.output<typeof MediaDto> => ({
  id: m.id,
  purpose: m.purpose,
  status: m.status,
  contentType: m.sniffedMime,
  width: m.width,
  height: m.height,
  rejectionReason: m.rejectionReason,
  createdAt: m.createdAt,
  urls,
  urlsExpireAt,
});

const UploadBody = z.strictObject({
  purpose: z.enum(MediaPurposes),
  /** Declared type; verified against the bytes on completion. */
  contentType: z.enum(UploadContentTypes),
  sizeBytes: z.number().int().positive().max(2_147_483_647),
});

const UploadCreated = z.object({
  mediaId: z.uuid(),
  upload: z.object({
    method: z.literal('PUT'),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
  }),
  expiresAt: iso,
});

const IdParams = z.strictObject({ id: z.uuid() });

export interface MediaRouteDeps {
  media: MediaService;
  runtime: ServiceRuntime<never>;
}

export const mediaRoutes: FastifyPluginAsyncZod<MediaRouteDeps> = async (
  app,
  { media, runtime },
) => {
  const { authenticate } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };
  /** Anonymous callers may read public media; a token, if sent, must be valid. */
  const optionalAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization) await authenticate(req, reply);
  };

  app.post(
    '/api/v1/media/uploads',
    {
      preHandler: authenticate,
      schema: {
        tags: ['media'],
        summary: 'Start an upload: returns a pre-signed, exact-size, exact-type upload target',
        ...secured,
        body: UploadBody,
        response: { 201: z.object({ data: UploadCreated }), ...errors },
      },
    },
    async (req, reply) => {
      const { media: m, upload } = await media.createUpload(req.body, req.ctx);
      void reply.status(201);
      return ok({
        mediaId: m.id,
        upload: { method: upload.method, url: upload.url, headers: upload.headers },
        expiresAt: upload.expiresAt,
      });
    },
  );

  app.post(
    '/api/v1/media/:id/complete',
    {
      preHandler: authenticate,
      schema: {
        tags: ['media'],
        summary: 'Verify and process the uploaded bytes (idempotent)',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: MediaDto }), ...errors },
      },
    },
    async (req) => {
      await media.complete(req.params.id, req.ctx);
      return ok(toDto(await media.view(req.params.id, req.ctx)));
    },
  );

  app.get(
    '/api/v1/media/:id',
    {
      preHandler: optionalAuth,
      schema: {
        tags: ['media'],
        summary: 'Media metadata with short-lived signed URLs',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: MediaDto }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.header('cache-control', 'private, no-store');
      return ok(toDto(await media.view(req.params.id, req.ctx)));
    },
  );

  app.delete(
    '/api/v1/media/:id',
    {
      preHandler: authenticate,
      schema: {
        tags: ['media'],
        ...secured,
        params: IdParams,
        response: { 204: z.null(), ...errors },
      },
    },
    async (req, reply) => {
      await media.delete(req.params.id, req.ctx);
      return reply.status(204).send(null);
    },
  );
};
