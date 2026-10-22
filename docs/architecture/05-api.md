# 05 — API Specification

The **source of truth** for each service's API is its Zod route schemas, from
which OpenAPI 3.1 is generated (`GET /docs/json`, UI at `/docs` in non-prod).
This document fixes the conventions and the MVP surface.

## 1. Conventions

- Base path `/api/v1/…` (versioned by URL major; additive changes only within
  a version). Internal service-to-service APIs: `/internal/v1/…` (not routed
  by the gateway).
- JSON, `camelCase`, UTC ISO-8601 timestamps, money as
  `{ "amount": 8000000, "currency": "BDT" }` (minor units — ৳80,000.00).
- **Success envelope**: `{ "data": … }` for single resources;
  `{ "data": [...], "page": { "nextCursor": "…" | null } }` for lists.
- **Error envelope** (always):

```json
{
  "error": {
    "code": "OTP_INVALID",
    "message": "The code is invalid or has expired.",
    "details": {},
    "requestId": "01J…"
  }
}
```

- Headers: `X-Request-Id` (generated if absent, echoed), `X-Correlation-Id`
  (propagated across services and events), `Idempotency-Key` (required on
  critical POSTs), `Retry-After` on 429/503.
- Pagination: `?limit=20&cursor=…` (max 100). No offset pagination.
- Filtering: explicit query params validated by schema; no generic query
  language.
- Validation: request schemas are strict (unknown fields → `400 VALIDATION_FAILED`).

### Standard error codes

| HTTP | code                       | meaning                                                                |
| ---- | -------------------------- | ---------------------------------------------------------------------- |
| 400  | `VALIDATION_FAILED`        | schema violation (`details.issues[]`)                                  |
| 400  | `INVALID_PHONE`            | not a valid BD mobile number                                           |
| 400  | `OTP_INVALID`              | wrong, expired, consumed or exhausted challenge (deliberately generic) |
| 401  | `UNAUTHENTICATED`          | missing/invalid/expired token                                          |
| 401  | `SESSION_REVOKED`          | refresh token reuse or revoked session                                 |
| 403  | `FORBIDDEN`                | authenticated but not allowed                                          |
| 403  | `ACCOUNT_SUSPENDED`        | account not active                                                     |
| 403  | `VERIFICATION_REQUIRED`    | policy requires verification (`details.missing: ["NID"]`)              |
| 404  | `NOT_FOUND`                | resource missing or not visible to the actor                           |
| 409  | `CONFLICT`                 | version / state conflict                                               |
| 409  | `INVALID_STATE_TRANSITION` | e.g. accepting an expired offer                                        |
| 409  | `NEED_QUANTITY_EXHAUSTED`  | acceptance would exceed quantity                                       |
| 409  | `IDEMPOTENCY_KEY_REUSED`   | same key, different request body                                       |
| 409  | `IDEMPOTENCY_IN_PROGRESS`  | same key still processing                                              |
| 422  | `BUSINESS_RULE_VIOLATION`  | domain rule (`details.rule`)                                           |
| 429  | `RATE_LIMITED`             | throttled                                                              |
| 500  | `INTERNAL`                 | unexpected (no internals leaked)                                       |
| 503  | `UNAVAILABLE`              | dependency down / maintenance                                          |

### Idempotency semantics

For endpoints marked **(idem)**: the first request with a given
`(actor, route, Idempotency-Key)` executes and its response is stored for 24 h.
Retries with the same body get the stored response (with
`Idempotent-Replayed: true`). Same key + different body → `409
IDEMPOTENCY_KEY_REUSED`. Concurrent duplicate while the first is in flight →
`409 IDEMPOTENCY_IN_PROGRESS`.

## 2. MVP endpoints

Auth column: `—` public, `U` authenticated user, `P:perm` permission.

### Identity

| Method & path                            | Auth             | Notes                                                                                                                                                                                                 |
| ---------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/auth/request-otp`          | —                | `{ phone }` → `202 { challengeId, expiresAt, resendAfter }`                                                                                                                                           |
| `POST /api/v1/auth/verify-otp`           | —                | `{ challengeId, code, device: { key, platform, label? } }` → `{ accessToken, accessTokenExpiresAt, account, isNewAccount }` + refresh cookie (mobile: `refreshToken` in body when `X-Client: mobile`) |
| `POST /api/v1/auth/refresh`              | cookie           | rotation → new access token + cookie                                                                                                                                                                  |
| `POST /api/v1/auth/logout`               | U                | revoke current session                                                                                                                                                                                |
| `POST /api/v1/auth/logout-all`           | U                | revoke all sessions                                                                                                                                                                                   |
| `GET /api/v1/me/account`                 | U                | `{ id, phoneMasked, status, roles, createdAt }`                                                                                                                                                       |
| `GET /api/v1/me/sessions`                | U                | active sessions with device info                                                                                                                                                                      |
| `GET /api/v1/me/devices`                 | U                |                                                                                                                                                                                                       |
| `DELETE /api/v1/me/devices/:id`          | U                | revoke device + its sessions                                                                                                                                                                          |
| `GET /.well-known/jwks.json`             | —                | public keys                                                                                                                                                                                           |
| `POST /api/v1/admin/accounts/:id/status` | P:`user:suspend` | `{ status, reason }`                                                                                                                                                                                  |

### Profile & verification

| Method & path                                         | Auth                             | Notes                                                                   |
| ----------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `GET /api/v1/me/profile` · `PATCH /api/v1/me/profile` | U                                |                                                                         |
| `PUT /api/v1/me/seller-capabilities`                  | U                                | categories served, areas, delivery modes                                |
| `GET /api/v1/users/:id`                               | —                                | public profile DTO + reputation summary + verification badges           |
| `GET /api/v1/me/verifications`                        | U                                | statuses only                                                           |
| `POST /api/v1/me/verifications/nid`                   | U                                | starts provider flow; returns provider session (Stage 3)                |
| `GET /internal/v1/verification/evaluate`              | service                          | `?accountId&action&categoryId&amount&mode` → `{ satisfied, missing[] }` |
| `GET/PUT /api/v1/admin/verification-policies`         | P:`policy:read` / `policy:write` |                                                                         |

### Catalog

| Method & path                                                                                 | Auth                        | Notes                                                            |
| --------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `GET /api/v1/categories`                                                                      | —                           | tree, cached (ETag)                                              |
| `GET /api/v1/categories/:id/schema`                                                           | —                           | attribute JSON schema for forms                                  |
| `GET /api/v1/admin/categories` · `GET /api/v1/admin/categories/:id`                           | P:`category:manage`         | flat, inactive ones included (to switch them back on)            |
| `POST /api/v1/admin/categories` · `PATCH /api/v1/admin/categories/:id`                        | P:`category:manage`         | create; edit, including `active`                                 |
| `POST /api/v1/listings`                                                                       | U                           | create draft                                                     |
| `PATCH /api/v1/listings/:id` · `POST /api/v1/listings/:id/publish` · `…/pause` · `…/withdraw` | U (owner)                   |                                                                  |
| `GET /api/v1/listings`                                                                        | —                           | `?q&categoryId&district&minPrice&maxPrice&condition&kind&cursor` |
| `GET /api/v1/listings/:id`                                                                    | —                           |                                                                  |
| `POST /api/v1/admin/listings/:id/hide` · `…/restore`                                          | P:`moderation:content:hide` |                                                                  |

### Demand (Needs)

| Method & path                                                                     | Auth       | Notes                                                           |
| --------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| `POST /api/v1/needs`                                                              | U          | create (draft or `publish: true`)                               |
| `GET /api/v1/needs`                                                               | —          | open needs feed: `?q&categoryId&mode&district&budgetMax&cursor` |
| `GET /api/v1/needs/:id`                                                           | — / U      | public DTO; requester sees private fields                       |
| `PATCH /api/v1/needs/:id`                                                         | U (owner)  | material-edit rules apply                                       |
| `POST /api/v1/needs/:id/publish` · `…/pause` · `…/resume` · `…/close` · `…/renew` | U (owner)  |                                                                 |
| `GET /api/v1/me/needs`                                                            | U          |                                                                 |
| `GET /api/v1/needs/:id/matches`                                                   | U (owner)  | matched listings/sellers                                        |
| `GET /api/v1/me/matched-needs`                                                    | U (seller) | needs matched to me                                             |

Example — create a Need:

```http
POST /api/v1/needs
Authorization: Bearer …
Content-Type: application/json

{
  "mode": "BUY",
  "categoryId": "0192…-phones",
  "title": "iPhone 15 Pro, 256GB",
  "description": "Prefer battery health above 85%",
  "quantity": 1,
  "budget": { "max": { "amount": 8000000, "currency": "BDT" }, "flexible": false },
  "condition": ["USED"],
  "attributes": { "brand": "Apple", "model": "iPhone 15 Pro", "storageGb": 256 },
  "modeTerms": { "acceptsUsed": true, "warrantyRequired": false },
  "location": { "division": "dhaka", "district": "dhaka", "area": "mirpur" },
  "deliveryPreference": "EITHER",
  "requiredBy": "2026-10-15",
  "publish": true
}
```

### Offers

| Method & path                                   | Auth                       | Notes                                      |
| ----------------------------------------------- | -------------------------- | ------------------------------------------ |
| `POST /api/v1/needs/:id/offers`                 | U                          | seller submits **(idem)**                  |
| `GET /api/v1/needs/:id/offers`                  | U (requester)              | compare view, sortable by price/reputation |
| `GET /api/v1/me/offers`                         | U (seller)                 |                                            |
| `GET /api/v1/offers/:id`                        | U (party)                  | includes rounds                            |
| `POST /api/v1/offers/:id/counter`               | U (party whose turn it is) | **(idem)**                                 |
| `POST /api/v1/offers/:id/accept`                | U (party whose turn it is) | **(idem)** → `{ offer, transactionId? }`   |
| `POST /api/v1/offers/:id/reject` · `…/withdraw` | U (party)                  |                                            |

### Transactions

| Method & path                                                                                                                                       | Auth                                 | Notes                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `POST /api/v1/transactions`                                                                                                                         | U                                    | direct purchase of a listing **(idem)** (offer-based ones are created from `OfferAccepted`) |
| `GET /api/v1/transactions/:id`                                                                                                                      | U (party) / P:`transaction:read:any` |                                                                                             |
| `GET /api/v1/me/transactions`                                                                                                                       | U                                    |                                                                                             |
| `POST /api/v1/transactions/:id/confirm` · `…/arrange-delivery` · `…/mark-delivered` · `…/confirm-receipt` · `…/complete` · `…/cancel` · `…/dispute` | U (party, per transition table)      | all **(idem)**                                                                              |

### Trust, moderation, notifications, media

| Method & path                                               | Auth                       | Notes                                                 |
| ----------------------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| `POST /api/v1/transactions/:id/reviews`                     | U (party, after COMPLETED) |                                                       |
| `GET /api/v1/users/:id/reviews`                             | —                          |                                                       |
| `POST /api/v1/reports`                                      | U                          | `{ targetType, targetId, reason, details }`           |
| `GET /api/v1/admin/moderation/cases` · `POST …/:id/actions` | P:`moderation:*`           |                                                       |
| `GET /api/v1/me/notifications` · `POST …/:id/read`          | U                          |                                                       |
| `POST /api/v1/media/uploads`                                | U                          | `{ purpose, contentType, sizeBytes }` → presigned PUT |
| `POST /api/v1/media/:id/complete`                           | U                          | triggers sniff/scan/process                           |
| `GET /api/v1/media/:id`                                     | per visibility             | signed GET URL                                        |

## 3. Phase 2 endpoints

Every command `POST` takes an `Idempotency-Key` **(idem)**. Live OpenAPI at `/docs` on each service is the precise contract.

### Transactions (additions)

| Method & path                                                                                     | Auth                   | Notes                                                               |
| ------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| `POST /api/v1/transactions/:id/hand-over` · `…/report-return` · `…/confirm-return` · `…/complete` | U (party, RENT/BORROW) | hand-over/return sub-flow **(idem)**                                |
| `POST /api/v1/transactions/:id/dispute`                                                           | U (party)              | `{ reason, category? }`; opens a dispute case (ADR-0009) **(idem)** |

Deals are also created from `AuctionAwarded`, `BookingConfirmed` and `LoanApproved` (ADR-0008). The admin resolve endpoint is gone: resolution happens in the dispute service.

### Bidding

| Method & path                                                | Auth                                         | Notes                                                                      |
| ------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------- |
| `POST /api/v1/auctions`                                      | P:`auction:create` + policy `AUCTION_CREATE` | FORWARD on own PRODUCT listing, REVERSE on own SOURCE/BUY need **(idem)**  |
| `GET /api/v1/auctions` · `GET …/:id` · `GET …/:id/bids`      | —                                            | public; bidders shown as aliases; reserve price hidden (`reserveMet` only) |
| `POST /api/v1/auctions/:id/bids`                             | P:`bid:create` + policy `BID_PLACE`          | atomic under row lock, DB clock, anti-sniping **(idem)**                   |
| `POST /api/v1/auctions/:id/bids/:bidId/retract` · `…/cancel` | U (bidder / owner)                           | **(idem)**                                                                 |
| `GET /api/v1/me/auctions` · `GET /api/v1/me/bids`            | U                                            |                                                                            |
| `GET /api/v1/admin/auctions` · `POST …/:id/cancel`           | P:`auction:manage`                           |                                                                            |

### Rental

| Method & path                                                                    | Auth                                         | Notes                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `GET/PUT /api/v1/listings/:listingId/rental-terms`                               | — / U (owner)                                | instant book, durations, deposit, notice, buffer                   |
| `GET /api/v1/listings/:listingId/availability?from&to`                           | —                                            | busy intervals only                                                |
| `GET/POST /api/v1/listings/:listingId/availability/blocks` · `DELETE …/:blockId` | U (owner)                                    |                                                                    |
| `POST /api/v1/bookings`                                                          | P:`booking:create` + policy `BOOKING_CREATE` | HELD (instant book) or PENDING_APPROVAL; 409 on overlap **(idem)** |
| `POST /api/v1/bookings/:id/confirm` · `…/approve` · `…/decline` · `…/cancel`     | U (renter / owner)                           | **(idem)**                                                         |
| `GET /api/v1/bookings/:id` · `GET /api/v1/me/bookings`                           | U (party)                                    |                                                                    |
| `GET /api/v1/admin/bookings`                                                     | P:`transaction:read:any`                     |                                                                    |

### Lending

| Method & path                                                                | Auth                                                    | Notes                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `POST /api/v1/lend-items` · `PATCH …/:id` · `POST …/:id/deactivate`          | P:`lending:create` + policy `LEND_ITEM_PUBLISH` / owner | **(idem)**                                          |
| `GET /api/v1/lend-items` · `GET …/:id`                                       | —                                                       | search; requirements and lender stats               |
| `GET /api/v1/me/lend-items`                                                  | U                                                       |                                                     |
| `POST /api/v1/loans`                                                         | U + policy `LOAN_REQUEST`                               | trust gate → 422 `BORROWER_NOT_ELIGIBLE` **(idem)** |
| `POST /api/v1/loans/:id/approve` · `…/decline` · `…/cancel`                  | U (lender / borrower)                                   | 409 on overlapping approved loans **(idem)**        |
| `GET /api/v1/loans/:id` · `GET /api/v1/me/loans` · `GET /api/v1/admin/loans` | U (party) / P:`transaction:read:any`                    |                                                     |

### Disputes

| Method & path                                                       | Auth                         | Notes                                                |
| ------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `GET /api/v1/disputes/:id` · `GET /api/v1/me/disputes`              | U (party) / P:`dispute:read` | merged timeline; internal notes staff-only           |
| `POST /api/v1/disputes/:id/statement` · `…/evidence` · `…/withdraw` | U (party)                    | **(idem)**                                           |
| `GET /api/v1/admin/disputes` · `POST …/:id/assign` · `…/notes`      | P:`dispute:read`             |                                                      |
| `POST /api/v1/admin/disputes/:id/request-info` · `…/resolve`        | P:`dispute:resolve`          | RELEASE / CANCEL / REFUND (non-cash only) **(idem)** |

### Messaging

| Method & path                                               | Auth                     | Notes                                                                         |
| ----------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `POST /api/v1/conversations`                                | U                        | `{ contextType, contextId }` get-or-create; participants derived from context |
| `GET /api/v1/conversations` · `GET …/:id`                   | U (participant)          |                                                                               |
| `GET /api/v1/conversations/:id/messages?before\|after&wait` | U (participant)          | history, or long poll (≤ 8 s)                                                 |
| `POST /api/v1/conversations/:id/messages` · `…/read`        | P:`message:send`         | contact info rejected; `clientId` dedupe; rate limited                        |
| `GET/POST /api/v1/me/blocked-users` · `DELETE …/:userId`    | U                        |                                                                               |
| `GET /api/v1/admin/messages/:id`                            | P:`moderation:case:read` | audited                                                                       |

### Notifications (additions)

| Method & path                                                     | Auth | Notes                                  |
| ----------------------------------------------------------------- | ---- | -------------------------------------- |
| `GET/POST /api/v1/me/notifications/push-devices` · `DELETE …/:id` | U    | FCM / web push tokens                  |
| `GET/PUT /api/v1/me/notifications/preferences`                    | U    | per type × channel (in-app, push, SMS) |

### Dashboard (ADR-0010)

| Method & path                                                                | Auth               | Notes                                             |
| ---------------------------------------------------------------------------- | ------------------ | ------------------------------------------------- |
| `GET /api/v1/admin/activity` · `GET …/:id` · `GET …/facets` · `GET …/export` | P:`audit:read`     | cross-service activity log; CSV export is audited |
| `GET /api/v1/admin/dashboard/summary` · `…/timeseries` · `…/funnel`          | P:`dashboard:read` |                                                   |
| `GET /api/v1/me/dashboard` · `GET /api/v1/me/activity?scope=mine\|about-me`  | U                  |                                                   |
