# Architecture Overview

See `.claude/skills/outpost-architecture/SKILL.md` for the component map. This file adds
the repo layout and the open-core seam.

## Monorepo layout (pnpm)
```
outpost/
  apps/
    web/          React + Vite (Field Console UI)
    server/       Fastify: auth, sandboxes, terminal WS, credentials, telemetry, proxy
  packages/
    shared/
      api/              typed API contracts (the open-core seam)
      claude-adapters/  ALL undocumented Claude Code surfaces live here
    sandbox-image/      Dockerfile + baked OTEL config for the Claude Code sandbox
  .claude/        this kit
```

## Open-core seam
Core (this repo) exposes `packages/shared/api`. The private Pro repo ships packages that
import ONLY that seam: `@outpost/pro-analytics`, `@outpost/pro-profile-lab`,
`@outpost/pro-manager`. The web app loads Pro UI modules if installed, else hides entries.
Core must build, test, and run with zero Pro packages present.

## Key decisions (locked)
1. SQLite over Postgres — single-binary self-hosting beats scale we don't have.
2. WebSocket PTY with server-side session survival — the terminal is the product.
3. Provider interface from day one — Fly first, but never Fly-shaped code in core.
4. Adapters for every Claude Code internal — updates break one file.
5. API keys via env injection, subscriptions via volume mounts — never keys on sandbox disk.
