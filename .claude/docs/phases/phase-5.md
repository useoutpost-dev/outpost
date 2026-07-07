# Phase 5 — Telemetry & Usage (Lookout)

## Goal
Usage data flows from sandboxes to a usage bar. Free tier: bar + totals only.
`telemetry-pipeline` skill is binding.

## Deliverables
- [ ] OTLP/HTTP collector, reachable only from sandbox network, never public
- [ ] Normalize OTLP metrics into `usage` table rows
- [ ] `/api/usage`: totals + per-sandbox split, session-gated, per-sandbox query scoping everywhere
- [ ] `claude-adapters/usage-estimate.ts` — isolated subscription-limit % estimation
- [ ] `UsageBar` component (beacon fill, IBM Plex Mono numerals) + Usage screen with totals
- [ ] Labels: "estimated" on %, "est. API value" on cost — never implies billing
- [ ] Prompt-content logging OFF, asserted by test
- [ ] Tests: normalize fixtures, adapter fixture-based, ingest auth rejection
- [ ] `/security-check` passed (Telemetry domain)

## Files to create/change
- Migration: `usage` table (id, ts, sandbox_id, account_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost_usd) — **main thread owns this file/schema**
- `apps/server/src/telemetry/collector.ts` — OTLP/HTTP ingest endpoint, network-scoped to sandboxes, auth token baked into sandbox OTEL env
- `apps/server/src/telemetry/normalize.ts` — OTLP metrics → usage rows
- `apps/server/src/telemetry/usage.repo.ts` — Drizzle queries for `usage` table (repository pattern, thin)
- `apps/server/src/telemetry/routes.ts` — `/api/usage` (totals + per-sandbox), session-gated
- `packages/shared/claude-adapters/usage-estimate.ts` — subscription-limit % estimation, returns `{percent, confidence, method}`
- `apps/web/src/components/UsageBar.tsx` — beacon fill on console track, IBM Plex Mono numerals
- `apps/web/src/screens/Usage.tsx` — simple totals screen
- `apps/server/src/telemetry/*.test.ts` — normalize fixtures, adapter fixtures, ingest auth rejection, no-prompt-fields assertion

## Task breakdown
1. **main thread** — `usage` table migration (schema decision, not delegated).
2. **implementer (opus)** — `collector.ts` + `normalize.ts` (hard problem: OTLP ingest, network-scoping + token auth, payload normalization).
3. **implementer (opus)** — `usage-estimate.ts` adapter (hard problem: undocumented subscription-limit estimation logic, isolated from the rest of the app).
4. **refactorer (sonnet)** — `/api/usage` route + `UsageBar` + `Usage` screen, consumes task 2/3 outputs.
5. **test-runner (haiku)** — runs tests written by implementer: normalize fixtures (recorded OTLP payloads), adapter fixture-based tests, ingest rejects unauthenticated requests.
6. **security-auditor (sonnet)** — `/security-check`, Telemetry domain: collector network-scoping, token auth, no prompt-content storage.

Order: 1 before 2; 2 and 3 can run in parallel; 4 after 2+3; 5 after 2+3; 6 last.

## Dependencies
- P2 (sandbox image bakes OTEL env: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, exporter pointed at collector, `sandbox.id`/`account.id` resource attrs).
- Parallel-safe with P3 and P4 (per README dependency graph).

## Risks & gotchas
- OTLP payload shape churns across Claude Code versions — mitigated by fixtures + adapter isolation in `usage-estimate.ts`; one adapter breaks, not the dashboard.
- Collector endpoint must never be reachable publicly — enforce with both network config AND the baked auth token, not either alone.
- Notional cost ("est. API value") must never be mistaken for real billing — labeling is a hard rule, verify copy in review, not just code.
- SQLite write volume from metrics — batch inserts, don't write per-event synchronously.
- Per-sandbox scoping missing from a query is a privacy bug even in single-user Tier 0 — design as if multi-user ships tomorrow.

## Done when
- A Claude session in a sandbox produces `usage` rows tagged with that sandbox's id.
- `/api/usage` returns correct totals and per-sandbox split.
- UI bar renders with the "estimated" label visible.
- Grep shows no prompt-content fields stored anywhere in the telemetry path.
- Collector rejects requests without the baked token.
- `security-auditor` passes the Telemetry section.
