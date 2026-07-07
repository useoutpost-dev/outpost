# Phase 0 — Scaffold

## Goal
pnpm monorepo boots end to end with CI, DB, and the provider seam defined.
No features.

## Deliverables
- [ ] pnpm workspace with `apps/web`, `apps/server`, `packages/shared` (`api/`, `claude-adapters/`), `packages/sandbox-image`
- [ ] Shared strict TypeScript config, ESLint + Prettier, Vitest per package
- [ ] GitHub Actions CI: install, lint, typecheck, test on push/PR
- [ ] `apps/server`: Fastify boots, `GET /health` returns `200 {ok:true}`
- [ ] Typed `OutpostError(code, httpStatus, safeMessage)` in `packages/shared/api`
- [ ] `apps/web`: React + Vite + Tailwind boots, empty basalt-background shell
- [ ] Field Console tokens + fonts defined once in Tailwind theme
- [ ] SQLite + Drizzle wired in `apps/server`, first migration creates `events` table
- [ ] `SandboxProvider` interface defined in `packages/shared/api` (no implementation)

## Files to create/change
- `pnpm-workspace.yaml`
- `package.json` (root, with `packageManager` pinned)
- `tsconfig.base.json`
- `.github/workflows/ci.yml`
- `apps/server/src/index.ts`
- `apps/server/src/db/client.ts`
- `apps/server/src/db/schema.ts`
- `apps/server/drizzle.config.ts`
- `apps/server/drizzle/` (migrations folder, first migration file)
- `packages/shared/api/src/index.ts`
- `packages/shared/api/src/errors.ts`
- `packages/shared/api/src/sandbox-provider.ts`
- `packages/shared/claude-adapters/src/index.ts` (empty barrel)
- `packages/sandbox-image/Dockerfile` (placeholder)
- `apps/web/vite.config.ts`
- `apps/web/tailwind.config.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/App.tsx`

## Task breakdown
1. Monorepo + tooling scaffold (workspace file, root package.json, tsconfig.base.json, ESLint/Prettier/Vitest config per package) — **refactorer (sonnet)**
2. Drizzle schema + first migration (`events` table: id, ts, kind, sandbox_id nullable, payload json) — **MAIN THREAD** (schema is main-thread-owned)
3. `SandboxProvider` interface (create/destroy/stop/exec/mount/ports, typed `Sandbox` status) + `OutpostError` in `packages/shared/api` — **refactorer (sonnet)**
4. Web shell + Tailwind tokens (basalt, console, bonewhite, ash, beacon, moss, rust; Clash Grotesk, Switzer, IBM Plex Mono — values from field-console-design skill) + shared AppShell top-bar component — **refactorer (sonnet)**
5. CI workflow (install, lint, typecheck, test) — **refactorer (sonnet)**
6. Verify: lint/typecheck/test/boot locally and confirm CI green — **test-runner (haiku)**

## Dependencies
None. This is the first phase.

## Risks & gotchas
- Windows dev machine vs Linux CI: watch path separators and script shebangs in package.json scripts.
- `better-sqlite3` native build may fail in CI — pin Node version and cache build, verify on Linux runner.
- Pin `packageManager` field in root `package.json` so pnpm version is consistent locally and in CI.
- Tokens must be defined once in `tailwind.config.ts` — no component may hardcode hex (quality-bar rejection criterion).

## Done when
- `pnpm install && pnpm -r lint && pnpm -r typecheck && pnpm -r test` pass locally and in CI
- `apps/server` `/health` returns `200 {ok:true}`
- `apps/web` dev server renders the basalt shell
- Drizzle migration applies cleanly and the `events` table exists in the SQLite file
- `SandboxProvider` type imports from `@outpost/shared-api` successfully in both `apps/web` and `apps/server`
