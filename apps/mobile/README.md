# Dorkar phone apps

React Native CLI app for iOS and Android. It covers everything a buyer or seller does on the web
(needs, offers, deals, listings, rentals, lending, auctions, messages, disputes, reviews,
notifications) in English and Bangla. Staff tools stay on the website.

## Run it

The backend must be running (`pnpm dev:backend` at the repo root, API on port 4000; see
[RUNNING.md](../../RUNNING.md)).

```bash
npm install
(cd ios && pod install)
npm start          # Metro, in its own terminal
npm run ios        # or: npm run android
```

Sign in with any Bangladeshi number and read the code from `var/dev-sms.log`. The Android emulator
reaches the backend at `10.0.2.2`. For a physical phone, change `DEV_API_HOST` in `src/config.ts` to
this computer's LAN address. Set `RELEASE_API_URL` there before a release build.

## How it fits together

- **Shared with the web, imported directly:** API clients (`@web/features/*/api`), message tables,
  formatting and contracts. Metro resolves `@web/*` to `apps/web/src/*` and swaps the browser-only
  modules (`lib/http`, `lib/i18n`, `features/auth/session`, `features/media/api`) for the native
  twins in `src/`. See `metro.config.js`.
- **Design:** `src/design/` holds all that differs between designs: tokens, wordmark, headers, tab bar,
  mode tiles, home page and backdrop. Screens and `src/ui/` read only `src/design/tokens.ts`.
- **Words:** the web's message keys, plus `src/lib/nativeMessages.ts` for words only the app needs.
- **Session:** the refresh token lives in the keychain, the access token in memory
  (`src/lib/http.ts`).

## Checks

```bash
npm run typecheck
npm test
```

`scripts/gen-icons.mjs` regenerates `src/ui/icons.tsx` from the web's icon set.
`scripts/set-identity.py <slug> <name> <ground>` sets the bundle id, display name, link scheme and
launch screen colour; `scripts/make-icons.py` draws the app icons (needs Pillow).

`e2e/run.sh <app id> <scheme>` drives the whole loop with [Maestro](https://maestro.dev): browse, sign
in, post a need, receive an offer, accept it, see the deal. `e2e/details.sh <app id> <scheme>` builds a
scenario through the API (a deal, an offer, a chat, a dispute, a booking, a rental, a loan, an
auction) and checks each detail page and its main action. From a worktree, set `DORKAR_ROOT` to a
checkout with `node_modules` and `SMS_LOG` to its `var/dev-sms.log`.
