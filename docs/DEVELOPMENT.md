# Orbitor — Development & Release Workflow

> How to develop, test, and ship Orbitor safely. The golden rule: **never develop or test against
> production data.** Changes flow **local → staging → production**, and production is only touched
> by an explicit merge to `main`.
>
> Hosting/architecture reference: [`orbitor-licensing-and-ai/ARCHITECTURE.md`](./orbitor-licensing-and-ai/ARCHITECTURE.md).

## The three environments

| Tier | Where | Database | Purpose |
|---|---|---|---|
| **Local** | your machine (`yarn start`) | **local** Postgres/Redis | daily dev — fast, isolated, zero risk |
| **Staging** | Railway `staging` env + Cloudflare Pages preview | **its own** Postgres/Redis/R2 | prod-like verification before release |
| **Production** | Railway `production` + Cloudflare Pages | live customer data | only updated by merge to `main` |

⚠️ **Why never point local/staging at the prod DB:** Twenty runs DB migrations and per-workspace
DDL on boot and on workspace creation. Running those against production can corrupt or lock real
customer schemas. Each tier gets its **own** database.

---

## 1. Local dev loop

One-time / idempotent setup (starts Postgres + Redis, creates `default`+`test` DBs, copies `.env`,
runs migrations on a fresh DB):
```bash
bash packages/twenty-utils/setup-dev-env.sh
#   --down    stop services
#   --reset   wipe data + restart fresh
#   --docker  force Docker mode
```

> ⚠️ **Gotcha:** the setup script's `reset:env` step **overwrites `packages/*/.env` with
> `.env.example` every run**. Add local-only customizations *after* running it (or they'll be
> wiped on the next run).

For **AI testing locally**, set a Gemini key in `packages/twenty-server/.env` (after running the
setup script):
```
GOOGLE_API_KEY=<your-gemini-key>
```
(It ships commented out. This is the local equivalent of the prod Railway env var — the native
`@ai-sdk/google` catalog path that makes the chat work.)

Run everything:
```bash
yarn start         # frontend :3001 + server :3000 + worker
# or individually:
npx nx start twenty-front     # http://localhost:3001
npx nx start twenty-server    # http://localhost:3000
npx nx run twenty-server:worker
```

**Smoke test** (same paths that run in prod):
- Sign in via **"Continue with Email"** (prefilled dev credentials).
- Create/edit a record (basic CRUD).
- Open the AI chat and confirm it streams a reply.

---

## 2. Pre-merge test gate (must be green before promoting)

```bash
# Types
npx nx typecheck twenty-server
npx nx typecheck twenty-front

# Lint (diff vs main is fastest; add --configuration=fix to auto-fix)
npx nx lint:diff-with-main twenty-server
npx nx lint:diff-with-main twenty-front

# Unit tests (whole package)
npx nx test twenty-server
npx nx test twenty-front
# …or a single file (fast):
cd packages/twenty-server && npx jest <pattern>

# Integration tests — only when touching DB / resolvers / migrations
npx nx run twenty-server:test:integration:with-db-reset
```
If you changed an `*.entity.ts`, generate an instance command
(`npx nx run twenty-server:database:migrate:generate --name <name> --type <fast|slow>`) — see
`packages/twenty-server/docs/UPGRADE_COMMANDS.md`.

---

## 3. Staging environment (Railway) — one-time setup

Goal: a deployed environment that mirrors prod but has its **own** data.

1. **Railway → project `confident-luck` → Environments → New environment** named `staging`.
2. Add its **own** `Postgres` and `Redis` services to the `staging` environment (do **not** share
   production's).
3. Set the `staging` service variables (mirror prod, but isolated):
   - `PG_DATABASE_URL=${{Postgres.DATABASE_URL}}` and `REDIS_URL=${{Redis.REDIS_URL}}`
     (these reference **staging's** Postgres/Redis).
   - `APP_SECRET` = a **fresh** random string (`openssl rand -base64 32`) — not prod's.
   - `SERVER_URL` / `FRONTEND_URL` = the staging URLs.
   - `STORAGE_TYPE=s3` + a **separate** R2 bucket (e.g. `orbitor-files-staging`) and its creds.
   - `GOOGLE_API_KEY` (may reuse the prod key), and for license testing
     `ORBITOR_LICENSE_PUBLIC_KEY` / `ENTERPRISE_KEY` / `ENTERPRISE_VALIDITY_TOKEN`, plus
     `ENTERPRISE_API_URL=""` (no phone-home).
   - **worker** service also gets `DISABLE_DB_MIGRATIONS=true` +
     `DISABLE_CRON_JOBS_REGISTRATION=true` (only the server runs those).
4. Point the `staging` environment's services at a **`staging` git branch** (Railway lets each
   environment track its own branch). The existing root `railway.json` (Dockerfile builder) is
   reused automatically.

> Secrets (`APP_SECRET`, `GOOGLE_API_KEY`, R2 creds, license tokens) must be entered by a human in
> the dashboard — they are never committed.

## 4. Staging frontend (Cloudflare Pages preview)

Cloudflare Pages serves **preview deployments** for non-production branches automatically.
- In the Pages project, set the **Preview** value of `REACT_APP_SERVER_BASE_URL` to the **staging
  backend URL** (Pages supports separate Preview vs Production env vars; it's read by
  `packages/twenty-front/scripts/inject-runtime-env.sh` at build time).
- Pushing the `staging` branch produces a preview URL pointing at the staging backend. (Free.)

---

## 5. Release / promotion workflow (the standard)

```
main ──▶ feat/your-change                 1. branch from main
          │  local dev + test gate (§1,§2) 2. verify locally (local DB)
          ▼
        staging branch ──▶ Railway staging + CF preview   3. push → staging deploy
          │  verify on staging (§ prod-only checks)        4. prod-like verification
          ▼
        main ──▶ production                5. merge → prod auto-deploy → smoke test
```

**Step 4 — verify on staging** the things that *only* exist outside local: env-var wiring,
license activation (GraphQL `workspace.hasValidEnterpriseValidityToken` → `true`), R2 file uploads,
cross-origin (Pages↔Railway), and SSE streaming.

**Never push straight to `main` to "see if it works."** `main` = production.

---

## 6. Currently pending: the `bugfixapi` branch

The self-generated license + AI hardening is committed on `bugfixapi` (not deployed). Ship it
through this flow: local gate (§1–§2) → push to `staging` → verify on staging → merge to `main`.
The license requires the env vars from §3 to be set before its features activate.

---

## Quick reference — who does what

| Task | Who |
|---|---|
| Run local dev + the test gate | anyone (agent or you) |
| Write/update code + docs | agent or you |
| Mint license keypair/tokens | agent (hands you the values) |
| Create Railway `staging` env + Postgres/Redis | **you** (dashboard) |
| Set secrets (APP_SECRET, GOOGLE_API_KEY, R2, license) | **you** (dashboard) |
| Create R2 staging bucket + CF Pages preview var | **you** (dashboard) |
| Merge to `main` (deploy to prod) | **you approve** |
