# Architecture Decision Records

Short, immutable records. Supersede rather than edit.

## ADR-0001 — Microservices with schema-per-service on one Postgres cluster

**Status**: accepted · 2026-10-01
**Context**: the spec requires microservices from day one but also low cost and DB portability.
**Decision**: each service is an independently deployable process with its own Postgres _schema_ and _login role_ inside one cluster. No cross-schema queries or FKs. Services communicate via events (outbox) and narrow internal APIs.
**Consequences**: one cheap instance in Stage 1; strong boundaries enforced by DB grants; a service can be moved to its own cluster by dump/restore of its schema + `DATABASE_URL` change. Cross-service reads need projections.

## ADR-0002 — Fastify + Zod + Kysely

**Status**: accepted
**Decision**: Fastify 5 for HTTP (fast, schema-first, mature plugins); Zod 4 as the single schema language for requests, responses, config and events (OpenAPI generated via `fastify-type-provider-zod`); Kysely as a type-safe query builder over `pg` (SQL-transparent, no ORM entity/DB coupling, explicit transactions and locking).
**Rejected**: Prisma (heavy engine, weaker control over locking/SQL, harder to keep domain models separate); TypeORM (active-record coupling).

## ADR-0003 — Transactional outbox + Redis Streams as the Stage-1 event bus

**Status**: accepted
**Decision**: events are written to a per-service `outbox` table in the business transaction; a relay publishes to Redis Streams (consumer groups, DLQ stream). Consumers dedupe via a per-service `inbox` table.
**Rejected for now**: Kafka (operational cost not justified), RabbitMQ (another stateful component). `EventBus` is a port; NATS JetStream/RabbitMQ can replace the adapter.
**Consequences**: Redis loss loses no events (outbox replays); ordering guaranteed only per aggregate stream key.

## ADR-0004 — Phone + OTP with short JWT access tokens and rotating opaque refresh tokens

**Status**: accepted
**Decision**: Ed25519-signed JWT access tokens (10 min) verified locally by gateway/services via JWKS; opaque refresh tokens (hash stored) with rotation and reuse detection, bound to a session and device. Web keeps refresh token in an httpOnly SameSite=Strict cookie.
**Consequences**: stateless request auth; revocation latency ≤ access TTL, covered for bans by a gateway `sid` denylist.

## ADR-0005 — Hire/Source/Buy/Rent/Borrow are Need & Offer _modes_, not services

**Status**: accepted
**Decision**: the post → respond → negotiate → agree lifecycle is shared; mode-specific data lives in validated `mode_terms` JSONB with versioned schemas. Rental (calendars, double-booking) and Lending (returns, trust gating) get their own services because they own distinct invariants.

## ADR-0006 — UUIDv7 primary keys generated in the application

**Status**: accepted
**Decision**: time-ordered UUIDs give index locality like bigserial, are safe to expose publicly, survive data moves between clusters, and let us generate IDs before insert (outbox payloads, idempotent creates).
