# Dorkar — Architecture & Engineering Docs

Dorkar is a **demand-first marketplace** for Bangladesh: a user posts a _Need_
("used iPhone 15 Pro, 256GB, Dhaka, ≤ ৳80,000") and the market responds with
offers, bids, rental terms, service quotes or sourcing proposals.

> Tell us what you need. Let the market come to you.

## Deliverables index

| #    | Deliverable                                     | Where                                                                                                                                                |
| ---- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | High-level architecture diagram                 | [01-architecture.md §1](architecture/01-architecture.md#1-high-level-architecture)                                                                   |
| 2    | Microservice responsibility map                 | [01-architecture.md §2](architecture/01-architecture.md#2-service-responsibility-map)                                                                |
| 5    | Service-to-service communication diagram        | [01-architecture.md §4](architecture/01-architecture.md#4-communication)                                                                             |
| 3    | Database architecture                           | [02-data.md §1](architecture/02-data.md#1-database-architecture)                                                                                     |
| 4    | Database schema / ERD                           | [02-data.md §3](architecture/02-data.md#3-schemas--erd)                                                                                              |
| 17   | Backup / restore strategy                       | [02-data.md §5](architecture/02-data.md#5-backup-restore--disaster-recovery)                                                                         |
| 18   | Database migration strategy                     | [02-data.md §4](architecture/02-data.md#4-migrations)                                                                                                |
| 8–11 | Need / Offer / Bid / Transaction state machines | [03-lifecycles.md](architecture/03-lifecycles.md)                                                                                                    |
| 6    | Authentication flow                             | [04-security.md §1](architecture/04-security.md#1-authentication)                                                                                    |
| 7    | Authorization model                             | [04-security.md §3](architecture/04-security.md#3-authorization-model)                                                                               |
| 15   | Security threat model                           | [04-security.md §5](architecture/04-security.md#5-threat-model)                                                                                      |
| 16   | Data privacy model                              | [04-security.md §6](architecture/04-security.md#6-privacy--data-protection)                                                                          |
| 12   | API specification                               | [05-api.md](architecture/05-api.md) (+ live OpenAPI at `/docs` per service)                                                                          |
| 13   | Frontend architecture                           | [06-frontend.md](architecture/06-frontend.md)                                                                                                        |
| 14   | Folder structure                                | [06-frontend.md §2](architecture/06-frontend.md#2-folder-structure) and [01-architecture.md §6](architecture/01-architecture.md#6-repository-layout) |
| 19   | Deployment architecture                         | [07-operations.md §1](architecture/07-operations.md#1-deployment-architecture)                                                                       |
| 20   | CI/CD architecture                              | [07-operations.md §2](architecture/07-operations.md#2-cicd)                                                                                          |
| 21   | Testing strategy                                | [07-operations.md §3](architecture/07-operations.md#3-testing-strategy)                                                                              |
| 22   | Observability strategy                          | [07-operations.md §4](architecture/07-operations.md#4-observability)                                                                                 |
| 23   | Cost-conscious infrastructure plan              | [07-operations.md §5](architecture/07-operations.md#5-cost-plan)                                                                                     |
| 24   | MVP scope                                       | [08-roadmap.md §1](architecture/08-roadmap.md#1-mvp-scope)                                                                                           |
| 25   | Post-MVP roadmap                                | [08-roadmap.md §2](architecture/08-roadmap.md#2-post-mvp-roadmap)                                                                                    |

Architecture decisions are recorded in [adr/](adr/).

## Build order (incremental)

Each module goes through: architecture → contracts → DB model → API → tests →
implementation → run tests → security review → performance review → refactor.

1. **Platform kernel** + local infra (Postgres, Redis, compose, CI) ✅
2. **Identity service** (phone + OTP, sessions, devices) ✅
3. Gateway (edge auth, routing, rate limits)
4. Profile + Verification (policy engine)
5. Catalog (categories, attribute schemas, listings, search)
6. Demand (Needs) + Matching (rule-based)
7. Offers + negotiation
8. Transactions (cash, self-arranged delivery)
9. Reputation (reviews), Moderation (reports), Notifications, Media
10. Web app (React) — built feature-by-feature alongside 3–9
11. Phase 2: Bidding, Rental, Lending, Disputes, Messaging
