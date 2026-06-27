# Orbitor — Licensing & AI chat fix

This folder is the self-contained record for one initiative: making the Orbitor fork unlock
Twenty's hosted/enterprise-gated features with **a license key we generate ourselves**, and
fixing the **AI agent chat** that currently does nothing.

## Contents
- **[RESEARCH.md](./RESEARCH.md)** — the factual map of how Twenty gates features today
  (billing, enterprise license, feature flags, AI model registration) with `file:line`
  citations, plus the root-cause analysis of the AI chat failure. §5–§6 add a **verified web
  research** pass (deep-research: 22 sources, 25 claims adversarially checked) on the external
  causes — the `AQ.` Gemini key migration, `streamText`'s silent error swallowing, Twenty bug
  #16213, Cloudflare SSE buffering, region availability — reconciled against our code map. This is
  the evidence base.
- **[PLAN.md](./PLAN.md)** — the agreed, not-yet-implemented implementation plan: self-generated
  RS256 license key, feature-flag-management unlock, and the AI chat fix, with sequencing and
  end-to-end verification.
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the canonical hosting/architecture reference for
  Orbitor (how it's hosted on Railway + Cloudflare, repo structure, build/deploy flow, env vars,
  upstream divergence). Updated alongside this initiative with a new section ("Feature gating,
  licensing & AI") describing the *current* gating reality. It lives in this folder so everything
  for the fork is in one place.

## TL;DR
- `IS_BILLING_ENABLED=false` (our default) already unlocks SSO, Custom Domain, and AI credits —
  Twenty's billing gates *grant* access when billing is off.
- Still locked: RLS, audit logs, >5 workspaces, signing-key rotation (all behind the
  enterprise **validity token**), feature-flag management, and the AI chat.
- ✅ **AI chat is fixed** (2026-06-27): the cause was AI-model registration, not the key/billing.
  Setting `GOOGLE_API_KEY` on the `orbitor` + `worker` Railway services makes the native catalog
  register all Gemini models. (The Admin Panel "add provider" form silently failed; the env var
  works.) Remaining AI items are optional hardening.
- Still to build: the **self-generated license** — sign an enterprise validity token trusted via an
  env public key (1 method + 1 config var + a mint script) — plus the one-line feature-flag-
  management unlock.

> Status: **AI chat resolved; license + feature-flag work pending.** Start with `RESEARCH.md`
> (Resolution + §0), then `PLAN.md` (Workstream A is the primary remaining task).
