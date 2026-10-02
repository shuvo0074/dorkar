import type { ServiceRuntime } from '@dorkar/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export const iso = z.codec(z.iso.datetime({ offset: true }), z.date(), {
  decode: (s) => new Date(s),
  encode: (d) => d.toISOString(),
});

const ErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    requestId: z.string(),
  }),
});
export const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
  503: ErrorResponse,
};

export const secured = { security: [{ bearerAuth: [] }] };

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: z.object({ nextCursor: z.string().nullable() }) });

/** Public routes that show more to a signed-in owner: authenticate only if a token is sent. */
export const optionalAuth =
  (runtime: ServiceRuntime<never>) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization) await runtime.auth.authenticate(req, reply);
  };
