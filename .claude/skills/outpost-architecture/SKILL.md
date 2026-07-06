---
name: outpost-architecture
description: System architecture of Outpost — components, boundaries, data flow, provider abstraction. Read before any structural change or new module.
---

# Outpost Architecture

## Components
- **Gatehouse** (`apps/server/src/auth`) — GitHub OAuth, single-user allowlist, session cookies.
- **Quartermaster** (`apps/server/src/sandboxes`) — sandbox lifecycle via `SandboxProvider`
  interface. First impl: Fly.io Machines. Docker-in-Docker inside each sandbox.
- **Wire** (`apps/server/src/terminal`) — node-pty in sandbox <-> WebSocket <-> xterm.js.
  Sessions survive browser disconnect (server-side PTY keeps running; reattach on reconnect).
- **Credentials** (`apps/server/src/credentials`) — the ONLY module allowed to touch
  Claude auth files. See credential-layer skill.
- **Lookout** (`apps/server/src/telemetry`) — OTEL collector ingest -> SQLite -> usage API.
- **Preview proxy** (`apps/server/src/proxy`) — routes `https://<sandbox>-<port>.<domain>`
  to sandbox ports. Auth-gated by default; per-port public toggle.
- **Web** (`apps/web`) — React. Screens: Login, Onboarding, Sandbox list, Terminal,
  Usage, Settings/Profiles.

## Rules
1. Every sandbox provider behind `SandboxProvider` (create/destroy/exec/mount/ports).
   No Fly-specific code outside `providers/fly/`.
2. Open-core seam: core exports typed APIs (`packages/shared/api`). Pro modules
   (manager UI extras, profile lab, deep analytics) are separate packages in the private
   repo that consume these APIs. Core never imports Pro.
3. All undocumented Claude Code surfaces (credential paths, JSONL transcripts, usage
   estimation) live in `packages/shared/claude-adapters/`, one file per surface, so a
   Claude Code update breaks one adapter, not the app.
4. DB schema changes: main thread only. Migrations via Drizzle, committed with the feature.

## Data flow (usage)
sandbox (OTEL env baked in) -> collector endpoint on server -> SQLite (per-sandbox
resource attrs) -> `/api/usage` -> UI bars. Prompt-content logging OFF always.
