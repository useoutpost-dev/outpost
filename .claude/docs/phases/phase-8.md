# Phase 8 — Hardening & Self-Hoster Docs

## Goal
Close the security checklist, prove or disprove the known credential-refresh race, and
make the repo deployable end-to-end by a stranger.

## Deliverables
- [ ] Full sweep of `.claude/docs/security-checklist.md` against real code, with
      findings filed and severity-tagged
- [ ] Critical/high findings fixed; rest filed as known issues
- [ ] Refresh-race overnight test: 5 sandboxes sharing 1 subscription credential
      volume, scripted activity, auth failures captured
- [ ] Race outcome documented either way; mitigation implemented if small (e.g.
      server-side refresh lock), else filed as known issue with workaround
- [ ] Resource-limit defaults measured and set (CPU/mem/disk per sandbox); override env
      vars documented
- [ ] Every route returns typed `OutpostError`; no stack traces or paths leak to client
- [ ] `README.md` — what/why, screenshot placeholders
- [ ] `docs/deploy-fly.md` — step-by-step, clone to login
- [ ] `docs/env-reference.md` — every env var, required/optional, example value
- [ ] `docs/updating.md` — Claude Code version bump = adapter check procedure
- [ ] Full regression: lint, typecheck, tests green

## Files to create/change
- `README.md` — rewrite/expand
- `docs/deploy-fly.md` — new
- `docs/env-reference.md` — new
- `docs/updating.md` — new
- `apps/server/src/**` — fixes per security findings (auth, credentials, proxy,
  Docker/sandbox provider, error mapping)
- `apps/server/src/lib/errors.ts` (or existing `OutpostError` module) — audit call
  sites, ensure no leaked internals
- `apps/server/src/sandbox/limits.ts` (or provider config) — resource-limit defaults
- Test/script for the overnight race, kept under `apps/server/scripts/` or
  `apps/server/test/` per repo convention — new

## Task breakdown
1. Security sweep against every checklist box — **security-auditor (sonnet)**
2. Findings fixes: auth/credentials/proxy/Docker → **implementer (opus)**; everything
   else → **refactorer (sonnet)**
3. Refresh-race overnight test script + run — **implementer (opus)** — get human
   go/no-go first (real Fly spend, run `/preflight`)
4. Resource-limit tuning (measure real sandbox CPU/mem under a Claude session, set
   defaults, document overrides) — **implementer (opus)**
5. Docs: README, deploy-fly, env-reference, updating — **plan-writer (sonnet)**
6. Full regression: lint/typecheck/tests — **test-runner (haiku)**

## Dependencies
- All previous phases (P0–P7) — this is the closing hardening/buffer phase

## Risks & gotchas
- Overnight race test costs real Fly spend — get explicit human go/no-go before
  running it, run `/preflight` first
- Checklist findings can balloon scope — timebox: fix criticals now, file the rest as
  known issues, don't let this phase become unbounded
- Docs drift from code fast — write docs last, verify each doc against a genuinely
  clean deploy (not the dev machine's already-configured state)
- Resource-limit numbers need a real Claude Code session under load, not a guess —
  don't ship defaults that weren't measured

## Done when
- Every box in `security-checklist.md` is checked with evidence linked to the fix or
  finding
- Overnight race test ran and its outcome is documented either way (reproduced +
  mitigated, or not reproduced + noted)
- A clean-machine deploy following `docs/deploy-fly.md` alone reaches a working login
  and a running sandbox
- `docs/env-reference.md` covers every `process.env` read in the codebase
  (grep-verified)
- Full test suite (lint, typecheck, tests) is green
