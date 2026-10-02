import {
  NeedModes,
  PageQuerySchema,
  VerificationKinds,
  VerificationStatuses,
} from '@dorkar/contracts';
import { decodeCursor, ok, type FastifyPluginAsyncZod, type ServiceRuntime } from '@dorkar/kernel';
import { z } from 'zod';
import type { PolicyService } from '../../application/policy-service';
import type { VerificationService } from '../../application/verification-service';
import {
  EvaluatedActions,
  PolicyActions,
  PolicyScopes,
  Requirements,
  type Policy,
} from '../../domain/policy';
import type { Verification } from '../../domain/verification';

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
  409: ErrorResponse,
  422: ErrorResponse,
  429: ErrorResponse,
};

const Kind = z.enum(VerificationKinds);
const Status = z.enum(VerificationStatuses);

/** What the owner sees: no provider internals, no fingerprint, never the NID. */
const MyVerificationDto = z.object({
  kind: Kind,
  status: Status,
  verifiedAt: iso.nullable(),
  nidLast4: z.string().nullable(),
});

/** Review queue item. No fingerprint, no raw data (it never reaches this service's storage). */
const AdminVerificationDto = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  kind: Kind,
  status: Status,
  provider: z.string(),
  providerRef: z.string().nullable(),
  nidLast4: z.string().nullable(),
  reviewedBy: z.uuid().nullable(),
  reviewNote: z.string().nullable(),
  submittedAt: iso,
  verifiedAt: iso.nullable(),
  updatedAt: iso,
  version: z.number().int(),
});

const PolicyDto = z.object({
  id: z.uuid(),
  name: z.string(),
  action: z.enum(PolicyActions),
  scope: z.enum(PolicyScopes),
  selector: z.record(z.string(), z.unknown()),
  requirement: z.enum(Requirements),
  kinds: z.array(Kind),
  active: z.boolean(),
  priority: z.number().int(),
  version: z.number().int(),
  updatedBy: z.uuid().nullable(),
  createdAt: iso,
  updatedAt: iso,
});

const toMine = (v: Verification): z.output<typeof MyVerificationDto> => ({
  kind: v.kind,
  status: v.status,
  verifiedAt: v.verifiedAt,
  nidLast4: v.nidLast4,
});

const toAdmin = (v: Verification): z.output<typeof AdminVerificationDto> => ({
  id: v.id,
  accountId: v.accountId,
  kind: v.kind,
  status: v.status,
  provider: v.provider,
  providerRef: v.providerRef,
  nidLast4: v.nidLast4,
  reviewedBy: v.reviewedBy,
  reviewNote: v.reviewNote,
  submittedAt: v.submittedAt,
  verifiedAt: v.verifiedAt,
  updatedAt: v.updatedAt,
  version: v.version,
});

const toPolicyDto = (p: Policy): z.output<typeof PolicyDto> => ({
  id: p.id,
  name: p.name,
  action: p.action,
  scope: p.scope,
  selector: p.selector,
  requirement: p.requirement,
  kinds: p.kinds,
  active: p.active,
  priority: p.priority,
  version: p.version,
  updatedBy: p.updatedBy,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

// Format rules (digits, age, name) live in the domain so error details never echo the value.
const NidBody = z.strictObject({
  nidNumber: z.string().max(40),
  dateOfBirth: z.string().max(20),
  fullName: z.string().max(200),
});

const DecisionBody = z.strictObject({
  decision: z.enum(['VERIFIED', 'REJECTED']),
  note: z.string().trim().min(1).max(500),
});

const PolicyFields = {
  name: z.string().trim().min(2).max(120),
  action: z.enum(PolicyActions),
  scope: z.enum(PolicyScopes),
  selector: z.record(z.string(), z.unknown()),
  requirement: z.enum(Requirements),
  kinds: z.array(Kind).max(VerificationKinds.length * 2),
  active: z.boolean(),
  priority: z.number().int().min(-1000).max(1000),
};

const CreatePolicyBody = z.strictObject({
  ...PolicyFields,
  active: PolicyFields.active.optional(),
  priority: PolicyFields.priority.optional(),
});

const PatchPolicyBody = z
  .strictObject({ ...PolicyFields, version: z.number().int().min(0) })
  .partial()
  .refine((b) => Object.keys(b).some((k) => k !== 'version'), { message: 'Nothing to update' });

const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), page: z.object({ nextCursor: z.string().nullable() }) });

const IdParams = z.strictObject({ id: z.uuid() });

const csv = z
  .string()
  .max(400)
  .transform((s) =>
    s
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^[A-Z][A-Z_]{1,39}$/)).max(10));

export interface VerificationRouteDeps {
  verifications: VerificationService;
  policies: PolicyService;
  runtime: ServiceRuntime<never>;
}

export const verificationRoutes: FastifyPluginAsyncZod<VerificationRouteDeps> = async (
  app,
  { verifications, policies, runtime },
) => {
  const { authenticate, requirePermission } = runtime.auth;
  const secured = { security: [{ bearerAuth: [] }] };

  // ---------------------------------------------------------------- me

  app.get(
    '/api/v1/me/verifications',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'My verification badges',
        ...secured,
        response: { 200: z.object({ data: z.array(MyVerificationDto) }), ...errors },
      },
    },
    async (req) => ok((await verifications.mine(req.ctx)).map(toMine)),
  );

  app.post(
    '/api/v1/me/verifications/nid',
    {
      preHandler: authenticate,
      schema: {
        tags: ['me'],
        summary: 'Submit my NID for verification',
        description:
          'The number, name and date of birth go to the verification provider; Dorkar keeps only the last 4 digits.',
        ...secured,
        body: NidBody,
        response: {
          202: z.object({ data: z.object({ kind: z.literal('NID'), status: Status }) }),
          ...errors,
        },
      },
    },
    async (req, reply) => {
      const result = await verifications.submitNid(req.body, req.ctx);
      return reply.status(202).send(ok(result));
    },
  );

  // ---------------------------------------------------------------- admin: review

  app.get(
    '/api/v1/admin/verifications',
    {
      preHandler: requirePermission('verification:nid:decide'),
      schema: {
        tags: ['admin'],
        summary: 'Verification review queue (oldest first)',
        ...secured,
        querystring: PageQuerySchema.extend({
          status: Status.default('PENDING'),
          kind: Kind.optional(),
        }).strict(),
        response: { 200: page(AdminVerificationDto), ...errors },
      },
    },
    async (req) => {
      const { status, kind, cursor, limit } = req.query;
      const r = await verifications.listForReview({ status, kind }, decodeCursor(cursor), limit);
      return { data: r.items.map(toAdmin), page: { nextCursor: r.nextCursor } };
    },
  );

  app.post(
    '/api/v1/admin/verifications/:id/decision',
    {
      preHandler: requirePermission('verification:nid:decide'),
      schema: {
        tags: ['admin'],
        summary: 'Approve or reject a pending verification',
        ...secured,
        params: IdParams,
        body: DecisionBody,
        response: { 200: z.object({ data: AdminVerificationDto }), ...errors },
      },
    },
    async (req) =>
      ok(
        toAdmin(
          await verifications.decide(req.params.id, req.body.decision, req.body.note, req.ctx),
        ),
      ),
  );

  // ---------------------------------------------------------------- admin: policies

  app.get(
    '/api/v1/admin/verification-policies',
    {
      preHandler: requirePermission('policy:read'),
      schema: {
        tags: ['admin'],
        summary: 'Verification policies',
        ...secured,
        querystring: PageQuerySchema.strict(),
        response: { 200: page(PolicyDto), ...errors },
      },
    },
    async (req) => {
      const r = await policies.list(decodeCursor(req.query.cursor), req.query.limit);
      return { data: r.items.map(toPolicyDto), page: { nextCursor: r.nextCursor } };
    },
  );

  app.post(
    '/api/v1/admin/verification-policies',
    {
      preHandler: requirePermission('policy:write'),
      schema: {
        tags: ['admin'],
        summary: 'Create a verification policy',
        ...secured,
        body: CreatePolicyBody,
        response: { 201: z.object({ data: PolicyDto }), ...errors },
      },
    },
    async (req, reply) =>
      reply.status(201).send(ok(toPolicyDto(await policies.create(req.body, req.ctx)))),
  );

  app.patch(
    '/api/v1/admin/verification-policies/:id',
    {
      preHandler: requirePermission('policy:write'),
      schema: {
        tags: ['admin'],
        summary: 'Change a verification policy (pass `version` for optimistic concurrency)',
        ...secured,
        params: IdParams,
        body: PatchPolicyBody,
        response: { 200: z.object({ data: PolicyDto }), ...errors },
      },
    },
    async (req) => ok(toPolicyDto(await policies.update(req.params.id, req.body, req.ctx))),
  );

  app.post(
    '/api/v1/admin/verification-policies/:id/deactivate',
    {
      preHandler: requirePermission('policy:write'),
      schema: {
        tags: ['admin'],
        summary: 'Deactivate a verification policy',
        ...secured,
        params: IdParams,
        response: { 200: z.object({ data: PolicyDto }), ...errors },
      },
    },
    async (req) => ok(toPolicyDto(await policies.deactivate(req.params.id, req.ctx))),
  );

  // ---------------------------------------------------------------- internal

  // Other services ask before publishing / transacting. Two indexed queries, no writes.
  app.get(
    '/internal/v1/verification/evaluate',
    {
      preHandler: runtime.internalOnly,
      schema: {
        hide: true,
        querystring: z.strictObject({
          accountId: z.uuid(),
          action: z.enum(EvaluatedActions),
          roles: csv.optional(),
          categoryId: z.uuid().optional(),
          mode: z.enum(NeedModes).optional(),
          amount: z.coerce.number().int().min(0).max(100_000_000_000).optional(),
        }),
        response: {
          200: z.object({
            data: z.object({
              satisfied: z.boolean(),
              required: z.array(Kind),
              missing: z.array(Kind),
              policyId: z.uuid().nullable(),
            }),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const q = req.query;
      const r = await verifications.evaluate(q.accountId, {
        action: q.action,
        roles: q.roles ?? [],
        categoryId: q.categoryId?.toLowerCase(),
        mode: q.mode,
        amount: q.amount,
      });
      return ok(r);
    },
  );
};
