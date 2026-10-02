# Dorkar

Demand-first marketplace for Bangladesh — _tell us what you need, let the market come to you._

Architecture, decisions and roadmap: [docs/README.md](docs/README.md). Rules for adding a service:
[docs/engineering/service-playbook.md](docs/engineering/service-playbook.md).

## Repository

| Path                            | Port | What                                                                                                                     |
| ------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/contracts`            |      | Shared types: BD phone/locations, money, roles/permissions, error codes, event schemas                                   |
| `packages/kernel`               |      | Platform kit: config, logging, errors, HTTP conventions, DB + migrator, outbox/relay, inbox, idempotency, jobs, test kit |
| `services/gateway`              | 4000 | Public entry point: edge auth, immediate revocation, routing, rate limits                                                |
| `services/identity-service`     | 4001 | Phone + OTP login, sessions, refresh rotation, devices, account status, audited contact lookup                           |
| `services/profile-service`      | 4002 | Profiles, user types, seller capabilities                                                                                |
| `services/verification-service` | 4003 | Verification records (phone, NID review) and the policy engine                                                           |
| `services/catalog-service`      | 4004 | Categories, attribute schemas, listings, search                                                                          |
| `services/demand-service`       | 4005 | Needs and their lifecycle                                                                                                |
| `services/media-service`        | 4006 | Uploads, signed URLs (local disk or S3)                                                                                  |
| `services/matching-service`     | 4007 | Rule-based, explainable Need ↔ seller matching                                                                           |
| `services/offer-service`        | 4008 | Offers, counter-offers, exclusive acceptance                                                                             |
| `services/transaction-service`  | 4009 | Deals from offers or direct purchase; state machine, cash + self-arranged delivery, disputes                             |
| `services/reputation-service`   | 4010 | Reviews after completed deals, trust signals                                                                             |
| `services/moderation-service`   | 4011 | Reports, moderation actions                                                                                              |
| `services/notification-service` | 4012 | Event-driven in-app notifications and SMS                                                                                |
| `services/bidding-service`      | 4013 | Forward and reverse auctions, atomic bids, anti-sniping, awards                                                          |
| `services/rental-service`       | 4014 | Availability calendars, rental terms, holds and booking approval (no double-booking)                                     |
| `services/lending-service`      | 4015 | Lend items, trust-gated borrow requests, loan history                                                                    |
| `services/dispute-service`      | 4016 | Dispute cases: statements, evidence, deadlines, staff resolution                                                         |
| `services/messaging-service`    | 4017 | Context-bound conversations, long-poll delivery, blocking; numbers stay private                                          |
| `services/dashboard-service`    | 4018 | Admin dashboard: metrics, cross-service activity log; personal dashboard                                                 |
| `infra/`                        |      | Docker Compose (generated), Postgres bootstrap, backup/restore scripts, k6 load tests                                    |

## Local development

Requirements: Node ≥ 24, pnpm 10, local Postgres ≥ 14 and Redis ≥ 7.

```bash
pnpm install
pnpm dev:setup      # once (idempotent): .env.dev secrets, database, per-service schemas/roles, migrations
pnpm dev:backend    # all 18 services + gateway with labelled logs; public API at http://localhost:4000
pnpm e2e:backend    # in another terminal: the full loop — sign-in → need → match → offer → deal → review
pnpm e2e:phase2     # auctions, rentals, lending, messaging, disputes, dashboard, push
```

`dev:setup` uses `DATABASE_URL` (admin connection, default `postgres://localhost:5432/dorkar`) and
`REDIS_URL` (default `redis://localhost:6379/0`). `pnpm dev:backend profile demand` starts only those
services plus the gateway. Each service also serves OpenAPI docs at `http://localhost:<port>/docs`.

In development, OTP SMS messages are appended to `var/dev-sms.log` (never to the application log)
and push notifications to `var/dev-push.log`.

Bootstrap the first admin:
`pnpm --filter @dorkar/identity-service grant-role 017XXXXXXXX SUPER_ADMIN` (with `.env.dev` values in the environment).

### With Docker

```bash
cp infra/docker/secrets.env.example infra/docker/secrets.env   # fill it in
docker compose -f infra/docker/compose.yml up --build            # gateway on http://localhost:4000
```

`infra/docker/compose.yml` is generated from `scripts/backend-services.mjs` by `node scripts/gen-compose.mjs`.

## Checks

```bash
pnpm lint && pnpm typecheck
pnpm test        # unit + integration against real Postgres/Redis
                 # (TEST_DATABASE_URL / TEST_REDIS_URL, defaults: localhost:5432/dorkar_test, localhost:6379/15)
pnpm build
```
