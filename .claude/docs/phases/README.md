# Phases

Fable decides each plan; `plan-writer` (Sonnet) writes it via `/plan-phase <n>`.
Stubs below define scope. Full plans are generated files: `phase-<n>.md`.

## Dependency graph
```
P0 scaffold
 └─ P1 auth ──────────────┐
 └─ P2 sandbox lifecycle ─┼─ P3 terminal ─ P4 credentials/accounts ─┐
                          │                                         ├─ P7 onboarding+polish
                          ├─ P5 telemetry+usage ────────────────────┤
                          └─ P6 manager UI + preview proxy ─────────┘
P8 hardening+buffer (last)
```
Parallel-safe pairs after P2: (P3 | P5), then (P4 | P6).

## Timeline target: ~6 weeks
- W1–2: P0–P3 (Tier 0 core)
- W3: P4–P5
- W4: P6
- W5: P7
- W6: P8 buffer

## Stubs
- **P0 — Scaffold**: pnpm monorepo, CI, lint/test/typecheck, empty apps boot, SQLite+Drizzle wired, `SandboxProvider` interface defined.
- **P1 — Auth gate**: GitHub OAuth, allowlist, sessions, login screen (minimal, tokens only).
- **P2 — Sandbox lifecycle**: Fly provider impl, sandbox image (Claude Code + DinD + baked OTEL), create/stop/destroy, persistence volume, events log.
- **P3 — Terminal**: node-pty in sandbox, WS bridge, xterm.js UI, session survival + reattach, mobile keyboard basics.
- **P4 — Credentials & accounts**: accounts table, credential volumes, API-key encryption + env inject, account picker on sandbox create, shared-vs-separate modes. Heavy security-audit phase.
- **P5 — Telemetry & usage**: collector ingest, SQLite usage tables, usage bar (est. %), totals API + UI.
- **P6 — Manager + proxy**: sandbox manager UI (list, status, actions), preview proxy with per-port public toggle, activity feed from events table.
- **P7 — Onboarding & Field Console polish**: 4-step spotlight onboarding (Framer Motion, skippable), full token pass on all screens, `/design-handoff` per screen.
- **P8 — Hardening**: full security checklist sweep, resource-limit tuning, refresh-race overnight test (5 sandboxes/1 volume), docs for self-hosters.

## Per-phase ritual
1. `/plan-phase n` -> human approves
2. `/implement n`
3. `/review-pr` -> `/security-check` (if flagged domain) -> merge
