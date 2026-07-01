# Postmortem — AI chat "spins forever" in production

**Date resolved:** 2026-06-30
**Severity:** High (AI chat fully broken in prod; all background jobs silently dead)
**Time to fix once correctly diagnosed:** ~minutes
**Time actually spent:** ~2 days

---

## TL;DR

The Railway **worker** service was running the **API server** (`node dist/main`) instead of
the **queue worker** (`yarn worker:prod`). With no process consuming BullMQ, every AI chat job
was enqueued and never picked up — so the chat spun forever. The same root cause silently killed
**all** background jobs (messaging/calendar sync, workflows, title generation, cron).

It was never a subscription/SSE bug, never the API key, never a code problem. The code was fine.
One process was simply not running.

---

## What the symptom looked like (and why it misled us)

- Send a chat → it spins forever. No reply, no error.
- Worked perfectly **locally**, broke only in **production**.
- Entering the provider key in-app worked locally; "didn't work" in prod.

Every one of these pointed us at plausible-but-wrong culprits:

| What we suspected | Why it felt right | Why it was wrong |
|---|---|---|
| SSE / GraphQL subscriptions | "Spins forever" = looks like the reply isn't being *delivered* | The reply was never *generated*; delivery was irrelevant |
| In-app AI provider key not registering | Worked with env var, "failed" with in-app paste | Key registration was actually fixed earlier; unrelated to the spin |
| Missing AI SDK packages | Prod-only failure | All packages present and statically imported |
| Billing / subscription / credits gate | User's gut feeling; prod-only | The credit check never even ran — no worker to run it |

All of these are **server-or-code** theories. The actual fault was **infrastructure** (a process
running the wrong command). We kept looking inside the house while the problem was that the
lights were never turned on.

---

## Root cause

Both Railway services (`orbitor` and `worker`) build from the **same** Docker image
(`packages/twenty-docker/server/Dockerfile`), whose default is `CMD ["node", "dist/main"]` (the
API server). The **worker service is supposed to override** its start command to
`yarn worker:prod` (→ `node dist/queue-worker/queue-worker`).

That override was **not taking effect** on the live deployments. The worker box was booting a
second copy of the API server. The API server does **not** consume jobs (its in-process queue
explorer is commented out in `app.module.ts`), so:

```
sendChatMessage → enqueue job to ai-stream-queue → (no consumer) → job sits forever → chat spins
```

The fix was forcing a clean redeploy that actually launched with `yarn worker:prod`.

---

## Why it took ~2 days (the real lessons)

### 1. We debugged the layer the symptom pointed at, not the layer the data pointed at.
"Spins forever" *screams* frontend/transport. We spent time on SSE, Cloudflare buffering,
subscriptions. **The symptom's vibe is not evidence.** We should have asked the boring question
first: *did the backend ever produce an answer at all?*

> **The single query that cracked it:** check the DB for the thread you just messaged.
> - Reply **saved but not shown** → delivery/SSE problem.
> - Reply **never saved** → nothing generated it; the problem is upstream of delivery.
>
> It was never saved. That one check eliminated ~80% of our wrong theories in 30 seconds. We
> should have run it on hour one, not day two.

### 2. We trusted "deployed = running the right thing."
The worker's config *said* `startCommand: yarn worker:prod`. We assumed that meant it was
running. It wasn't. **A stored setting is not proof of a running process.** Always confirm from
the actual running container / its live logs, not the config panel.

### 3. We didn't read the worker's own logs early.
The worker logs `"Processing job ..."` on **every** pickup. That line was **never present** —
for any job, ever. That alone proves "no consumer" in one look. We were reading the *frontend*
and the *server*, not the *worker*.

### 4. We missed a smoking gun hiding in plain sight.
The "worker" boot logs contained `RouterExplorer Mapped {...} route` and `GraphQLModule
initialized`. The real queue worker has **no web server and maps zero routes**. Those lines only
appear when the API server boots. The logs were literally telling us "this is the server" — we
just hadn't learned the tell yet.

### 5. Local worked, so we under-weighted "it's the environment."
`yarn start` runs the real worker locally, so local could never reproduce it. **When something
fails only in prod, suspect the things that only exist in prod first**: start commands, env
wiring, process topology, networking — not the application code that's identical in both.

---

## The 10-minute diagnostic that would have caught this

Run these **in order**, top-down through the pipeline. Stop at the first one that's wrong.

1. **Did the backend produce an answer?**
   Query the DB / `chatMessages` for the thread you just messaged.
   - Assistant message present → it's a **delivery/SSE** problem. Go look at the subscription.
   - Assistant message absent → keep going down.

2. **Did the worker pick up the job?**
   Read the **worker** service logs. Look for `Processing job ... on queue ai-stream-queue`.
   - Present → the job ran; look for an error/credit/model issue in the worker.
   - **Absent for every job, ever → there is no consumer.** Go to step 3.

3. **Is the worker process actually the worker?**
   Read the worker's **boot** logs.
   - If you see `RouterExplorer Mapped {...} route` / `GraphQLModule initialized` → it's running
     the **API server**, not the worker. **This is the bug.**
   - Confirm the running command (`/proc/1/cmdline`, or PID prefix: `[Nest] 1` = `node dist/main`
     run directly; a higher PID like `[Nest] 30` = `yarn`-spawned child = the real worker).

4. **Fix:** ensure the worker service's start command is `yarn worker:prod` and that a fresh
   deployment actually launched with it (verify via step 3, not the config panel).

---

## Guardrails so it can't silently happen again

- **Make worker mode independent of Railway's start-command override.** The durable fix is to
  branch in `packages/twenty-docker/twenty/entrypoint.sh` on an explicit role env var
  (e.g. `SERVICE_ROLE=worker` → `exec node dist/queue-worker/queue-worker`) instead of relying on
  the dashboard `startCommand` being honored. A baked-in env var survives redeploys; a dashboard
  override apparently did not, here. *(Not yet implemented — requires a commit.)*
- **A startup assertion / health signal per role.** The worker should log a loud, unmistakable
  line at boot like `QUEUE WORKER READY — consuming N queues` and the server should log
  `API SERVER READY`. Then "which one is this box?" is answerable in one grep.
- **Alert on an empty queue consumer.** If `ai-stream-queue` (or any queue) has depth > 0 with
  zero `Processing job` logs for N minutes, page someone. Unconsumed queues are invisible until a
  user complains.
- **Smoke-test the worker path after every deploy**, not just the HTTP path. "The site loads"
  ≠ "background jobs run." Send one AI chat and assert a persisted reply.

---

## Mental model to keep

> When a user-facing action "hangs," walk the pipeline **end-to-backend-first**:
> *Was the result produced? → Was the job consumed? → Is the consumer even running the right code?*
> Don't start at the layer the symptom emotionally points to. Start at the data.

And: **prod-only failures are environment failures until proven otherwise.** The code that runs
in both places is the *least* likely suspect.
