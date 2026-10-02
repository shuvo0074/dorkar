# Service playbook

How to build a Dorkar backend service. `services/profile-service` is the reference
implementation; copy its shape.

## Layout

```
services/<name>-service/
  package.json            name @dorkar/<name>-service; deps already installed (do not run pnpm add)
  tsconfig.json           extends ../../tsconfig.base.json
  vitest.config.ts        project name = <name>
  .env.example
  migrations/
    0001_<name>.ts        raw SQL via kysely `sql`, unqualified table names (search_path is set)
    index.ts              [kernelMigration, (kernelIdempotencyMigration,) kernelOutboxTraceMigration, m0001…] in name order
  src/
    domain/               pure rules: entities, value objects, state machines, policies. No I/O.
    application/          use cases + ports (interfaces). Depends on domain only.
    infrastructure/       Kysely stores implementing the ports; db-schema.ts types.
    interfaces/http/      Zod schemas, DTO mappers, Fastify routes. No business rules.
    app.ts                composition root: build<Name>Service(env, logger, { verifier? })
    main.ts               runServiceMain(runtime, migrations)
    cli/migrate.ts        runMigrateCli({ service, defaultSchema, migrations })
  tests/unit/*.test.ts            domain rules
  tests/integration/*.test.ts     HTTP + DB + events, via startTestService
```

Lint enforces layer boundaries: `domain/` must not import `application/`,
`infrastructure/` or `interfaces/`; `application/` must not import the last two.

## Kernel API you build on (`@dorkar/kernel`)

- `serviceEnvSchema.extend({ SERVICE_NAME, PORT, DATABASE_SCHEMA, … })` + `loadConfig`.
- `createServiceRuntime<DB>({ config, logger, producer, openapi, verifier?, idempotency? })` gives
  `app`, `db`, `redis`, `bus`, `auth.authenticate`, `auth.requirePermission(perm)`,
  `internalOnly`, `event(def, aggregateId, payload, ctx)`, `on(def, handler)`, `deliver(envelope)`,
  `every(name, ms, run)`, `metrics`, `startWorkers/stopWorkers/close`.
- Observability is built in: `/metrics` (when `METRICS_TOKEN` is set), RED metrics per route
  template, outbox/consumer/job metrics, and W3C `traceparent` propagation (HTTP, internal client,
  event envelopes). Pass `req.ctx` to `runtime.event(...)` and internal calls; never put ids or
  user data in metric labels (docs/architecture/07-operations.md §4).
- Write state + event in one transaction: `appendToOutbox(trx, runtime.event(Def, id, payload, req.ctx))`.
- Consume another service's event: `runtime.on(OtherEvents.X, async (payload, envelope, trx) => …)`.
  It runs inside the inbox transaction, exactly once. Write only with `trx`. Types emitted by every
  service (`audit.ActivityRecorded`) take `{ producers: [...] }` as a third argument.
- Audit important actions in the same transaction: `appendAudit(trx, req.ctx, { action, targetType, targetId, metadata })`.
  `metadata` never holds PII or secrets. Each audit record is also queued as an
  `audit.ActivityRecorded` outbox row (aggregate id = audit id) for the activity log; when a test
  inspects the outbox, filter by `type` or `aggregate_id`.
- Critical POSTs (accept, create transaction, place bid…): `withIdempotency(db, { actorId, scope, key: req.headers['idempotency-key'], fingerprint: requestFingerprint({ params, body }), required: true }, run)`.
  Include `kernelIdempotencyMigration` and pass `idempotency: true` to the runtime.
- Lists: keyset pagination with `decodeCursor`, `paginate(rows /* limit+1 */, limit, row => ({ k, id }))`.
  Response `{ data: [...], page: { nextCursor } }`. Never OFFSET.
- Errors: throw `AppError(code, message, details?)` or `Errors.*`. Codes live in `@dorkar/contracts` `ErrorCodes`.
  `404 NOT_FOUND` for resources the caller may not see (no IDOR leaks), `409 INVALID_STATE_TRANSITION`,
  `422 BUSINESS_RULE_VIOLATION` with `details.rule`.
- Internal endpoints: `/internal/v1/...` with `preHandler: runtime.internalOnly`. Call others with
  `createInternalClient({ baseUrl, token: config.INTERNAL_API_TOKEN })`.

## Contracts (`@dorkar/contracts`)

Events are already defined in `marketplace-events.ts` (MVP), `engagement-events.ts` (bidding,
rental, lending, dispute, messaging) and `activity.ts`; use them as-is. If you need a new
event or field, **do not edit contracts**; report it in your final summary. Also there:
`MoneySchema` (integer poisha), `NeedModes`, `Conditions`, `DeliveryModes`, `LocationSchema` /
`DistrictSchema`, `validateAttributes`, `findContactInfo` (reject phone/email in public text:
the product promises phone numbers stay private), `permissionsFor`, `Roles`.

## HTTP conventions

- Paths `/api/v1/...`; request schemas `z.strictObject` (unknown keys → 400).
- Responses validated by Zod; explicit DTO mappers (never serialize rows). Dates: the `iso` codec
  pattern from profile routes (handlers return `Date`).
- Every route declares `tags`, `response` incl. error codes; secured routes add `security: [{ bearerAuth: [] }]`.
- Authorization: coarse permission via `auth.requirePermission('…')`; resource rules (ownership,
  state) in the application layer. Repository reads of user-owned data take the owner id.

## Data conventions

- IDs: `uuidv7()` from the kernel, generated in the app.
- Money: `bigint`-safe `amount bigint` + `currency char(3)`; map to number in the store (amounts ≤ 1e11).
  (pg returns int8 as string; convert with `Number()`.)
- Timestamps `timestamptz`; compare deadlines with DB `now()`.
- State changes: guarded `UPDATE … WHERE id = $1 AND status = $from` (+ `version`) so concurrent
  transitions cannot both succeed; append a history row; emit the event.
- Text enums as `text` + `CHECK (... IN (...))`. JSONB for category attributes.
- Indexes for every list/filter you expose. Full-text: generated `tsvector` column + GIN.
- Runtime queries are schema-scoped by Kysely's `withSchema`, which does **not** rewrite table
  names inside raw `sql` fragments. In raw SQL reference only columns; name tables through the
  query builder (`selectFrom`, `updateTable`, …) or `sql.table(...)` qualified with the schema.
  Migrations are different: they run with `search_path` set, so unqualified names are fine there.

## Tests (mandatory)

- Unit tests for domain rules and state machines (exhaustive transition tables).
- Integration tests with `startTestService({ schemaPrefix, migrations, build })` from
  `@dorkar/kernel/testing`: real Postgres (fresh schema) + real Redis; tokens via `t.auth.as(id, roles)`;
  drive other services' events with `t.svc.runtime.deliver(envelope(Def, payload))`.
- Cover: happy paths, authz (other user → 404/403), validation, state conflicts, concurrency where
  the spec demands it (`Promise.all` of competing requests), idempotency, outbox events written.

## Definition of done (run from the repo root)

```bash
npx tsc -p services/<name>-service
npx eslint services/<name>-service
npx prettier --write services/<name>-service
npx vitest run --project <name>
```

All four clean. Touch nothing outside `services/<name>-service/` (no root configs, no
contracts, no kernel, no gateway, no lockfile). Do not commit.
