import { ok, requireInternal, type FastifyPluginAsyncZod } from '@dorkar/kernel';
import { z } from 'zod';
import type { GetContact } from '../../application/use-cases/contact';

/** Service-to-service endpoints. Never routed by the gateway; require the internal token. */
export const identityInternalRoutes: FastifyPluginAsyncZod<{
  token: string;
  getContact: GetContact;
}> = async (app, { token, getContact }) => {
  app.get(
    '/internal/v1/accounts/:id/contact',
    {
      preHandler: requireInternal(token),
      schema: {
        hide: true,
        params: z.strictObject({ id: z.uuid() }),
        querystring: z.strictObject({ purpose: z.enum(['NOTIFICATION']) }),
        response: {
          200: z.object({ data: z.object({ accountId: z.uuid(), phoneE164: z.string() }) }),
        },
      },
    },
    async (req) => ok(await getContact.execute(req.params.id, req.query.purpose, req.ctx)),
  );
};
