# Deploy Orbitor — simple step-by-step (Railway + Cloudflare)

This guide is written to be followed click-by-click. You need **two accounts**:

- **Railway** (railway.app) — runs the backend: the server, the worker, the database (Postgres), and Redis.
- **Cloudflare** (dash.cloudflare.com) — runs the frontend (Pages) and stores uploaded files (R2).

```
   Cloudflare Pages  ─────►  Railway server ──►  Railway Postgres + Redis
   (the website)              (the backend)
        files ▲                     │
   Cloudflare R2  ◄─────────────────┘
   (uploaded files)
```

**Do the parts in this order** (each part needs a value from the part before):
**1) Cloudflare R2 → 2) Railway → 3) Cloudflare Pages → 4) connect the two URLs → 5) sign in.**

Everything in code is already done and pushed to GitHub (`zzeenniitthh/orbitor`, branch
`main`). You only click in dashboards and copy values.

> 💡 Keep a scratch note open. You'll collect **6 values** as you go:
> `APP_SECRET`, `R2 Access Key ID`, `R2 Secret Access Key`, `Railway server URL`,
> `Cloudflare Pages URL`. (The R2 endpoint is already filled in for you.)

> First, generate one secret now. Open a terminal and run:
> ```
> openssl rand -base64 32
> ```
> Copy the output — that's your **`APP_SECRET`**. Save it in your scratch note.

---

## Part 1 — Cloudflare R2 (file storage) → gives you 2 keys

1. Go to **dash.cloudflare.com** → left sidebar **R2**.
2. If it's your first time, it asks you to **enable R2** (you must add a card; the
   free tier is genuinely free — 10 GB). Click through to enable.
3. Click **Create bucket**. Name it exactly:
   ```
   orbitor-files
   ```
   Location: leave **Automatic** (or pick EU). Click **Create bucket**.
4. Now make the access keys. Top-right of the R2 page click **{ } API** →
   **Manage API Tokens** → **Create API Token** (or "Create Account API token").
   - **Permissions:** choose **Object Read & Write**.
   - (Optional) scope it to the `orbitor-files` bucket.
   - Click **Create**.
5. Cloudflare shows the keys **once**. Copy these two into your scratch note:
   - **Access Key ID** → this is `STORAGE_S3_ACCESS_KEY_ID`
   - **Secret Access Key** → this is `STORAGE_S3_SECRET_ACCESS_KEY`

That's all from Cloudflare for now. (Your S3 endpoint is already known — see the block in Part 2.)

---

## Part 2 — Railway (backend: server + worker + Postgres + Redis)

### 2a. Create the project from GitHub
1. Go to **railway.app** → **New Project** → **Deploy from GitHub repo**.
2. Pick the repo **`zzeenniitthh/orbitor`**. (If you don't see it, click
   "Configure GitHub App" and give Railway access to that repo.)
3. Railway creates one service. Open it. We'll configure it as the **server**.

### 2b. Point the server at the right branch
In the service → **Settings**:
- **Source / Branch:** `main` (the default — everything is on main).
- ⚠️ **Root Directory: LEAVE IT EMPTY (the repo root).** Do **not** set it to
  `packages/twenty-server` — our Docker build needs the whole repo as its context,
  and the included `railway.json` already tells Railway to build from
  `packages/twenty-docker/server/Dockerfile`. (If Railway ever suggests "set a root
  directory to reduce build scope," ignore it — that advice is for non-Docker builds.)
- The **builder is already forced to Dockerfile** by `railway.json` in the repo, so
  you do NOT need to set Builder / Dockerfile Path by hand. (If you want to verify:
  Settings → Build should show Dockerfile, path `packages/twenty-docker/server/Dockerfile`.)
- (Optional, recommended) **Deploy → Healthcheck Path:** `/healthz`
- **Region:** pick **EU West (Amsterdam)** if offered (closest to Israel; keep all
  services + databases in the same region).
- Rename the service to **`server`** (top of the page) so it's easy to tell apart.

> 💥 **If your first deploy already failed** with a message about Railpack / "3.3 GiB
> of dependencies" / "killed during image assembly": that's Railway ignoring the
> Dockerfile. After this `railway.json` is in the repo, open the service →
> **Deployments → Redeploy** (or push triggers it). Make sure Root Directory is empty.

### 2c. Add Postgres and Redis (one click each)
In the project canvas (the board view):
1. Click **Create** (or **+ New**) → **Database** → **Add PostgreSQL**.
2. Click **Create** → **Database** → **Add Redis**.

You don't copy anything from these — Railway wires them in automatically via the
`${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}` references in the variables below.

> 🚨 **CRITICAL — all four services MUST be in the SAME region.** Workspace creation
> runs ~840 sequential database queries. Co-located (same region, private network) each
> query is ~1ms and setup finishes in seconds. If the server and Postgres are in
> **different** regions, each query is ~140ms → setup takes ~3 minutes and the browser
> times out with **"Workspace creation failed."**
>
> Railway often defaults new databases to a different region than your service. After
> adding them, check **each** service → **Settings → Region** and set **Postgres, Redis,
> the server, and the worker all to the same region** (e.g. EU West / Amsterdam).
> Changing a database's region re-provisions it (wipes data) — fine before you have real
> users. The server re-initializes the empty database automatically on its next boot.

### 2d. Set the server's variables
Open the **server** service → **Variables** tab → click **Raw Editor** →
paste this whole block, then replace the 4 `<<PASTE …>>` placeholders:

```
PG_DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
APP_SECRET=<<PASTE your openssl secret>>
NODE_PORT=3000
SERVER_URL=https://orbitor-production.up.railway.app
FRONTEND_URL=https://orbitor.pages.dev
STORAGE_TYPE=s3
STORAGE_S3_NAME=orbitor-files
STORAGE_S3_ENDPOINT=https://5aec49dc270dd7fd739f1e8e72f0030d.r2.cloudflarestorage.com
STORAGE_S3_REGION=auto
STORAGE_S3_ACCESS_KEY_ID=<<PASTE R2 Access Key ID>>
STORAGE_S3_SECRET_ACCESS_KEY=<<PASTE R2 Secret Access Key>>
IS_WORKSPACE_DEMO_DATA_ENABLED=false
```

**Where each value comes from.** Most lines are already correct — you only fill **5**:

| Line(s) | What to do |
|---|---|
| `PG_DATABASE_URL`, `REDIS_URL` | **Leave EXACTLY as written** (`${{Postgres.DATABASE_URL}}` / `${{Redis.REDIS_URL}}`). Railway auto-fills them from the Postgres + Redis you added in 2c. Do not change them. |
| `STORAGE_S3_ENDPOINT` | Already filled in for your account — leave it. |
| `NODE_PORT`, `STORAGE_TYPE`, `STORAGE_S3_NAME`, `STORAGE_S3_REGION`, `IS_WORKSPACE_DEMO_DATA_ENABLED` | Already correct — leave them. |

Now the **5 values you fill**:

**① `APP_SECRET`** — a random secret you make once.
- Open the **Terminal** app (press `⌘ + Space`, type `Terminal`, hit Enter).
- Paste this and press Enter:
  ```
  openssl rand -base64 32
  ```
- Copy the line it prints (looks like `k8Jx2...=`) → paste it as the `APP_SECRET` value.

**② `STORAGE_S3_ACCESS_KEY_ID`** and **③ `STORAGE_S3_SECRET_ACCESS_KEY`** — from Cloudflare R2.
- Go to **dash.cloudflare.com** → **R2** in the left sidebar.
- (If you haven't made the bucket yet: **Create bucket**, name it `orbitor-files`.)
- Top-right of the R2 page: click **`{ }` API** → **Manage API Tokens** → **Create API Token**.
- Set **Permissions = Object Read & Write** → **Create API Token**.
- Cloudflare now shows them **once** (you can't see the secret again later — copy now):
  - **Access Key ID** → paste as `STORAGE_S3_ACCESS_KEY_ID`
  - **Secret Access Key** → paste as `STORAGE_S3_SECRET_ACCESS_KEY`

**④ `SERVER_URL`** — the backend's own address.
- This is the domain from **step 2f** (Generate Domain): `https://orbitor-production.up.railway.app`.
- ⚠️ It **must be a real, valid URL** — do NOT leave a fake `PLACEHOLDER` value. Twenty
  refuses to boot (and crash-loops) if `SERVER_URL` isn't a valid web address.

**⑤ `FRONTEND_URL`** — the website's address (Cloudflare Pages). **You don't have it yet,**
but Twenty still needs a **valid** URL here to start.
- Set it to `https://orbitor.pages.dev` for now — a valid temporary value (and likely the
  real one, since you'll name the Pages project `orbitor`). You'll confirm/adjust it in
  **Part 4** once Pages is live.
- ⚠️ Same rule: it must be a valid URL, never a `PLACEHOLDER` string, or the server crashes.

Click **Save** / **Deploy Changes**. The service redeploys and should boot cleanly.

### 2e. Add the worker service (same repo, one extra setting)
The worker runs background jobs. It's the same image with a different start command.
1. Project canvas → **Create / + New** → **GitHub Repo** → pick `zzeenniitthh/orbitor` again.
2. Open the new service → **Settings**:
   - Branch: `main`
   - **Root Directory: LEAVE IT EMPTY** (same reason as the server — `railway.json`
     already forces the Dockerfile build).
   - **Deploy → Custom Start Command:**
     ```
     yarn worker:prod
     ```
   - Region: same as the server (EU West).
   - Rename the service to **`worker`**.
3. Open the **worker** → **Variables** → **Raw Editor** → paste the **same block as 2d**,
   then add these **two extra lines** at the end:
   ```
   DISABLE_DB_MIGRATIONS=true
   DISABLE_CRON_JOBS_REGISTRATION=true
   ```
   (The worker must NOT run migrations/cron — only the server does.) Click **Save**.

### 2f. Give the server a public URL
1. Open the **server** service → **Settings → Networking** → **Generate Domain**.
2. When asked for the port, enter **3000**.
3. Copy the URL it gives you (looks like `https://server-production-xxxx.up.railway.app`).
   - Save it as your **Railway server URL**.
   - Go back to **server → Variables** and set `SERVER_URL` to this exact URL. Save.

### 2g. Let it build
Railway now builds and deploys both services. The **first** server boot also sets up
the database — **this takes several minutes**, that's normal. Watch **server → Deployments
→ logs** until you see it become healthy (the `/healthz` check goes green). The image
build itself can take ~10–15 min the first time.

---

## Part 3 — Cloudflare Pages (the website)

> ⚠️ **Use the *Pages* flow, not Workers.** In Workers & Pages → Create there are two
> tabs: **Workers** and **Pages**. The **Workers** tab shows a "Deploy command:
> `npx wrangler deploy`" — that's the WRONG one for our static site. Click the
> **Pages** tab, which instead asks for a **Build output directory** and a
> **Production branch** dropdown.

1. **dash.cloudflare.com** → **Workers & Pages** → **Create** → **Pages** tab →
   **Connect to Git** → pick `zzeenniitthh/orbitor`.
2. **Production branch:** `main`.
3. **Build settings:**
   - **Framework preset:** `None`
   - **Build command:** paste exactly:
     ```
     NODE_OPTIONS=--max-old-space-size=8192 npx nx build twenty-front && cd packages/twenty-front && ./scripts/inject-runtime-env.sh
     ```
   - **Build output directory:**
     ```
     packages/twenty-front/build
     ```
4. **Environment variables** (expand "Environment variables (advanced)") → add one:
   - Name: `REACT_APP_SERVER_BASE_URL`
   - Value: your **Railway server URL** (from step 2f). For this deploy it is:
     ```
     https://orbitor-production.up.railway.app
     ```
5. Click **Save and Deploy**. The first build takes a while (it builds the whole app).
6. When done, Cloudflare gives you a URL like `https://orbitor-xxx.pages.dev`.
   - Save it as your **Cloudflare Pages URL**.

---

## Part 4 — Connect the two URLs (the last wiring)

The backend needs to know the website's address (for links + sign-in redirects).
1. Back in **Railway → server → Variables**: set
   `FRONTEND_URL` = your **Cloudflare Pages URL**. Save.
2. Do the same on the **worker** service's `FRONTEND_URL`. Save.
3. Railway redeploys automatically. Wait for it to go healthy.

---

## Part 5 — First sign-in (done!)

1. Open your **Cloudflare Pages URL** in the browser.
2. Click **Continue with Email**, create your account, and create your workspace.
   - The workspace starts **clean** (no demo/sample data).
3. Add a company, a person — confirm it saves. 🎉

---

## If something goes wrong

- **Website loads but says it can't reach the server / network errors:**
  `REACT_APP_SERVER_BASE_URL` (Cloudflare Pages) must exactly equal your Railway
  server URL, and `FRONTEND_URL` (Railway) must equal your Pages URL. Fix and redeploy both.
- **Server keeps restarting:** check **server → logs**. Usually a wrong
  `PG_DATABASE_URL` (make sure Postgres was added to the project) or a missing R2 key.
- **File uploads fail (avatars don't stick):** re-check the three `STORAGE_S3_*`
  values and that the bucket is named `orbitor-files`.
- **Cloudflare Pages build fails on memory/timeout:** rare; the build command already
  raises Node's memory. If it persists, tell me and I'll switch the front to a
  pre-built deploy (build locally, upload with `wrangler`).
- **Railway domain port:** if the URL shows "Application failed to respond", make sure
  the generated domain's port is **3000** (server → Settings → Networking).

## Cost note
- Cloudflare Pages + R2: free tier is plenty to start.
- Railway: needs the **Hobby plan ($5/mo)** for the databases to stay up; real usage
  for this app is typically ~$10–25/mo total.

## What each value is (quick reference)

| Variable | What it is | Where it comes from |
|---|---|---|
| `APP_SECRET` | signs logins, encrypts secrets | `openssl rand -base64 32` |
| `PG_DATABASE_URL` | database connection | auto — Railway Postgres plugin |
| `REDIS_URL` | queue/cache connection | auto — Railway Redis plugin |
| `SERVER_URL` | backend's own address | Railway → server → Generate Domain |
| `FRONTEND_URL` | website address | Cloudflare Pages URL |
| `STORAGE_S3_ENDPOINT` | R2 address | already filled in (your account) |
| `STORAGE_S3_ACCESS_KEY_ID` | R2 login | Cloudflare R2 → API token |
| `STORAGE_S3_SECRET_ACCESS_KEY` | R2 password | Cloudflare R2 → API token |
| `REACT_APP_SERVER_BASE_URL` | tells the website where the backend is | = your Railway server URL |
