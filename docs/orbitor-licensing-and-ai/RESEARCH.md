# Research — Twenty feature gating, licensing & AI chat (Orbitor fork)

> Date: 2026-06-27. Source: direct code reads + two thorough `Explore`-agent sweeps of
> `packages/twenty-server`. Every claim below has a `file:line` citation. This is the factual
> basis for [`PLAN.md`](./PLAN.md). It records *current reality*, not the intended changes.

## ✅ RESOLUTION — AI chat (confirmed 2026-06-27)

**The AI chat now works.** Fix: set `GOOGLE_API_KEY` as an **env var on both the `orbitor` and
`worker` Railway services**. This resolves the committed `"google"` catalog's `{{GOOGLE_API_KEY}}`
template → the **native** `@ai-sdk/google` provider registers all Gemini models → chat streams.

Confirmed root cause: the chat was failing at **AI-model registration** (no usable model in the
registry), *not* billing, *not* the key (the key was always valid), *not* the SSE transport, *not*
region. The earlier attempt added Gemini via the Admin Panel "add provider" form, which writes a
*custom* `AI_PROVIDERS` entry that was silently skipped (missing `npm`/`models` and/or not the
native path). Using the **env var instead of the Admin Panel form** is the working method.

Remaining AI items in `PLAN.md` Workstream C (error-surfacing, `addAiProvider` fix, model
fallback) are now **optional hardening**, not required to make the chat work.

---

## 0. The headline finding (premise inversion)

The original assumption — "paid features (incl. AI chat) are blocked because we have no
subscription" — is **mostly wrong for our fork**. Twenty ships `IS_BILLING_ENABLED=false`
(`config-variables.ts:780`), and **when billing is off, the billing gates GRANT access instead
of blocking it**:

- `billing.service.ts:48-52` — `hasEntitlement()` returns `true` immediately when billing is off.
  → **SSO and Custom Domain are already unlocked** on our fork.
- `billing-usage.service.ts:311-314` — `hasAvailableCredits()` returns `true` immediately when
  billing is off. → **the AI credit gate never fires**; the chat is **not** blocked by
  credits/subscription.

So most "paid" gates are already open. What is *actually* still gated, and the real AI-chat
cause, are documented below.

## 1. What is actually still gated on a billing-off fork

| Feature | Gated by | State on our fork |
|---|---|---|
| SSO, Custom Domain | `hasEntitlement()` only | **Already unlocked** (billing off → true) |
| AI credits | `hasAvailableCredits()` | **Already unlocked** (billing off → true) |
| RLS (row-level security) | `enterprisePlanService.isValid()` **AND** entitlement | **Blocked** — needs enterprise validity |
| Audit Logs | `enterprisePlanService.isValid()` **AND** entitlement | **Blocked** — needs enterprise validity |
| > 5 workspaces | `enterprisePlanService.isValid()` | **Blocked** at 5 without enterprise |
| JWT signing-key rotation | `enterprisePlanService.isValid()` | Skipped (no-op) without enterprise |
| Manage feature flags (UI) | `IS_BILLING_ENABLED \|\| NODE_ENV=development` | **Blocked** in prod with billing off |
| AI chat actually working | AI model registration + model-allow + error surfacing | **Broken** (see §3) |

## 2. The enterprise-license seam (how to unlock the enterprise column)

`EnterprisePlanService` is a **real RS256-JWT check, not a stub**
(`enterprise/services/enterprise-plan.service.ts`):

- `isValid()` (155-157) → `hasValidEnterpriseValidityToken()` (145-153): true iff a cached
  *validity token* exists and its `exp` is in the future.
- The validity token is loaded on boot (`onModuleInit` 53-56 → `loadValidityToken` 72-107) from:
  1. DB (`AppTokenEntity` type `EnterpriseValidityToken`, newest non-revoked), else
  2. the `ENTERPRISE_VALIDITY_TOKEN` config var (86).
- Tokens are verified by `verifyJwt()` (520-567) against embedded RSA public keys in
  `enterprise/constants/enterprise-public-key.constant.ts`.
- **Key fact:** `getPublicKeysToTry()` (507-518) trusts the **dev** public key **only** in
  `development`/`test`; in production it trusts **only** `ENTERPRISE_JWT_PUBLIC_KEY`
  (twenty.com's key). So a token we self-sign won't verify in prod unless we make prod trust our
  key.
- **Shortcut that already exists:** `enterprise-public-key.constant.ts:24-26` ships
  `ENTERPRISE_DEV_VALIDITY_TOKEN` (`status:valid`, **exp 2125**), signed by the dev key. It works
  out-of-the-box in `development`, and would work in prod *if* prod trusted the dev key.
- **`refreshValidityToken()` (205-267)** posts our key + instance metadata to
  `ENTERPRISE_API_URL` (default `https://twenty.com/api/enterprise`, `config-variables.ts`
  ~1658). On any non-OK/error it **logs and keeps the current token** (260-266) — so it won't
  clobber a self-signed token, but it *does phone home* with instance metadata
  (`gatherInstanceMetadata` 459-479) unless we neutralize the URL.

Callers of `isValid()` (what unlocks when it's true):
- RLS: `row-level-permission-predicate.service.ts:555-567`,
  `row-level-permission-predicate-group.service.ts:137-149`
- Audit logs: `event-logs.service.ts:144-156`
- Workspace cap: `auth/services/sign-in-up.service.ts:478-496` +
  `MAX_WORKSPACES_WITHOUT_ENTERPRISE_KEY = 5`
- Signing-key rotation cron: `jwt/crons/jobs/rotate-signing-keys.cron.job.ts:29-35`
- `auth/guards/enterprise-features-enabled.guard.ts:23-30`
- Exposed to client: `workspace.resolver.ts:332-335` (`hasValidEnterpriseValidityToken` field)

The `@license Enterprise` header (top of 239 files) is **documentary only — no build/runtime
enforcement**. Real enforcement is `isValid()` + entitlement checks.

Feature-flag management gate: `client-config/services/client-config.service.ts:219-222` —
`canManageFeatureFlags = NODE_ENV===development || IS_BILLING_ENABLED`. Not tied to enterprise.

## 3. Why the AI chat does nothing (the real cause space)

Send path: `ai/ai-chat/resolvers/agent-chat.resolver.ts:142-156`, in order:
1. `getAvailableModels().length === 0` → throws `API_KEY_NOT_CONFIGURED`
2. `resolvedModelId = modelId ?? workspace.smartModel` → `validateModelAvailability()` throws if
   not admin-allowed or not workspace-allowed
3. `hasAvailableCreditsOrThrow()` → **auto-passes** (billing off)

So the failure is at **step 1 or 2 — AI model registration/allow**, never credits.

Key wiring:
- Admin-Panel key entry: `admin-panel/admin-panel.resolver.ts:511-528` `addAiProvider` writes the
  **instance-wide** `AI_PROVIDERS` config: `customProviders[providerName] = providerConfig`.
- Resolution: `ai-models/services/provider-config.service.ts:24-31` merges
  `{...resolvedCatalog, ...AI_PROVIDERS}`. **`{{VAR}}` templates are resolved only in the
  committed catalog, never in user `AI_PROVIDERS`** (26-27). The catalog already contains
  `"google"` with `apiKey:"{{GOOGLE_API_KEY}}"` and the full Gemini model list
  (`ai-models/ai-providers.json`).
- Registration: `ai-models/services/ai-model-registry.service.ts:91-135`. A model becomes
  **usable** (added to `modelRegistry`) only if the provider has `npm` (93), a non-empty `models`
  array (102), **and** `isProviderConfigured(config)` is true (106). `isProviderConfigured` =
  `!!(apiKey || accessKeyId || authType)` (`utils/is-provider-configured.util.ts:3-4`).
- Allow checks: `validateModelAvailability` (294-317) → `isModelAdminAllowed` (disabled models)
  + `isModelAllowedByWorkspace` (workspace `smartModel`/`fastModel`). `workspace.smartModel`
  default = `AUTO_SELECT_SMART_MODEL_ID` (`workspace.entity.ts:302-308`).
- **Error surfacing bug:** `ai/utils/ai-graphql-api-exception-handler.util.ts:37-40` maps
  `API_KEY_NOT_CONFIGURED` and `AGENT_EXECUTION_FAILED` to **`InternalServerError` (500)**, not a
  user-facing message — this is the **"no action / no error"** symptom the user reported.

Ranked likely causes (to confirm with the §C0 diagnostic in the plan):
1. The added provider was saved without `npm`/`models` (or under the wrong key, e.g. `"Google"`
   not `"google"`), so no usable model registered.
2. The catalog `"google"` entry stays templated because `GOOGLE_API_KEY` is unset, and the custom
   entry didn't fully configure → `getAvailableModels()` empty → step-1 throw → 500.
3. `workspace.smartModel` points at a model id not in the registry → step-2 throw → 500.

Confirmed evidence the request likely never reaches model execution: Railway worker logs show
**no AI-chat job activity** at all (only boot logs) — consistent with a synchronous throw in the
resolver, not a streaming/SSE failure.

## 4. What this means for the plan
- **Licensing:** build a self-generated RS256 key we control; make prod trust our public key via
  env (leave the committed constant alone for clean merges); mint `ENTERPRISE_KEY` +
  `ENTERPRISE_VALIDITY_TOKEN`. That single switch flips RLS, audit logs, unlimited workspaces, and
  signing-key rotation. Feature-flag management needs one extra line.
- **AI:** diagnose the actual `AI_PROVIDERS`/`smartModel` state on prod, fix model registration
  (likely: set `GOOGLE_API_KEY` so the catalog resolves, and/or fix `addAiProvider` to merge
  catalog `npm`/`models`), and fix error surfacing so failures are visible.

---

## 5. Web research — external / web-documented causes (deep-research, 2026-06-27)

A fan-out web research pass (22 sources fetched, 25 claims adversarially verified 2-of-3,
23 confirmed / 2 refuted) on the *externally-knowable* causes. Ranked findings:

### 5.1 TOP — `streamText` swallows errors (this is WHY there's "no error") — confidence: high
The Vercel AI SDK `streamText` **does not throw on failure**; errors become inert *error parts
inside the stream*. Unless the consumer wires an `onError({error})` callback or handles
`case 'error'` in `fullStream`, a failed call yields no exception and no output — exactly "chat
does nothing, no visible error." The AI SDK troubleshooting page is literally titled *"streamText
fails silently."* This is the universal explainer: **any** upstream failure (bad key, wrong
endpoint, region block, safety/malformed-function block) surfaces as silence.
Sources: `ai-sdk.dev/docs/troubleshooting/stream-text-not-working`,
`ai-sdk.dev/docs/ai-sdk-core/error-handling`, `github.com/vercel/ai/issues/4726`, `/4720`, `/4099`.

### 5.2 TOP — new `AQ.`-prefixed Gemini keys + OpenAI-compatible/Bearer transport — confidence: high
Google AI Studio now issues `AQ.`-prefixed *Auth keys* by default; classic `AIza` keys are being
phased out (rejection starts 2026-06-19, full Sept 2026). `AQ.` keys work on the **native** Gemini
endpoint via the `x-goog-api-key` header, but **fail on the OpenAI-compatible endpoint**
(`/v1beta/openai/`) when sent as a Bearer token — error: *"Multiple authentication credentials
received. Please pass only one."* (acknowledged by a Google moderator on the official forum). Some
accounts can **only** generate `AQ.` keys. ⚠️ Refuted sub-claim: `AQ.` keys do **not** always work
even natively — some restricted accounts `401` on the native endpoint too.
Sources: `ai.google.dev/gemini-api/docs/api-key`,
`discuss.ai.google.dev/t/...new-aq-prefix-api-keys-fail-on-openai-compatible-endpoints...`,
`dev.to/rapls/i-created-a-gemini-api-key-and-got-aq-instead-of-aiza-3dp3`.

### 5.3 STRONG MATCH — `gemini-2.5-flash` `finishReason:'error'`, silent — confidence: medium
Documented `@ai-sdk/google` + `gemini-2.5-flash` failure: the stream ends with `finishReason
'error'`, empty assistant text, **no `onError` fired**, frontend gets only a `step-start` part —
while Google Cloud console shows HTTP **200**. Root-caused to Gemini `MALFORMED_FUNCTION_CALL`
mapped to `finishReason 'error'`. Intermittent; tied to large context / tool/reasoning calls.
Exactly our "silent nothing," same provider+model family.
Sources: `github.com/vercel/ai/issues/8186`, `/discussions/8183`, `/issues/8078`.

### 5.4 RELATED Twenty bug #16213 — Responses API vs Chat Completions — confidence: high
On the **OpenAI-compatible** provider path, Twenty's model registry called `provider(modelId)`
(OpenAI *Responses* API, `/responses`) instead of `provider.chat(modelId)` (Chat Completions,
`/chat/completions`); Gemini's OpenAI-compatible endpoint doesn't support `/responses` → 404.
Follow-up #16817 proposes an `OPENAI_COMPATIBLE_API_TYPE` env var. ⚠️ Refuted: Twenty does **not**
route Gemini through Responses *by default* — only on the OpenAI-compatible path.
Sources: `github.com/twentyhq/twenty/issues/16213`, `/16817`.

### 5.5 CHECKABLE — env-var name mismatch — confidence: high (impact depends on code)
`@ai-sdk/google` defaults to reading `GOOGLE_GENERATIVE_AI_API_KEY`; Twenty uses `GOOGLE_API_KEY`.
If Twenty didn't pass `apiKey` explicitly, the SDK default lookup returns undefined → no key sent.
(See §6 — our code map shows Twenty *does* pass `apiKey` explicitly, so this is likely mitigated,
but the catalog template is `{{GOOGLE_API_KEY}}`, so that env var must be set.)
Sources: `ai-sdk.dev/v5/providers/ai-sdk-providers/google-generative-ai`,
`deepwiki.com/twentyhq/twenty/6.3-environment-variables-and-configuration`.

### 5.6 SECONDARY — Cloudflare buffers SSE (`text/event-stream`) — confidence: medium (likely N/A here)
Cloudflare can buffer `text/event-stream` responses until ~100 KB accumulate even with
`response_buffering` off. Fix: `Content-Type: text/event-stream` + `X-Accel-Buffering: no`.
⚠️ Probably **not** our case (see §6): our API calls go **directly to Railway**, not through CF.
Sources: `community.cloudflare.com/t/...buffers-text-event-stream...810790`,
`github.com/cloudflare/cloudflared/issues/199`.

### 5.7 Valid Gemini 2.5 model ids — confidence: high
`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. A wrong/aliased id → model-not-found
→ (silently, per §5.1). Confirm the exact id Twenty sends.
Sources: `ai-sdk.dev/v5/providers/ai-sdk-providers/google-generative-ai`,
`ai.google.dev/gemini-api/docs/models`.

### 5.8 RULED OUT — geographic restriction (Israel) — confidence: high
Israel is on Google's official supported-regions list; genuine geo-blocks return a **loud** HTTP
400 `FAILED_PRECONDITION` "User location is not supported", not silence. Also our backend egresses
from **Railway's region**, not Israel. Not the cause.
Sources: `ai.google.dev/gemini-api/docs/available-regions`,
`discuss.ai.google.dev/t/...user-location-is-not-supported...`.

### 5.9 Verify the deployed build actually ships the AI UI + #16213 fix — confidence: high
Twenty #13563: a release (v1.2.1) had the AI backend wired but **no AI chat UI** because the UI PR
wasn't in that release. Confirm Orbitor's build includes the chat UI and the #16213 fix.
Source: `github.com/twentyhq/twenty/issues/13563`.

## 6. Reconciliation — web findings × our code map

- **Twenty's Google path is the NATIVE `@ai-sdk/google` provider** (`sdk-provider-factory.service.ts`
  → `case AI_SDK_GOOGLE: buildStandardProvider(config, createGoogleGenerativeAI)`), which uses
  `x-goog-api-key`, and `buildStandardProvider` passes `apiKey` explicitly. So:
  - §5.5 (env var default) is **mitigated** — but `GOOGLE_API_KEY` must be set for the catalog
    `{{GOOGLE_API_KEY}}` template to resolve.
  - §5.2 / §5.4 (AQ.-on-Bearer, Responses-API 404) only apply **if Gemini was added as a custom
    OpenAI-compatible provider** in the Admin Panel instead of using the native `"google"` catalog
    entry. **This is a prime thing to check in C0** — how exactly the key was added.
  - An `AQ.` key can still fail on the native path for restricted accounts (§5.2 caveat) → would
    appear as a swallowed in-stream error.
- **Cloudflare is NOT in our API path** — the frontend calls `REACT_APP_SERVER_BASE_URL`
  (`orbitor-production.up.railway.app`) directly; CF Pages only serves static assets. So §5.6 is
  likely **not** our cause (verify the Railway domain isn't CF-proxied).
- **Two independent silence layers** now explain "no action / no error":
  1. *Pre-stream* synchronous throw (no models / model-not-allowed) → mis-mapped to HTTP 500
     (our §3, `ai-graphql-api-exception-handler.util.ts:37-40`).
  2. *In-stream* `streamText` errors swallowed unless `onError`/`case 'error'` is handled (§5.1).
  The decisive diagnostic is therefore: **add error logging at BOTH layers** (surface the 500 as a
  real message + log the `fullStream` `error` part) — this is the only reliable way to see the
  actual upstream Gemini error.

### Open questions to resolve in C0 (diagnostic)
1. Does the deployed key start with `AQ.` or `AIza`? Is the Google account a restricted one?
2. Was Gemini added via the native `"google"` catalog (`GOOGLE_API_KEY`) or as a **custom
   OpenAI-compatible** provider (→ §5.2/§5.4 apply)?
3. Is the failure *pre-stream* (resolver throw → 500) or *in-stream* (swallowed `streamText`
   error)? Add `onError` + log the `error` part to find out.
4. What exact `modelId` / `workspace.smartModel` is sent — a valid §5.7 id?
