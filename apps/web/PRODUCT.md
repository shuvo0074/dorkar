# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + TypeScript (strict) + Vite, React Router, TanStack Query, React Hook Form + Zod. Fixed by the
engineering spec (docs/architecture/06-frontend.md). Built to be reusable by a future React Native app.

## Users

Everyday consumers across Bangladesh, mostly on mid-range Android phones and often on slow or metered
connections. They need to buy, rent, borrow, hire a service or source something, and would rather
describe the need once than search through thousands of listings. On the other side: individual
sellers, shops, service providers (electricians, tutors, photographers…) and suppliers who respond to
those needs. Urban, English-comfortable users must not feel alienated, but the broad consumer case
leads.

## Product Purpose

Dorkar (দরকার, "need") is a demand-first marketplace: a person posts a structured Need ("used iPhone
15 Pro, 256GB, Dhaka, up to ৳80,000"), relevant sellers and providers respond with offers, the
person compares, negotiates, accepts, completes the transaction (cash at launch) and leaves a review.
Success: a posted Need receives relevant offers quickly and ends in a completed transaction.

## Positioning

"Tell us what you need. Let the market come to you." Posting a Need is the primary action; browsing
listings is secondary. Buy, Rent, Borrow, Hire and Source are modes of the same Need, not separate
products.

## Operating Context

- Sign-in is Bangladeshi mobile number + SMS one-time code; no passwords.
- Payment is cash and delivery is arranged by the two parties at launch; phone numbers are never
  shown to other users by default.
- Prices in Taka (৳), stored in poisha; locations follow Bangladesh divisions/districts/areas.
- The web app covers the whole marketplace the backend serves: needs, offers, listings, deals,
  reviews, messages, rentals, lending, auctions, disputes, notifications and the staff desk. Anything
  the backend doesn't do yet (online payment, couriers, push on the web) is not shown at all, never
  faked.

## Capabilities and Constraints

- English is the default UI language with a Bangla toggle; both must be first-class (Bengali digits
  and ৳ formatting in Bangla).
- Mobile-first, performance budget: initial JS < 170 KB gzip, LCP < 2.5 s on a 4G mid-range phone.
- Server state only via TanStack Query; access token in memory, refresh token in an httpOnly cookie.
- The client never decides authorization; it renders what the API allows.

## Brand Commitments

Name: Dorkar (দরকার). No existing logo, colours or fonts; the visual identity is to be created and
recorded in DESIGN.md.

## Evidence on Hand

None. No customers, testimonials, statistics, partner logos or press exist. Do not fabricate
seller counts, ratings, reviews or "trusted by" claims.

## Product Principles

1. The Need comes first: every surface should make "post what you need" the obvious next step.
2. Trust is earned through verification and completed transactions, never through invented proof.
3. Built for the slow phone: fast, light, legible in sunlight, usable with one thumb.
4. Two languages, one product: Bangla is never an afterthought translation.
5. Privacy by default: contact details stay hidden until the user chooses otherwise.

## Accessibility & Inclusion

WCAG 2.2 AA. Large touch targets, keyboard-operable dialogs, focus management on route change,
`prefers-reduced-motion` respected, text that reflows at 200% zoom. Bengali script needs generous
line height and a font with full Bengali coverage.
