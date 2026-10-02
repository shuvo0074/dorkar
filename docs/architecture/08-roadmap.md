# 08 — MVP Scope & Roadmap

## 1. MVP scope

The MVP proves one loop: **Post Need → offers arrive → compare/negotiate →
accept → cash transaction → complete → review.** Listings exist so sellers
have a presence and matching has supply, but the UX leads with the Need.

| Area          | In MVP                                                                                                                                                      | Explicitly out                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Auth          | BD phone + OTP, sessions, device registration, logout-all                                                                                                   | passwords, social login, 2FA apps                               |
| User          | profile, user type, seller capabilities, verification status badges                                                                                         | business KYB                                                    |
| Verification  | phone verified, policy engine (all policies data-driven), NID policy _config_ with provider port (no provider wired; policies default to `NONE`/`OPTIONAL`) | live NID provider integration                                   |
| Catalog       | category tree with attribute schemas, listings (product/service), Postgres search & browse                                                                  | rental calendars                                                |
| Demand        | Post a Need (BUY, HIRE, SOURCE modes fully; RENT/BORROW as needs that receive offers), need management, expiry & renewal                                    | AI need creation                                                |
| Matching      | rule-based (category, location, budget, capabilities, verification) + seller notifications                                                                  | ML ranking                                                      |
| Offers        | submit, accept/reject, counter (bounded rounds)                                                                                                             | auctions/bidding                                                |
| Transactions  | cash, buyer/seller confirmation, self-arranged delivery, completion, cancel, `DISPUTED` flag → moderation                                                   | payment gateways, logistics integrations, full dispute workflow |
| Trust         | reviews, reports, basic verification                                                                                                                        | reputation score UI beyond simple signals                       |
| Notifications | in-app + SMS for key events                                                                                                                                 | push, email, WhatsApp                                           |
| Media         | images for listings/needs/offers (presigned, processed, scanned)                                                                                            | video                                                           |
| Admin         | user management (suspend/restore), listing & need moderation, offer/transaction monitoring, audit log viewer, category & policy editor                      | analytics dashboards                                            |

## 2. Post-MVP roadmap

| Phase                | Theme                  | Items                                                                                                                                                                                                                                                                    |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2 (MVP + 2–4 months) | Liquidity & engagement | bidding service (reverse auctions for SOURCE needs first, then forward), rental service with availability calendar, lending service, in-app messaging (context-bound, numbers hidden), dispute service, push notifications, observability stack, search engine if needed |
| 3                    | Money & logistics      | `PaymentProvider` adapters: bKash, Nagad, cards, escrow/hold; `DeliveryProvider` adapters: Pathao, Steadfast, RedX; NID provider integration; business accounts & bulk sourcing UX; React Native apps with device-bound keys; advanced matching (learned weights)        |
| 4                    | AI                     | AI assistant: NL → structured Need draft, follow-up questions, budget suggestions, offer comparison; AI-assisted matching as a `MatchScorer`; always user-confirmed, never authorizes money or security actions                                                          |

## 3. Module-by-module plan

| #   | Module                                         | Status  |
| --- | ---------------------------------------------- | ------- |
| 1   | Platform kernel, repo tooling, local infra, CI | ✅ done |
| 2   | Identity service                               | ✅ done |
| 3   | Gateway                                        | ✅ done |
| 4   | Profile + Verification                         | ✅ done |
| 5   | Catalog                                        | ✅ done |
| 6   | Demand + Matching                              | ✅ done |
| 7   | Offer                                          | ✅ done |
| 8   | Transaction                                    | ✅ done |
| 9   | Reputation, Moderation, Notification, Media    | ✅ done |
| 10  | Phase 2 (see below)                            | ✅ done |
| 11  | Web app                                        | next    |

Phase 2 status:

| Item                                                             | Status                                                           |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| Bidding (reverse auctions on needs, forward on listings)         | ✅                                                               |
| Rental with availability calendar                                | ✅                                                               |
| Lending                                                          | ✅                                                               |
| In-app messaging (context-bound, numbers hidden)                 | ✅                                                               |
| Dispute service                                                  | ✅                                                               |
| Push notifications (FCM, behind a port)                          | ✅ (FCM untested against Google)                                 |
| Admin dashboard + cross-service activity log, personal dashboard | ✅ (ADR-0010)                                                    |
| Observability stack                                              | ✅ Prometheus metrics, trace context, Grafana (OTel export next) |
| Search engine                                                    | not needed yet: Postgres FTS per service is within targets       |

Known follow-ups: S3 media storage and a production SMS provider (both behind ports, untested
against real vendors); a `MediaDeleted` event; category deactivation cascading to listings;
`listingId` on `TransactionCreated` so catalog can decrement stock for offer-driven deals.
