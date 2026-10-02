import {
  decodeCursor,
  Errors,
  ok,
  requestFingerprint,
  withIdempotency,
  type Cursor,
  type IdempotencyTables,
  type ServiceRuntime,
} from '@dorkar/kernel';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
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

export const Money = z.object({ amount: z.number().int(), currency: z.literal('BDT') });

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: z.object({ nextCursor: z.string().nullable() }) });

export const IdParams = z.strictObject({ id: z.uuid() });

/** Keyset cursors over (created_at, id). */
export function timeCursor(raw: string | undefined): Cursor | null {
  const c = decodeCursor(raw);
  if (
    c &&
    (typeof c.k !== 'string' || Number.isNaN(Date.parse(c.k)) || !z.uuid().safeParse(c.id).success)
  ) {
    throw Errors.validation('Invalid cursor.');
  }
  return c;
}

/** Public routes that show more to a signed-in owner: authenticate only if a token is sent. */
export const optionalAuth =
  (runtime: ServiceRuntime<never>) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization) await runtime.auth.authenticate(req, reply);
  };

/**
 * Every command POST is idempotent: a retry with the same Idempotency-Key and body replays the
 * stored response (stored in wire form, so a replay is byte-identical).
 */
export async function idempotentReply<S extends z.ZodType>(
  db: Kysely<IdempotencyTables>,
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { scope: string; status: 200 | 201; schema: S },
  run: () => Promise<z.output<S>>,
) {
  const r = await withIdempotency(
    db,
    {
      actorId: req.ctx.actor!.id,
      scope: opts.scope,
      key: req.headers['idempotency-key'] as string | undefined,
      fingerprint: requestFingerprint({ params: req.params, body: req.body ?? null }),
      required: true,
    },
    async () => ({ status: opts.status, body: z.encode(opts.schema, await run()) }),
  );
  return reply
    .status(r.status)
    .header('idempotent-replayed', String(r.replayed))
    .send(ok(z.decode(opts.schema, r.body)));
}
