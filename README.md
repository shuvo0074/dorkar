# Dorkar

Demand-first marketplace for Bangladesh — _tell us what you need, let the market come to you._

Architecture, decisions and roadmap: [docs/README.md](docs/README.md).

## Repository

| Path                        | What                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`        | Shared types: BD phone normalization, error codes, roles/permissions, event schemas                                                           |
| `packages/kernel`           | Platform kit: config, logging, errors, HTTP server conventions, DB + migrator, outbox/relay, audit log, rate limiter, jobs, graceful shutdown |
| `services/identity-service` | Phone + OTP login, sessions, refresh rotation, devices, account status                                                                        |
| `infra/`                    | Docker Compose, Postgres bootstrap, backup/restore scripts, k6 load tests                                                                     |

## Local development

Requirements: Node ≥ 24, pnpm 10, and either Docker or local Postgres ≥ 14 + Redis ≥ 7.

```bash
pnpm install
pnpm infra:up                                   # Postgres :5433, Redis :6380 (Docker)
cp services/identity-service/.env.example services/identity-service/.env
pnpm --filter @dorkar/identity-service keys:generate >> services/identity-service/.env
pnpm --filter @dorkar/identity-service migrate up
pnpm --filter @dorkar/identity-service dev       # http://localhost:4001/docs
cp services/gateway/.env.example services/gateway/.env   # then set PII_HASH_KEY
pnpm --filter @dorkar/gateway dev                # public entry point: http://localhost:4000
```

In development, OTP SMS messages are appended to `services/identity-service/var/dev-sms.log`
(never to the application log).

Bootstrap the first admin: `pnpm --filter @dorkar/identity-service grant-role 017XXXXXXXX SUPER_ADMIN`.

## Checks

```bash
pnpm lint && pnpm typecheck
pnpm test        # unit + integration against real Postgres/Redis
                 # (TEST_DATABASE_URL / TEST_REDIS_URL, defaults: localhost:5432/dorkar_test, localhost:6379/15)
pnpm build
```
