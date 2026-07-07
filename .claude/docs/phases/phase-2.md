# Phase 2 — Sandbox lifecycle (Quartermaster)

## Goal
Create/stop/destroy real sandboxes on Fly.io behind `SandboxProvider`, with a
persistent volume and a sandbox image.

## Deliverables
- [ ] `packages/sandbox-image` Dockerfile: Claude Code CLI, Docker-in-Docker, node, git
- [ ] Baked OTEL env in the image (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP exporter env-driven, resource attrs `sandbox.id` + `account.id` injected at create)
- [ ] Prompt-content logging never enabled (`OTEL_LOG_USER_PROMPTS` never set)
- [ ] `apps/server/src/sandboxes/providers/fly/fly-provider.ts` — all Fly Machines API code, nothing Fly-shaped outside this path
- [ ] `service.ts` — domain logic: create/stop/destroy, state transitions
- [ ] `sandboxes.repo.ts` — Drizzle queries
- [ ] `routes.ts` — zod-thin, auth-gated handlers
- [ ] `sandboxes` table + migration
- [ ] One persistent volume per sandbox mounted at `/workspace`
- [ ] Resource limits (CPU/mem/disk) set at create — hard requirement
- [ ] Every lifecycle transition appended to `events` table
- [ ] Typed `OutpostError` on every Fly API + network call
- [ ] `/security-check` passed (Sandboxes/Docker section)

## Files to create/change
- `packages/sandbox-image/Dockerfile`
- `packages/sandbox-image/otel-config` (or equivalent baked config file)
- `apps/server/src/sandboxes/providers/fly/fly-provider.ts`
- `apps/server/src/sandboxes/service.ts`
- `apps/server/src/sandboxes/sandboxes.repo.ts`
- `apps/server/src/sandboxes/routes.ts`
- `apps/server/src/db/schema.ts` (add `sandboxes` table)
- `apps/server/drizzle/` (new migration for `sandboxes` table)

## Task breakdown
1. `sandboxes` table migration (id, name, provider, provider_ref, account_id nullable, status, created_at) — **MAIN THREAD**
2. Fly provider implementation: create/destroy/stop/exec/mount/ports against Fly Machines API, volume provisioning, resource limits, status polling — **implementer (opus; hard problem: Docker/network)**
3. Sandbox image Dockerfile + baked OTEL config (env-driven exporter endpoint, injected resource attrs) — **implementer (opus)**
4. `service.ts` (state transitions, event-log writes) + `sandboxes.repo.ts` + `routes.ts` (zod-thin, auth-gated) — **refactorer (sonnet)**
5. Tests: Fly provider mocked, service state-transition tests — written alongside implementation, executed by **test-runner (haiku)**
6. `/security-check` against Sandboxes/Docker section — **security-auditor (sonnet)**, mandatory for this domain

## Dependencies
Phase 0 (monorepo, DB, `SandboxProvider` interface).
Phase 1 (routes must be auth-gated).

## Risks & gotchas
- DinD requires privileged mode on Fly — document why, and isolate it per security checklist; no host `docker.sock` mount, ever.
- Fly Machines API has rate limits and eventually-consistent status — poll with backoff, don't hot-loop.
- Failed create can orphan a volume — cleanup path required on any create failure.
- Claude Code CLI version must be pinned in the image, with a documented bump procedure.
- Sandbox network egress must be restricted to the collector endpoint only — no path to server-internal services.

## Done when
- `POST /api/sandboxes` creates a running Fly machine with a volume and resource limits
- Stop and destroy work and update `status` correctly
- Destroy removes the volume
- `events` rows exist for every lifecycle transition
- No host `docker.sock` mounted anywhere in the sandbox
- `grep` shows no Fly-specific imports outside `providers/fly/`
- security-auditor passes the Sandboxes/Docker section of `.claude/docs/security-checklist.md`
