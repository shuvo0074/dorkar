# 03 — Lifecycles & State Machines

Every aggregate with a lifecycle has **one** transition table in its domain
layer (`domain/<aggregate>-state-machine.ts`). Application services call
`machine.transition(current, event, ctx)`; nothing else may assign `status`.
Every successful transition is persisted together with a history row and an
outbox event in one DB transaction, guarded by
`UPDATE … WHERE id = $1 AND status = $from AND version = $v` so concurrent
transitions cannot both succeed.

## 1. Need

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> OPEN: publish (policy checks pass)
  DRAFT --> [*]: discard
  OPEN --> OPEN: edit (non-material) / receive offer
  OPEN --> PAUSED: requester pauses
  PAUSED --> OPEN: resume (if not expired)
  OPEN --> FULFILLING: offer(s) accepted, accepted_quantity ≥ quantity
  OPEN --> CLOSED: requester closes
  OPEN --> EXPIRED: expires_at reached (job)
  PAUSED --> EXPIRED: expires_at reached
  FULFILLING --> OPEN: transaction cancelled & quantity re-opens
  FULFILLING --> FULFILLED: all transactions COMPLETED
  OPEN --> HIDDEN: moderator hides
  HIDDEN --> OPEN: moderator restores
  EXPIRED --> OPEN: requester renews (within renewal window, max renewals policy)
  FULFILLED --> [*]
  CLOSED --> [*]
```

Rules (configurable via policies/settings, not code):

- `need.default_ttl_days` (e.g. 14), `need.max_ttl_days`, `need.max_renewals`.
- `need.max_open_per_user` (anti-spam), `need.max_offers` per need (default 50).
- **Material edits** (category, mode, quantity decrease below accepted,
  budget reduced) while offers exist → existing live offers are flagged
  `NEEDS_RECONFIRM` (seller is notified) rather than silently changed.
- Verification policy evaluated at `publish` (e.g. high-value SOURCE needs may
  require NID).

## 2. Offer (with negotiation)

```mermaid
stateDiagram-v2
  [*] --> SUBMITTED: seller submits (need OPEN, seller eligible)
  SUBMITTED --> COUNTERED_BY_BUYER: buyer counters
  COUNTERED_BY_BUYER --> COUNTERED_BY_SELLER: seller counters
  COUNTERED_BY_SELLER --> COUNTERED_BY_BUYER: buyer counters
  COUNTERED_BY_BUYER --> SUBMITTED: seller accepts counter (new terms become offer terms)
  SUBMITTED --> ACCEPTED: buyer accepts
  COUNTERED_BY_SELLER --> ACCEPTED: buyer accepts
  SUBMITTED --> REJECTED: buyer rejects
  COUNTERED_BY_SELLER --> REJECTED: buyer rejects
  COUNTERED_BY_BUYER --> REJECTED: seller declines
  SUBMITTED --> WITHDRAWN: seller withdraws
  COUNTERED_BY_SELLER --> WITHDRAWN: seller withdraws
  COUNTERED_BY_BUYER --> WITHDRAWN: seller withdraws
  SUBMITTED --> EXPIRED: offer expires_at or need closes/expires
  COUNTERED_BY_BUYER --> EXPIRED
  COUNTERED_BY_SELLER --> EXPIRED
  ACCEPTED --> CANCELLED: transaction cancelled before confirmation
  ACCEPTED --> [*]
  REJECTED --> [*]
  WITHDRAWN --> [*]
  EXPIRED --> [*]
```

- Each counter creates an immutable `offer_rounds` row; the party who did
  **not** make the latest round is the only one who can accept it.
- `negotiation.max_rounds` (default 5) per offer.
- **Exclusive acceptance**: inside one DB transaction, the offer service locks
  the need's row in its `need_projection` (`SELECT … FOR UPDATE`), checks
  `accepted_quantity + offer.quantity ≤ quantity`, transitions the offer with
  a status/version guard, increments `accepted_quantity`, writes the outbox
  event. Two concurrent accepts for the last unit serialize on the lock; the
  second gets `409 NEED_QUANTITY_EXHAUSTED`. The API requires
  `Idempotency-Key`.
- When a need becomes fully accepted, remaining live offers transition to
  `EXPIRED` (reason `NEED_FULFILLED`) asynchronously.

## 3. Bid / Auction (Phase 2)

```mermaid
stateDiagram-v2
  [*] --> SCHEDULED
  SCHEDULED --> OPEN: starts_at reached
  SCHEDULED --> CANCELLED: owner cancels (no bids possible yet)
  OPEN --> OPEN: bid placed (extends ends_at by anti_snipe if within window)
  OPEN --> CLOSING: ends_at reached (job, DB clock)
  CLOSING --> AWARDED: leading bid meets reserve
  CLOSING --> NO_WINNER: no bids / reserve not met
  OPEN --> CANCELLED: owner cancels (only if no bids, policy)
  AWARDED --> SETTLED: winner's transaction created
  AWARDED --> NO_WINNER: winner defaults (policy: offer to next bidder)
```

Bid states: `ACCEPTED (leading) → OUTBID`, `REJECTED`, `RETRACTED` (only within
`bid.retraction_window` and only if policy allows), `WON`, `LOST`.

**Atomic bid placement** (single DB transaction):

```sql
BEGIN;
SELECT … FROM auctions WHERE id = $1 FOR UPDATE;               -- serialize bids per auction
-- validate in app with values read under lock + DB now():
--   status = 'OPEN' AND now() < ends_at
--   bidder ≠ owner, bidder eligible (verification policy), not banned
--   FORWARD: amount ≥ max(start_price, leading + min_increment)
--   REVERSE: amount ≤ leading - min_increment (and ≤ budget ceiling)
INSERT INTO bids (…, idempotency_key) ON CONFLICT (auction_id, bidder_id, idempotency_key) DO NOTHING RETURNING …;
UPDATE bids SET status='OUTBID' WHERE id = <previous leading>;
UPDATE auctions SET leading_bid_id = …, ends_at = greatest(ends_at, now() + anti_snipe), version = version + 1 WHERE id = $1;
INSERT INTO outbox …  -- BidPlaced, BidOutbid
COMMIT;
```

The row lock is short (no network I/O inside the transaction). For very hot
auctions a Redis lock is **not** used for correctness — only Postgres is.

## 4. Transaction

```mermaid
stateDiagram-v2
  [*] --> CREATED: from OfferAccepted / listing purchase / auction award
  CREATED --> CONFIRMED: both parties confirm (or seller confirms, per policy)
  CREATED --> CANCELLED: either party cancels (free cancellation window)
  CREATED --> EXPIRED: not confirmed within confirm_ttl
  CONFIRMED --> DELIVERY_PENDING: delivery arranged
  CONFIRMED --> CANCELLED: cancel (policy: may count against reputation)
  DELIVERY_PENDING --> DELIVERED: seller marks delivered / buyer confirms receipt
  DELIVERED --> COMPLETED: buyer confirms, or auto after completion_window without dispute
  DELIVERY_PENDING --> DISPUTED: either party
  DELIVERED --> DISPUTED: buyer, within dispute_window
  DISPUTED --> COMPLETED: resolution = release
  DISPUTED --> CANCELLED: resolution = cancel
  DISPUTED --> REFUNDED: resolution = refund (non-cash providers)
  COMPLETED --> [*]
  CANCELLED --> [*]
  REFUNDED --> [*]
  EXPIRED --> [*]
```

- Note the spec's `OFFER_ACCEPTED` stage is represented by the transaction
  being **created from** an accepted offer (`source_type='OFFER'`); a
  transaction only exists once agreement exists.
- Transitions are a declarative table: `(from, command) → to, allowedActors,
guards[]`. Guards are small pure functions (`paymentSettled`,
  `withinDisputeWindow`, …).
- **Payment is a port**: `PaymentProvider.initiate/confirm/refund/status`.
  `CashPaymentProvider` records intent and marks paid on buyer+seller
  confirmation at `COMPLETED`. Future bKash/Nagad/escrow adapters add
  `PAYMENT_PENDING`/`PAYMENT_HELD` guards without changing the machine's core.
- **Delivery is a port**: `DeliveryProvider.arrange/track/cancel`.
  `SelfArrangedDelivery` just records method and confirmations.
- Mode-specific sub-flows (Phase 2): RENT adds `HANDED_OVER → RETURNED`,
  BORROW adds `LENT → RETURNED` with lender return confirmation, HIRE adds
  `SERVICE_SCHEDULED → SERVICE_DONE`. They extend the table, not replace it.

## 5. Rental booking (Phase 2)

`HELD (15 min) → CONFIRMED → ACTIVE (handed over) → RETURNED → CLOSED`, with
`CANCELLED`, `OVERDUE`, `DAMAGE_CLAIMED`. Holds that lapse are released by a
job. Overlap prevention is the `EXCLUDE` constraint, so even a bug in the app
cannot double-book.

## 6. Loan (borrow, Phase 2)

`REQUESTED → APPROVED → LENT → RETURN_REPORTED (borrower) → RETURNED (lender
confirms)`, plus `DECLINED`, `CANCELLED`, `OVERDUE`, `DISPUTED`. No price;
optional deposit; eligibility gated by reputation signals and verification
policy (e.g. lender may require NID-verified borrowers).
