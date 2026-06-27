# Plan — Self-generated licensing + AI chat fix (Orbitor fork)

> Date: 2026-06-27. Companion: [`RESEARCH.md`](./RESEARCH.md) (all `file:line` evidence),
> [`README.md`](./README.md) (index), and [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> (updated with the gating model). **Not yet implemented** — this is the agreed design.

## Context

Orbitor is a self-hosted fork of Twenty. We want our fork to (a) unlock the features Twenty
gates behind its hosted enterprise license — **using a license key we generate ourselves**, not
twenty.com — and (b) make the **AI agent chat actually work**, which is currently broken.

Research (see `RESEARCH.md`) overturned the original premise: with `IS_BILLING_ENABLED=false`
(our default) the billing gates already *grant* access, so SSO, Custom Domain and AI credits are
already open. The only things still locked are the **enterprise-validity-gated** features (RLS,
audit logs, >5 workspaces, signing-key rotation), **feature-flag management**, and the **AI
chat** — which fails at AI-model registration/allow, not billing.

## Decisions (locked with the user)

1. **Gating model:** self-generated license key (RS256, we hold the private key).
2. **License scope:** *binary unlock-all* — a valid key makes `isValid()` true, unlocking RLS,
   audit logs, unlimited workspaces, signing-key rotation, **and** feature-flag management. AI
   works independently of the license. Token payload is structured so feature/tier fields can be
   added later for selling to customers.
3. **AI keys:** instance-wide (Twenty's existing `AI_PROVIDERS` mechanism). Fix the wiring so an
   added key reliably registers a usable, auto-allowed model, and surface errors clearly.
4. **Upstream-merge hygiene:** prefer env/config + small additive changes over editing committed
   constants, so upstream merges stay clean (consistent with `ARCHITECTURE.md` §8).

## Non-goals
- Re-enabling Stripe billing or building a billing UI.
- True per-workspace AI keys (instance-wide only for now).
- Tiered/per-feature license enforcement (structure for it; don't build it yet).

---

## Workstream A — Self-generated license key (unlock enterprise features)

**Goal:** make `enterprisePlanService.isValid()` return `true` using a token we sign, trusted in
production, without phoning home to twenty.com and without editing the committed key constant.

1. **Generate our RSA keypair (offline, once).** 2048-bit RS256. Private key stored in our secret
   manager / password manager — **never committed**. Public key goes into env.
2. **Trust our public key in prod.** Add an optional config var
   `ORBITOR_LICENSE_PUBLIC_KEY` (`config-variables.ts`, `isSensitive`, optional) and amend
   `EnterprisePlanService.getPublicKeysToTry()` (`enterprise-plan.service.ts:507-518`) to append
   this key (when set) to the list it returns **in all environments**. This leaves the committed
   `enterprise-public-key.constant.ts` untouched → clean upstream merges.
3. **Mint script.** Add `packages/twenty-server/scripts/generate-orbitor-license.ts` (a small,
   standalone Node script — not wired into Nest) that, given the private key + params
   (`licensee`, `sub`, expiry), prints:
   - `ENTERPRISE_KEY` — RS256 JWT with `EnterpriseKeyPayload` (`{sub, licensee, iat}`).
   - `ENTERPRISE_VALIDITY_TOKEN` — RS256 JWT with `EnterpriseValidityPayload`
     (`{sub, status:'valid', iat, exp}`) with a far-future `exp`.
   Payload shapes from `enterprise/types/enterprise-key-payload.type.ts`. This is the
   "generate a key" tool the user asked for; future tier fields slot into these payloads.
4. **Install on Railway (server + worker):** set `ORBITOR_LICENSE_PUBLIC_KEY`, `ENTERPRISE_KEY`,
   `ENTERPRISE_VALIDITY_TOKEN`. On boot `onModuleInit` loads them → `isValid()` true.
5. **Stop phoning home.** Set `ENTERPRISE_API_URL` to empty/our own so `refreshValidityToken()` /
   `reportSeats()` don't post instance metadata to twenty.com. (On failure these already keep the
   current token — `enterprise-plan.service.ts:260-266` — so this is privacy, not correctness.)
6. **Audit crons.** Verify no scheduled job overwrites the validity token; confirm the now-enabled
   `rotate-signing-keys` cron (`jwt/crons/jobs/rotate-signing-keys.cron.job.ts`) is acceptable
   (it's a security feature, fine to run) — note it in the changelog.

**Files:** `enterprise-plan.service.ts` (1 method), `config-variables.ts` (1 var),
new `scripts/generate-orbitor-license.ts`. Plus Railway env vars (no rebuild).

**Quick fallback (dev/staging):** in non-prod, `ENTERPRISE_VALIDITY_TOKEN =
ENTERPRISE_DEV_VALIDITY_TOKEN` (the committed 2125 token) already makes `isValid()` true with no
code change — useful to validate the downstream unlocks before the keypair is ready.

## Workstream B — Unlock feature-flag management

`canManageFeatureFlags` (`client-config.service.ts:219-222`) is `dev || IS_BILLING_ENABLED`. Add
`|| this.enterprisePlanService.isValid()` so our license unlocks it. Requires injecting
`EnterprisePlanService` into `ClientConfigService` (add to its module imports/providers). One-line
logic change + wiring.

## Workstream C — Make the AI chat work

> ✅ **RESOLVED 2026-06-27 by config alone** — setting `GOOGLE_API_KEY` on the `orbitor` + `worker`
> Railway services made the chat work (native catalog path; see `RESEARCH.md` Resolution). The
> code items below (C1–C4) are now **optional hardening**, not required. Recommended-but-optional:
> **C1** (so future AI failures aren't silent) and **C2 Admin-Panel fix** (so the in-app form
> works too, not just the env var).

Informed by the web research in `RESEARCH.md` §5–§6. There are **two independent silence layers**
(pre-stream throw → 500; in-stream `streamText` error swallowed), so the first fix is *visibility*,
then the actual cause.

**C0 — Diagnose first (no guessing).** Before changing code, capture prod state and answer the
`RESEARCH.md` §6 open questions:
- The stored `AI_PROVIDERS` config value and the workspace's `smartModel`/`fastModel` +
  admin `disabledModels` (Railway DB read: `railway run` psql / read-only query).
- **How was Gemini added** — native `"google"` catalog entry (`GOOGLE_API_KEY`) or a **custom
  OpenAI-compatible** provider? (Determines whether §5.2/§5.4 apply.)
- **Does the key start with `AQ.` or `AIza`?** (`AQ.` + an OpenAI-compatible/Bearer path = known
  break; `AQ.` can also 401 on restricted accounts even natively.)
- Whether the failure is *pre-stream* (resolver 500) or *in-stream* (swallowed) — surfaced by C1.

**C1 — Surface the swallowed error (highest-value, do first).** Two parts, because there are two
silence layers:
- *In-stream:* in the agent-chat streaming service, add an `onError({error})` callback to the
  `streamText` call **and** handle the `fullStream` `case 'error'` part — log it server-side and
  publish a `stream-error` chat event so the UI shows it. Per the AI SDK docs, `streamText` does
  **not** throw; this is the only reliable way to see the real Gemini error
  (`RESEARCH.md` §5.1). Target: `ai/ai-chat/services/*streaming*` + the chunk publisher.
- *Pre-stream:* in `ai/utils/ai-graphql-api-exception-handler.util.ts:37-40`, map
  `API_KEY_NOT_CONFIGURED` / model-not-available to a **user-facing** error (`UserInputError`/400,
  e.g. "No AI model configured — add a provider key in the Admin Panel") instead of
  `InternalServerError`. Kills the silent-500.

**C2 — Make a provider key register a usable model.**
- **Config path (simplest, recommended):** set `GOOGLE_API_KEY` so the committed `"google"`
  catalog entry's `{{GOOGLE_API_KEY}}` template resolves and all Gemini models register
  (`provider-config.service.ts:54-81`). Uses the **native** `@ai-sdk/google` provider
  (`x-goog-api-key`) — which **avoids** the `AQ.`-on-Bearer break (`RESEARCH.md` §5.2/§6). No
  per-model JSON needed. If the current key is `AQ.` and misbehaving, also try regenerating an
  `AIza` key in AI Studio (if the account still allows it).
- **Admin-Panel path:** fix `addAiProvider` (`admin-panel.resolver.ts:511-528`) so that when the
  provider name matches a catalog provider (e.g. `"google"`), the saved entry inherits the
  catalog's `npm` + `models` and the user only supplies `apiKey` — preventing the
  "no `npm`/`models` → silently skipped" failure (`ai-model-registry.service.ts:93,102`).
- Use an exact valid model id: `gemini-2.5-flash` / `gemini-2.5-pro` / `gemini-2.5-flash-lite`
  (`RESEARCH.md` §5.7).

**C3 — Auto-allow / safe default model.** Once a model is registered, ensure
`workspace.smartModel = AUTO_SELECT_SMART_MODEL_ID` resolves to it, and a `smartModel` pointing at
an unregistered id falls back instead of throwing (`ai-model-registry.service.ts:206-317`).

**C4 — Confirm transport + build (verify, likely no change).**
- Confirm the Railway API domain is hit **directly** (not CF-proxied) so CF SSE buffering
  (`RESEARCH.md` §5.6) is not in play; if it ever is, ensure `Content-Type: text/event-stream` +
  `X-Accel-Buffering: no` on the SSE route.
- Confirm the deployed build ships the AI chat UI and the #16213 fix (`RESEARCH.md` §5.4/§5.9).

**Files:** agent-chat streaming service + chunk/event publisher (onError + `error` part),
`ai-graphql-api-exception-handler.util.ts`, `admin-panel.resolver.ts`,
`ai-model-registry.service.ts` (fallback guard), + `GOOGLE_API_KEY` env on Railway (server+worker).

---

## Sequencing
0. ~~AI chat~~ ✅ **DONE** — `GOOGLE_API_KEY` set on both Railway services; chat works.
1. **A** — license keypair + env; flips the enterprise features (RLS, audit logs, unlimited
   workspaces, signing-key rotation). *Primary remaining work.*
2. **B** — feature-flag management unlock (one line + wiring).
3. **C1 (optional)** — AI error-surfacing so future failures aren't silent.
4. **C2 Admin-Panel fix (optional)** — make the in-app "add provider" form work, not just the env
   var; **C3/C4** safe-model fallback + transport/build confirmation.

Implement on a branch (current: `bugfixapi` or a new `feat/licensing-and-ai`); typecheck + lint
diff per `CLAUDE.md`; deploy by pushing to `main` (Railway + Cloudflare auto-build); env-only
changes are fast redeploys.

## Verification (end-to-end)
- **License:** GraphQL `workspace.hasValidEnterpriseValidityToken` → `true`; create a 6th
  workspace (no cap error); RLS predicates + audit logs become available; feature-flag management
  appears in Settings.
- **AI chat (happy path):** send "hello" in the live app → a streamed reply appears. Confirm in
  Railway **worker** logs that the agent-chat job runs and the Gemini call succeeds (this was
  empty before — `RESEARCH.md` §3).
- **AI chat (error path):** with no key configured, the UI shows the clear C3 message, not a
  silent hang or 500.
- **No regressions:** `npx nx typecheck twenty-server`; `npx nx lint:diff-with-main twenty-server`;
  relevant unit tests for the touched services.

## Risks & notes
- Enabling enterprise turns on `rotate-signing-keys` — verify it doesn't disrupt active sessions
  on first run.
- `ENTERPRISE_API_URL` must be neutralized to avoid metadata phone-home.
- Keep the private key out of the repo and out of `ARCHITECTURE.md`; only the public key + tokens
  live in Railway env.
- Divergence to record in `ARCHITECTURE.md` §8 after implementation: the `getPublicKeysToTry`
  env-key change, `ORBITOR_LICENSE_PUBLIC_KEY` + `GOOGLE_API_KEY` config vars, the
  `canManageFeatureFlags` line, the AI error-handler + `addAiProvider` changes, and the mint
  script.
