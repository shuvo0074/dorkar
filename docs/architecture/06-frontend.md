# 06 — Frontend Architecture

## 1. Principles

- **React + TypeScript (strict) + Vite + React Router (data routers) +
  TanStack Query.** React Hook Form + Zod resolvers for forms.
- State placement:
  - server state → TanStack Query (the only cache of API data)
  - URL state → search params (filters, tabs, cursors) — shareable & SEO-able
  - form state → React Hook Form
  - local UI state → `useState`
  - global client state → **only** the auth session (access token in memory +
    current account) via one small context. No Redux/Zustand until a real
    cross-cutting need appears.
- No business rules in JSX. Domain logic (e.g. "can this user counter this
  offer?") comes from the API as **capabilities** (`offer.actions: ["ACCEPT",
"COUNTER"]`) so the client never re-implements authorization; the server
  still enforces it.
- Memoization only after profiling shows a problem.
- Mobile-first, accessible (WCAG 2.2 AA): semantic HTML, labelled inputs,
  focus management on route change, keyboard-operable dialogs, `prefers-reduced-motion`.
- Bilingual (`bn`, `en`) via ICU messages; Bengali numerals and ৳ formatting
  through `Intl.NumberFormat('bn-BD', …)`.

## 2. Folder structure

```
apps/web/src/
  app/                    App root, providers (QueryClient, Router, Auth, I18n), error boundary
  routes/                 route modules (lazy), loaders that prefetch queries
    home.route.tsx        "Tell us what you need" + Post a Need CTA
    needs/
    listings/
    offers/
    transactions/
    account/
  features/
    auth/                 api.ts · queries.ts · components/ (PhoneForm, OtpForm) · lib/
    needs/                api.ts · queries.ts · schemas.ts · components/ (NeedWizard, NeedCard, NeedStatusBadge)
    listings/
    offers/               OfferCompare, CounterOfferDialog
    transactions/         TransactionTimeline
    matching/
    reviews/
    reports/
    notifications/
    bidding/ rentals/ borrowing/ hiring/ sourcing/   (Phase 2 / mode-specific form sections)
  components/
    ui/                   Button, Input, Select, Dialog, Sheet, Toast, Skeleton (headless + tokens)
    forms/                Field, MoneyInput, PhoneInput, LocationPicker, DateField, AttributeFields (schema-driven)
    layout/               AppShell, BottomNav (mobile), TopBar
  lib/
    http.ts               fetch wrapper: base URL, auth header, refresh-on-401 single-flight, error envelope → ApiError
    query-client.ts
    i18n.ts, money.ts, phone.ts (re-export from @dorkar/contracts)
  hooks/                  genuinely shared hooks only (useDebouncedValue, useMediaQuery)
  types/
```

Each feature exposes a public `index.ts`; features import each other only via
that surface. Feature `api.ts` files are thin typed clients generated from
OpenAPI (`openapi-typescript`), so the React Native app can reuse
`features/*/api.ts`, `queries.ts` and `schemas.ts` unchanged — only
components differ.

## 3. Key flows

- **Post a Need wizard** (primary CTA, on home): 1) what & mode, 2)
  category-specific attributes rendered from the category's JSON schema
  (`AttributeFields`), 3) budget/location/date, 4) review & publish. Draft
  autosaves to the server (not localStorage) once authenticated; anonymous
  users can fill the wizard and authenticate at publish (state held in RHF,
  then OTP modal).
- **Offer comparison**: table/cards sorted by total price, seller reputation,
  verification badges, delivery terms; accept/counter actions driven by
  `actions[]`.
- **Auth**: phone → OTP (auto-advance, `autocomplete="one-time-code"`,
  WebOTP API on Android Chrome) → profile setup if `isNewAccount`.

## 4. Performance

- Route-level `lazy()` + `Suspense`; vendor chunk split; preload on link hover/viewport.
- Feeds use `useInfiniteQuery` with cursor pagination and
  `@tanstack/react-virtual` for long lists.
- Images: `srcset` from media variants (WebP/AVIF), `loading="lazy"`,
  explicit dimensions to avoid CLS.
- Search inputs debounced (300 ms); query keys normalized to avoid duplicate fetches.
- Budgets (CI-enforced with Lighthouse CI on a 4G Moto G profile): LCP < 2.5 s,
  INP < 200 ms, CLS < 0.1, initial JS < 170 KB gzip.
- SEO: the gateway prerenders public pages (home, the needs, listings, auctions
  and lending feeds, each need, listing, auction and lend item, and business
  profiles). It reads the public API anonymously and fills the built
  `index.html` with the page's title, description, canonical URL, Open Graph
  tags and JSON-LD (`Demand` for needs, `Product` for listings), plus a plain
  HTML snapshot inside `#root` that the app replaces when it mounts. Everyone
  gets the same HTML (no user-agent sniffing), so WhatsApp and Facebook link
  previews work too. Closed needs, unpublished listings and private people's
  profiles are `noindex`; any other path gets the plain shell with `noindex`.
  It also serves `robots.txt` and `sitemap.xml`. Renders are cached for a
  minute; if a service fails, the plain shell is served. Code:
  `services/gateway/src/application/pages.ts`. Migrate to SSR (React Router
  framework mode) if organic search becomes a key channel.

## 5. Testing

- Vitest + Testing Library for components/hooks; MSW for API mocking.
- Playwright E2E against the docker-compose stack (see 07-operations §3).
- axe checks in component tests and E2E.

## 6. As built (web)

- `features/<area>/api.ts` are hand-written typed clients over `lib/http.ts` (one per service
  area); they mirror the services' Zod route schemas. Commands the API marks **(idem)** carry an
  `Idempotency-Key` from `useIntent()`, one key per user intent, renewed after success.
- Buttons for needs, offers, deals, bookings, loans, auctions and disputes come from each DTO's
  `actions` where the API provides one; needs and listings, which have none, use the owner
  transition tables in their `api.ts`.
- `routes/` holds one lazy module per page (`routes/desk/` for staff tools); staff pages gate on
  permissions from `@dorkar/contracts/authz` and the server authorizes again.
- Strings live in `lib/messages/<area>.ts` (English) with a twin in `lib/messages/bn/` typed key
  for key. The Bangla tables are a separate chunk loaded on first use; a test fails if two areas
  define the same key.
- The first load stays inside the budget by importing only dependency-free contract subpaths
  (`@dorkar/contracts/authz`, `@dorkar/contracts/places`) from code on the home page; zod and the
  event schemas load with the pages that validate.
- Live data: the inbox count refreshes every minute, live auctions every ten seconds, and a
  conversation long-polls (`after` + `wait=8`) with a back-off when the server answers at once.
