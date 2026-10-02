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

## ADR-0007 — Immediate token revocation at the gateway via identity events

**Status**: accepted · 2026-10-01
**Context**: access tokens are verified offline (ADR-0004), so logout, device revocation and bans only took effect when the token expired (≤ 10 min). Checking every request against identity would make identity a synchronous dependency of all traffic.
**Decision**: identity emits revocation events through its outbox; the gateway consumes them (Redis Streams consumer group) into a Redis denylist keyed by session, device and account (`iat` cut-off), each entry living one access-token TTL. The gateway rejects denylisted tokens with `SESSION_REVOKED`. Services keep verifying signatures themselves.
**Consequences**: cut-off in well under a second without a per-request call to identity. The denylist is bounded (only revocations within the last TTL). On Redis loss the check fails open and degrades to the old TTL bound. Services must only be reachable through the gateway.

## ADR-0008 — Every kind of deal converges on the transaction service

**Status**: accepted · 2026-10-02
**Context**: Phase 2 adds three new ways to reach agreement (auction award, rental booking, loan approval). Giving each its own post-agreement lifecycle would triplicate hand-over, completion, disputes, reviews and notifications.
**Decision**: bidding, rental and lending own how agreement is reached (bids, calendars and holds, borrow requests and trust gating) and emit one deal-creating event (`AuctionAwarded`, `BookingConfirmed`, `LoanApproved`). The transaction service creates exactly one transaction per source (`sourceType` AUCTION/BOOKING/LOAN, unique with `sourceId`) and owns everything after agreement. RENT and BORROW extend its state table with `HANDED_OVER → RETURN_REPORTED → RETURNED`, as 03-lifecycles §4 planned. The originating services mirror the transaction state from `TransactionStateChanged` for their own views (calendar release, loan history).
**Consequences**: reviews, disputes, notifications and dashboards handle every deal the same way. The originating service and the transaction can briefly disagree (eventual consistency); the transaction is authoritative.

## ADR-0009 — Disputes are a service; the transaction state machine stays the authority

**Status**: accepted · 2026-10-02
**Decision**: a party still opens a dispute through the transaction (`POST /transactions/:id/dispute`), which owns the dispute-window guards. The dispute service consumes `TransactionStateChanged → DISPUTED` and opens a case with evidence, statements, deadlines and staff assignment. Resolution and withdrawal are decided in the dispute service and applied by the transaction service from `DisputeResolved` / `DisputeWithdrawn`. The transaction service no longer exposes its own resolve endpoint.
**Consequences**: one place for the case file and one place for state; a resolution is applied exactly once (inbox).

## ADR-0010 — A dashboard service as the admin BFF, fed by events

**Status**: accepted · 2026-10-02 · amends 01-architecture §2 ("Admin is not a service")
**Context**: the admin dashboard needs platform-wide numbers and one activity log across all services. Fanning out to 18 services per page would couple the dashboard to every service's availability and make cross-service filters and ordering expensive.
**Decision**: the kernel publishes every audit record as `audit.ActivityRecorded` through the outbox, in the same transaction as the audited change. The dashboard service consumes it from every producer's stream into an indexed activity log, and consumes domain events into daily metric counters and per-user summaries. Admin write actions stay in the owning services.
**Consequences**: the activity log and metrics are read models: eventually consistent (normally under a second), rebuildable by replaying streams, and the dashboard can be down without affecting any write path. Audit records stay authoritative in each service.
