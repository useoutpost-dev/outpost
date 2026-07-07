# Outpost

Self-hosted, browser-accessible cloud environment for running [Claude Code](https://claude.com/claude-code) in isolated sandboxes.

Spin up disposable, isolated Docker sandboxes — each with its own Claude Code setup — and drive them from a real terminal in your browser. Snapshot, compare, and destroy different `.claude/` configurations side by side.

> **Status: pre-alpha.** The build plan is in place (`.claude/docs/phases/`); implementation has not started. Nothing here is runnable yet.

## Why Outpost

- **Config experimentation** — run multiple Claude Code profiles (agents, skills, commands, MCP setups) in parallel sandboxes and compare results.
- **Your infra, your credentials** — single-user, self-hosted. You bring your own Claude subscription or API key. Nothing is proxied through anyone else's servers.
- **Real terminal, anywhere** — xterm.js over a WebSocket PTY bridge. Sessions survive browser refreshes.

## How it works

```
Browser (React + xterm.js)
   │  WebSocket
Server (Fastify) ── auth · sandbox lifecycle · credential injection · telemetry · preview proxy
   │  SandboxProvider interface
Sandboxes (Fly.io Machines / Docker) ── genuine `claude` CLI in isolated containers
```

- **Frontend:** React + Vite, Tailwind, xterm.js
- **Backend:** Fastify, node-pty, dockerode, WebSocket
- **DB:** SQLite + Drizzle (single-binary self-hosting)
- **Auth:** GitHub OAuth, single-user allowlist
- **Sandboxes:** Fly.io Machines first; other providers behind the `SandboxProvider` interface

## Repo layout

```
apps/
  web/          Field Console UI
  server/       API, terminal bridge, sandbox lifecycle
packages/
  shared/api/            typed contracts (the open-core seam)
  shared/claude-adapters/ adapters for Claude Code internals
  sandbox-image/          sandbox Dockerfile + OTEL config
.claude/        agents, skills, commands, and phase plans used to build this repo
```

## Open core

This repo (Tier 0) is fully open source and works standalone. Paid modules (usage analytics, profile lab, multi-account manager) live in a separate private repo and plug into `packages/shared/api`. Core builds, tests, and runs with zero Pro packages installed.

## Security & compliance

- Sandboxes never get the host Docker socket. Resource limits on every sandbox.
- API keys are encrypted at rest and injected as env vars only at start; subscription credentials stay on user-controlled volumes.
- Outpost never brokers your Claude subscription through third-party infrastructure — self-host means your own machines, your own credentials.

See `.claude/docs/security-checklist.md`.

## Roadmap

9 phases, ~6 weeks: scaffold → auth → sandbox lifecycle → terminal → credentials/accounts → telemetry → manager UI + preview proxy → onboarding → hardening. Details in `.claude/docs/phases/`.

## License

TBD (core will ship under an OSI-approved license).
