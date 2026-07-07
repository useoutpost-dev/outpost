# Phase 4 — Credentials & Accounts

## Goal
Multiple Claude accounts (subscription or API key), stored user-side, picked per sandbox.
Heaviest security phase — `credential-layer` skill is binding.

## Deliverables
- [ ] `accounts` table + `sandboxes.account_id` migration
- [ ] Credential crypto (libsodium sealed box), account CRUD, volume provisioning, env-inject assembly
- [ ] `claude-adapters/credentials.ts` — sole owner of Claude credential file paths/format
- [ ] Sandbox create flow: account picker (existing | new subscription | new API key)
- [ ] API keys injected as `ANTHROPIC_API_KEY` env, never written to sandbox disk
- [ ] Logging shows account labels only, never key/credential contents
- [ ] Tests: encrypt/decrypt roundtrip, no plaintext key in DB, inject path, grep-test for adapter isolation
- [ ] `/security-check` passed, including 3 compliance-boundaries questions (all "no")

## Files to create/change
- Migration: `accounts` table (id, label, kind: subscription|api_key, credential_volume_ref nullable, encrypted_key nullable, created_at) + `sandboxes.account_id` column — **main thread owns this file/schema**
- `apps/server/src/credentials/crypto.ts` — libsodium sealed box; master key from `OUTPOST_MASTER_KEY` env; encrypt at rest, decrypt only at inject time
- `apps/server/src/credentials/service.ts` — account CRUD, per-account volume provisioning, env-inject assembly for sandbox create
- `apps/server/src/credentials/accounts.repo.ts` — Drizzle queries for `accounts` table (repository pattern, thin)
- `apps/server/src/credentials/routes.ts` — account endpoints, session-gated
- `packages/shared/claude-adapters/credentials.ts` — Claude credential file paths/format inside `~/.claude`; mounts ONLY the credential file, never the whole dir
- `apps/web/src/screens/SandboxCreate.tsx` (or existing create flow file) — account picker UI
- `apps/server/src/credentials/*.test.ts` — roundtrip, no-plaintext, inject-path, adapter-isolation grep test

## Task breakdown
1. **main thread** — `accounts` table migration + `sandboxes.account_id` (schema decision, not delegated).
2. **implementer (opus)** — `crypto.ts` + `service.ts` + volume mount logic (hard problem: sealed-box crypto, per-account volume lifecycle, shared-vs-separate mount modes).
3. **implementer (opus)** — `claude-adapters/credentials.ts` (hard problem: undocumented Claude credential file format/paths, single-file mount into per-sandbox `~/.claude`).
4. **refactorer (sonnet)** — account picker UI in sandbox create flow, consumes task 2/3 APIs.
5. **test-runner (haiku)** — runs tests written by implementer: encrypt/decrypt roundtrip, key never in DB plaintext, inject path, grep-test that no module outside `credentials/` imports the adapter.
6. **security-auditor (sonnet)** — `/security-check`, MANDATORY. Must cover Credentials section plus the 3 compliance-boundaries questions; all must resolve "no".

Order: 1 before 2; 2 and 3 can run in parallel (max 2 opus concurrently, within the 3-subagent cap); 4 after 2+3; 5 after 2+3; 6 last, after all others pass.

## Dependencies
- P2 (sandbox create) — account picker hooks into the create flow.
- P3 useful but not blocking — needed to verify subscription login-inside-sandbox by hand.

## Risks & gotchas
- Token-refresh race when several sandboxes share one subscription volume — known risk, first suspect on intermittent auth failures. Overnight stress test (5 sandboxes, 1 volume) is P8 scope, not this phase.
- Master key rotation is out of scope for this phase — document as a limitation, not a TODO left dangling.
- Sealed-box key loss (`OUTPOST_MASTER_KEY` lost) means all stored API keys are unrecoverable — document backup guidance for self-hosters.
- Never mount the whole `~/.claude` directory shared — only the credential file, or session data/transcripts bleed across sandboxes.
- Telemetry and logs must never see key material — label-only logging is a hard rule, not a preference.

## Done when
- Create a sandbox with an API-key account — key is present in process env inside the sandbox, absent from disk and from Fly machine config at rest (encrypted in DB).
- Create two sandboxes on one subscription account — login once, both authenticated.
- Grep proves credential file access happens only in `credentials/` and the adapter.
- Logs show account labels, never secrets.
- `security-auditor` passes the Credentials section and all 3 compliance-boundaries questions answer "no".
