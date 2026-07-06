---
name: telemetry-pipeline
description: Usage tracking pipeline — OTEL from sandboxes, storage, usage bar, per-model and per-sandbox breakdowns. Read before telemetry or usage-UI work.
---

# Telemetry Pipeline

## Flow
Sandbox image bakes in: CLAUDE_CODE_ENABLE_TELEMETRY=1, OTLP exporters pointed at the
server's collector endpoint, resource attr `sandbox.id=<id>` (+ `account.id`).
Collector ingest -> normalize -> SQLite tables (token usage, cost, model, sandbox, ts)
-> `/api/usage` -> UI.

## Products on top
- FREE core: usage bar (est. subscription usage %) + simple totals.
- PRO: per-model cost table, per-sandbox comparison, history, profile-vs-profile cost.

## Rules
- Cost for subscription accounts is NOTIONAL. Label "est. API value" in UI. Never imply billing.
- Subscription limit % is an ESTIMATE (parsed/reconstructed, no official API). Label it
  "estimated". Isolate ALL of it in `claude-adapters/usage-estimate.ts` — it WILL break
  on Claude Code updates; one adapter breaks, not the dashboard.
- Prompt-content logging stays OFF. Telemetry must never contain prompts, keys, or file contents.
- Per-sandbox scoping is a hard privacy boundary — design queries as if multi-user is coming.
