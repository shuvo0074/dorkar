# Running Dorkar locally

Requires Node ≥ 24, pnpm 10, Postgres ≥ 14 and Redis ≥ 7 running locally. Run everything from the repository root.

## 1. Install dependencies

```bash
pnpm install
```

## 2. Database setup and migrations

Once (safe to re-run): creates `.env.dev`, the database, per-service schemas and runs migrations.

```bash
pnpm dev:setup
```

## 3. Start the backend

Gateway and all services; API at http://localhost:4000

```bash
pnpm dev:backend
```

## 4. Start the frontend

In a second terminal:

```bash
pnpm --filter @dorkar/web dev
```

- Web app: http://localhost:5173
- Your dashboard: http://localhost:5173/dashboard
- Admin dashboard: http://localhost:5173/desk (needs an admin role, see below)

## 5. Get the sign-in OTP

Sign in with any phone number, then read the code here:

```bash
tail -f var/dev-sms.log
```

## Optional

### Seed demo data

80 published listings with real photos from 8 demo sellers (57 products, 10 rentals, 13 services), and 19 open needs from 5 demo buyers that fill the homepage feed. Needs the backend running; works offline. Safe to re-run. Data and photos are in `scripts/seed-demo/`. Demo sellers sign in with `01799000001` to `01799000008`, demo buyers with `01899000001` to `01899000005`.

```bash
pnpm seed:demo
```

### Make yourself an admin

With the `.env.dev` values loaded in your shell:

```bash
pnpm --filter @dorkar/identity-service grant-role 017XXXXXXXX SUPER_ADMIN
```

### Backend end-to-end tests

```bash
pnpm e2e:backend
```

```bash
pnpm e2e:phase2
```

### Browser end-to-end tests

```bash
cd apps/web && E2E_SMS_LOG=../../var/dev-sms.log pnpm e2e
```

### Lint and typecheck

```bash
pnpm lint && pnpm typecheck
```

### Unit and integration tests

```bash
pnpm test
```

### Build

```bash
pnpm build
```

### Design style lab

Interactive mobile and web mock-ups of the candidate visual styles (Pocket Wallet, Circle Catalog, Aurora Glass, Bento Motion): https://claude.ai/artifact/4mBseFYgmcGCzh97nDewPr (private until shared from its Share menu).

More detail, including Docker: [README.md](README.md).
