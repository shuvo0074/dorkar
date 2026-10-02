import { DeliveryModes, DistrictSchema, SellerRoles, UserTypes } from '@dorkar/contracts';
import { ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { ProfileService, PublicProfile } from '../../application/profile-service';

const iso = z.codec(z.iso.datetime({ offset: true }), z.date(), {
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
const errors = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  422: ErrorResponse,
};

const Reputation = z
  .object({
    ratingAverage: z.number().nullable(),
    ratingCount: z.number().int(),
    completedCount: z.number().int(),
    cancelledCount: z.number().int(),
    disputedCount: z.number().int(),
  })
  .nullable();

const Capabilities = z.object({
  roles: z.array(z.enum(SellerRoles)),
  categoryIds: z.array(z.uuid()),
  serviceDistricts: z.array(DistrictSchema),
  deliveryModes: z.array(z.enum(DeliveryModes)),
  active: z.boolean(),
});

/** What anyone may see. No phone, no avatar internals, no hidden flag. */
const PublicProfileDto = z.object({
  id: z.uuid(),
  displayName: z.string(),
  userType: z.enum(UserTypes),
  bio: z.string().nullable(),
  district: DistrictSchema.nullable(),
  memberSince: iso,
  badges: z.array(z.enum(['PHONE_VERIFIED', 'NID_VERIFIED', 'BUSINESS_VERIFIED'])),
  reputation: Reputation,
  seller: Capabilities.omit({ active: true }).nullable(),
});

/** The owner's view adds private settings. */
const MyProfileDto = PublicProfileDto.extend({
  area: z.string().nullable(),
  locale: z.enum(['en', 'bn']),
  avatarMediaId: z.uuid().nullable(),
  capabilities: Capabilities.nullable(),
});

const toPublic = (p: PublicProfile): z.output<typeof PublicProfileDto> => ({
  id: p.profile.accountId,
  displayName: p.profile.displayName,
  userType: p.profile.userType,
  bio: p.profile.bio,
  district: p.profile.district,
  memberSince: p.profile.createdAt,
  badges: p.badges,
  reputation: p.reputation,
  seller: p.capabilities?.active
    ? {
        roles: p.capabilities.roles,
        categoryIds: p.capabilities.categoryIds,
        serviceDistricts: p.capabilities.serviceDistricts,
        deliveryModes: p.capabilities.deliveryModes,
      }
    : null,
});

const toMine = (p: PublicProfile): z.output<typeof MyProfileDto> => ({
  ...toPublic(p),
  area: p.profile.area,
  locale: p.profile.locale,
  avatarMediaId: p.profile.avatarMediaId,
  capabilities: p.capabilities
    ? {
        roles: p.capabilities.roles,
        categoryIds: p.capabilities.categoryIds,
        serviceDistricts: p.capabilities.serviceDistricts,
        deliveryModes: p.capabilities.deliveryModes,
        active: p.capabilities.active,
      }
    : null,
});

const PatchBody = z
  .strictObject({
    displayName: z.string().trim().min(2).max(60),
    userType: z.enum(UserTypes),
    bio: z.string().trim().max(500).nullable(),
    district: DistrictSchema.nullable(),
    area: z.string().trim().min(1).max(80).nullable(),
    locale: z.enum(['en', 'bn']),
    avatarMediaId: z.uuid().nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });

const CapabilitiesBody = z.strictObject({
  roles: z.array(z.enum(SellerRoles)).max(4),
  categoryIds: z.array(z.uuid()).max(30),
  serviceDistricts: z.array(DistrictSchema).max(64),
  deliveryModes: z.array(z.enum(DeliveryModes)).max(4),
  active: z.boolean(),
});

export interface ProfileRouteDeps {
  profiles: ProfileService;
  runtime: ServiceRuntime<never>;
}

export const profileRoutes: FastifyPluginAsyncZod<ProfileRouteDeps> = async (
  app,
  { profiles, runtime },
) => {
  const { authenticate } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };

  app.get(
    '/api/v1/me/profile',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        ...secured,
        response: { 200: z.object({ data: MyProfileDto }), ...errors },
      },
    },
    async (req) => ok(toMine(await profiles.getMine(req.ctx))),
  );

  app.patch(
    '/api/v1/me/profile',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        ...secured,
        body: PatchBody,
        response: { 200: z.object({ data: MyProfileDto }), ...errors },
      },
    },
    async (req) => ok(toMine(await profiles.updateMine(req.body, req.ctx))),
  );

  app.put(
    '/api/v1/me/seller-capabilities',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'What I can offer: roles, categories, areas, delivery',
        ...secured,
        body: CapabilitiesBody,
        response: { 200: z.object({ data: Capabilities }), ...errors },
      },
    },
    async (req) => {
      const c = await profiles.setCapabilities(req.body, req.ctx);
      return ok({
        roles: c.roles,
        categoryIds: c.categoryIds,
        serviceDistricts: c.serviceDistricts,
        deliveryModes: c.deliveryModes,
        active: c.active,
      });
    },
  );

  app.get(
    '/api/v1/users/:id',
    {
      schema: {
        tags: ['profiles'],
        summary: 'Public profile',
        params: z.strictObject({ id: z.uuid() }),
        response: { 200: z.object({ data: PublicProfileDto }), ...errors },
      },
    },
    async (req, reply) => {
      void reply.header('cache-control', 'public, max-age=60');
      return ok(toPublic(await profiles.getPublic(req.params.id)));
    },
  );

  // Other services resolve display names for lists (offers, matches) in one call.
  app.get(
    '/internal/v1/profiles',
    {
      preHandler: runtime.internalOnly,
      schema: {
        hide: true,
        querystring: z.strictObject({ ids: z.string().max(3700) }),
        response: {
          200: z.object({
            data: z.array(
              z.object({
                accountId: z.uuid(),
                displayName: z.string(),
                userType: z.enum(UserTypes),
                district: DistrictSchema.nullable(),
              }),
            ),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const ids = req.query.ids.split(',').filter((s) => z.uuid().safeParse(s).success);
      return ok(await profiles.cards(ids));
    },
  );
};
