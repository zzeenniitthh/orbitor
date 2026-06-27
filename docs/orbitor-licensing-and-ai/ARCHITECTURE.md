# Orbitor — Architecture & Deployment

> Read this first if you're an agent or developer new to this repo. It explains what
> Orbitor is, how it's hosted, how it builds/deploys, and what differs from upstream Twenty.
> For the click-by-click hosting runbook, see [`DEPLOY.md`](../../DEPLOY.md).

## 1. What Orbitor is
Orbitor is a fork of **Twenty CRM** (an Nx + Yarn 4 monorepo). It is run as a hosted product
on a **2-vendor stack**: **Railway** (backend + databases) and **Cloudflare** (frontend + file
storage). The app code is stock Twenty plus a small, documented set of additive changes
(see §8).

## 2. Hosting architecture (2 vendors)

```
                     ┌─────────────────────── Cloudflare ───────────────────────┐
   user's browser ──►│  Pages  (frontend SPA, static)                            │
                     │     │  REACT_APP_SERVER_BASE_URL ─────────────┐           │
                     │     ▼                                          │           │
                     │  R2  (orbitor-files bucket, S3-compatible)  ◄──┼── files   │
                     └────────────────────────────────────────────────┼──────────┘
                                                                        │ HTTPS (API)
                     ┌─────────────────────── Railway ─────────────────▼──────────┐
                     │  server  (NestJS API, node dist/main, port 3000)            │
                     │  worker  (BullMQ background jobs, yarn worker:prod)          │
                     │  Postgres   ◄──── both connect via private network ────►     │
                     │  Redis                                                       │
                     └─────────────────────────────────────────────────────────────┘
```

- **Frontend** → Cloudflare Pages (static build of `twenty-front`).
- **File storage** → Cloudflare R2 (S3-compatible; Twenty uses `STORAGE_TYPE=s3`).
- **API server + worker + Postgres + Redis** → Railway (the backend cannot be serverless —
  Twenty needs a long-running server and an always-on worker).

**Production coordinates (current):**
- Railway project: **`confident-luck`** (services: `orbitor` = server, `worker`, `Postgres`, `Redis`)
- Backend URL: `https://orbitor-production.up.railway.app`
- Frontend: Cloudflare Pages **`orbitorsh.pages.dev`**
- R2 bucket: **`orbitor-files`**, Cloudflare account `5aec49dc270dd7fd739f1e8e72f0030d`
  → S3 endpoint `https://5aec49dc270dd7fd739f1e8e72f0030d.r2.cloudflarestorage.com`
- GitHub: `github.com/zzeenniitthh/orbitor`, deploys from **`main`**.
- **Status: live ✓** — all four Railway services are deployed, **co-located in one region**, and
  healthy (`/healthz` → 200). Frontend is live on Pages; sign-in and workspace creation work.

## 3. Operational rules — current setup is correct; keep it this way
1. **All four Railway services stay in the same region (configured ✓).** Workspace creation runs
   ~840 sequential DB queries; co-located (same region + private network) each is ~1ms and setup
   finishes in seconds. ⚠️ Do **not** move a service to a different region — cross-region jumps to
   ~140ms/query, so setup takes minutes and the browser times out. (This was the original
   "Workspace creation failed" issue; it's resolved now that they're co-located.)
2. **Cloudflare Pages "Build output directory" must be `packages/twenty-front/build`.** If left
   blank it uploads the whole repo (incl. `node_modules`, 400k+ files) and fails the
   20,000-file limit.
3. **`SERVER_URL` and `FRONTEND_URL` must be valid URLs** (`https://…`, no quotes/trailing
   slash). Twenty validates them on boot; an invalid value crash-loops the server.
4. **The worker must set `DISABLE_DB_MIGRATIONS=true` and `DISABLE_CRON_JOBS_REGISTRATION=true`.**
   Only the `server` runs migrations + cron; the worker just processes jobs.
5. **Auth is bearer-token (not cookies)**, so the cross-origin Pages→Railway setup needs no
   special CORS config (Twenty's CORS is permissive). `FRONTEND_URL` is still used for
   generated links (invites, password resets) and must point at the real Pages URL.

## 4. Repo structure — what's actually used in production
Only **7 packages** are built into the deploy; the rest are upstream Twenty extras that are
**not** part of the hosted product (the Docker image only builds what it needs).

**Used in production:**
| Package | Role |
|---|---|
| `twenty-server` | NestJS API **and** BullMQ worker (same codebase, different start command) |
| `twenty-front` | React SPA (the website) |
| `twenty-shared` | Shared types/utils/constants (backend + frontend) |
| `twenty-emails` | Email templates/rendering (backend) |
| `twenty-ui` | Design-system component library (frontend) |
| `twenty-client-sdk` | Generated GraphQL client (backend + frontend) |
| `twenty-front-component-renderer` | Renders custom front-components (frontend) |

**Not used by the hosted product** (present from upstream; safe to ignore — kept so upstream
merges stay clean): `twenty-website`, `twenty-website-redone`, `twenty-docs`, `twenty-zapier`,
`twenty-companion`/`twenty-desktop`, `twenty-e2e-testing`, `twenty-sdk`, `create-twenty-app`,
`twenty-cli` (deprecated), `twenty-utils`, `twenty-oxlint-rules`, `twenty-codex-plugin`,
`twenty-claude-skills`.

## 5. Build & deploy flow

### Backend (Railway)
- `railway.json` (repo root) pins `builder: DOCKERFILE`,
  `dockerfilePath: packages/twenty-docker/server/Dockerfile`. (Without this, Railway's
  auto-builder tries to pack the whole monorepo and gets killed.)
- `packages/twenty-docker/server/Dockerfile` is a **server-only** image: stages
  `server-deps → twenty-server-build → twenty-server` (final). The frontend build is
  intentionally omitted (it's served by Cloudflare). It mirrors the `twenty-server` stage of
  the shared `packages/twenty-docker/twenty/Dockerfile` because Railway can't select a build
  target and would otherwise build the file's last stage (the dev all-in-one image).
- `ENTRYPOINT` = `packages/twenty-docker/twenty/entrypoint.sh`: on first boot it detects the
  empty DB (`core` schema missing) and runs `yarn database:init:prod`, then `cache:flush` +
  `upgrade` + cron registration, then execs the `CMD`.
- **server service:** default `CMD ["node", "dist/main"]` (API, port 3000).
- **worker service:** same image, start command overridden to `yarn worker:prod`
  (`node dist/queue-worker/queue-worker`), plus the two `DISABLE_*` env vars.

### Frontend (Cloudflare Pages)
- Build command:
  ```
  NODE_OPTIONS=--max-old-space-size=8192 npx nx build twenty-front && cd packages/twenty-front && ./scripts/inject-runtime-env.sh
  ```
- Output directory: `packages/twenty-front/build`.
- `packages/twenty-front/scripts/inject-runtime-env.sh` writes
  `window._env_ = { REACT_APP_SERVER_BASE_URL: "<railway url>" }` into `build/index.html`
  (it reads the `REACT_APP_SERVER_BASE_URL` build env var; **fails the build if unset**).
- At runtime `packages/twenty-front/src/config/index.ts` reads
  `window._env_?.REACT_APP_SERVER_BASE_URL` to find the backend. SPA routing is handled by
  `packages/twenty-front/public/_redirects` (`/* /index.html 200`).

## 6. Environment variables
**Backend** (Railway → set on the `server`, and most also on the `worker`). Template:
`packages/twenty-docker/server/.env.railway.example`.

| Var | Value / source |
|---|---|
| `PG_DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference) |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` (Railway reference) |
| `APP_SECRET` | `openssl rand -base64 32` (signs tokens + at-rest encryption) |
| `NODE_PORT` | `3000` |
| `SERVER_URL` | the server's own public URL |
| `FRONTEND_URL` | the Cloudflare Pages URL |
| `STORAGE_TYPE` | `s3` |
| `STORAGE_S3_NAME` | `orbitor-files` |
| `STORAGE_S3_ENDPOINT` | `https://<cf-account>.r2.cloudflarestorage.com` |
| `STORAGE_S3_REGION` | `auto` |
| `STORAGE_S3_ACCESS_KEY_ID` / `STORAGE_S3_SECRET_ACCESS_KEY` | from a Cloudflare R2 API token |
| `IS_WORKSPACE_DEMO_DATA_ENABLED` | `false` (clean new workspaces) |
| `DISABLE_DB_MIGRATIONS` / `DISABLE_CRON_JOBS_REGISTRATION` | `true` — **worker only** |

**Frontend** (Cloudflare Pages): `REACT_APP_SERVER_BASE_URL` = the Railway server URL.

**Secrets live in the Railway/Cloudflare dashboards, never in the repo.** The committed
`.env.railway.example` holds placeholders only; the local `packages/twenty-server/.env` is
gitignored and points at local Postgres/storage for development.

## 7. Shipping a change
> Full local-dev / staging / release runbook: [`DEVELOPMENT.md`](../DEVELOPMENT.md).

**Environments: `main` is production — never test on it.** Changes flow
**local (local DB) → staging (separate Railway env + Cloudflare Pages preview) → production**:
- **Local:** `yarn start` against local Postgres/Redis; run the test gate (typecheck + lint +
  tests) before promoting.
- **Staging:** push the `staging` branch → a separate Railway `staging` environment (its own
  Postgres/Redis/R2) + a CF Pages preview deploy verify prod-only behavior (env wiring, license
  activation, R2, SSE) with throwaway data.
- **Production:** merging to `main` → Railway (server + worker) and Cloudflare Pages auto-build and
  deploy. Changing a Railway env var triggers a **fast redeploy** (reuses the built image, no
  rebuild); code changes trigger a full build.

## 8. What diverges from upstream Twenty (keep this list current)
**Added deploy files:** `railway.json`, `packages/twenty-docker/server/Dockerfile`,
`packages/twenty-docker/server/.env.railway.example`, `packages/twenty-front/public/_redirects`,
`DEPLOY.md`, this `ARCHITECTURE.md`.

**Added application code (all additive + backward-compatible — they help any Postgres, not just
one provider):**
- `packages/twenty-server/src/database/scripts/setup-db.ts` — provisions
  `public.uuid_generate_v4()` and `unaccent` in `public` (managed Postgres can install
  extensions in a non-public schema; per-workspace DDL needs them in `public`).
- `packages/twenty-server/src/database/typeorm/core/core.datasource.ts` — core pool honors
  `PG_POOL_MAX_CONNECTIONS` (default 10).
- `packages/twenty-server/src/engine/core-modules/twenty-config/config-variables.ts` +
  `.../workspace/services/workspace.service.ts` — `IS_WORKSPACE_DEMO_DATA_ENABLED` flag that
  gates demo-data prefill on workspace creation.

## 9. Feature gating, licensing & AI configuration
> Detail + the unlock plan: [`README.md`](./README.md), [`RESEARCH.md`](./RESEARCH.md), [`PLAN.md`](./PLAN.md) (this folder).

**Billing is OFF on this fork (`IS_BILLING_ENABLED=false`, Twenty's default), and that already
unlocks most "paid" gates** — when billing is off Twenty's gates *grant* access:
- `billing.service.ts:48-52` `hasEntitlement()` → `true` → **SSO + Custom Domain unlocked**.
- `billing-usage.service.ts:311-314` `hasAvailableCredits()` → `true` → **AI is never blocked by
  credits/subscription**.

**Still gated** (do not assume these work just because billing is off):
- **RLS, Audit Logs, >5 workspaces, JWT signing-key rotation** — gated by
  `enterprisePlanService.isValid()` (`enterprise/services/enterprise-plan.service.ts`), a real
  RS256 **validity-token** check. In production it only trusts twenty.com's embedded public key
  (`enterprise-public-key.constant.ts`), so these stay locked until we install our own
  self-signed token (see the plan folder). The `@license Enterprise` header on ~239 files is
  documentary only — no build/runtime enforcement.
- **Feature-flag management** — `client-config.service.ts:219-222`:
  `canManageFeatureFlags = NODE_ENV===development || IS_BILLING_ENABLED` (so off in prod).

**AI agent chat.** Provider keys are **instance-wide** in the `AI_PROVIDERS` config (Admin Panel
`addAiProvider`, `admin-panel.resolver.ts:511-528`), merged with a committed catalog
(`ai-models/ai-providers.json`, which already includes Google/Gemini as `"google"`). A model is
only usable once registered (`ai-model-registry.service.ts:91-135`: needs `npm` + `models` +
`isProviderConfigured`) **and** allowed for the workspace (`smartModel`/`fastModel`). Simplest way
to enable a provider: set its key config var (e.g. `GOOGLE_API_KEY`) so the catalog template
resolves. Note: AI errors are currently mis-mapped to HTTP 500
(`ai-graphql-api-exception-handler.util.ts:37-40`), which presents as a silent "nothing happens".

## 10. Local development
```
bash packages/twenty-utils/setup-dev-env.sh   # starts Postgres + Redis, copies .env, inits DB
yarn start                                     # front + server + worker
```
The local `packages/twenty-server/.env` uses **local Postgres + local disk storage** for speed.
Read-only DB inspection is available via the Postgres MCP in `.mcp.json` (it sources whatever
`PG_DATABASE_URL` is in that `.env`).
