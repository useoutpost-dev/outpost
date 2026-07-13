# Phase 2 — Sandbox lifecycle (Quartermaster)

## Goal
Implement sandbox create/stop/destroy on Fly.io via a thin fetch-based client,
behind the existing `SandboxProvider` interface, with a persistent `/workspace` volume per sandbox.

## Deliverables
- [ ] `sandboxes` table + migration (`id`, `name` unique, `provider`, `providerRef`, `volumeRef`, `accountId` nullable, `status`, `createdAt`, `updatedAt`)
- [ ] `fly-client.ts` — fetch-based Fly Machines API client, injectable fetcher, typed `OutpostError` on every call
- [ ] `fly-provider.ts` — implements `SandboxProvider`; volume provisioning, resource limits, backoff polling, create-failure cleanup, boot reconciliation sweep
- [ ] `packages/sandbox-image/Dockerfile` — Claude Code CLI (pinned), DinD, node, git; non-root where DinD allows
- [ ] `packages/sandbox-image/README.md` — pinned version + bump procedure; DinD privileged justification
- [ ] Baked OTEL env: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, exporter endpoint env-driven, resource attrs `sandbox.id` + `account.id` injected at create via `OTEL_RESOURCE_ATTRIBUTES`
- [ ] `OTEL_LOG_USER_PROMPTS` never set anywhere in image or provider
- [ ] `service.ts` — state machine (creating → running → stopped → destroyed; error from any state); illegal transitions → `OutpostError` 409; every transition writes DB + `events` row
- [ ] `sandboxes.repo.ts` — Drizzle queries (insert, updateStatus, findById, list)
- [ ] `routes.ts` — zod-thin handlers: POST /api/sandboxes, GET /api/sandboxes, GET /api/sandboxes/:id, POST /api/sandboxes/:id/stop, DELETE /api/sandboxes/:id
- [ ] Env contract: `FLY_API_TOKEN`, `FLY_SANDBOX_APP`, `FLY_REGION`, `OUTPOST_SANDBOX_IMAGE`, `OUTPOST_COLLECTOR_ENDPOINT` — validated fail-loud in `loadBootConfig()` at boot, same as the Phase 1 env contract
- [ ] Tests: fly-client against stubbed fetcher; service state transitions + event rows against fake provider + `makeTestDb`; route 401/validation paths
- [ ] Boot reconciliation: orphan machines in sandbox Fly app destroyed before routes accept traffic
- [ ] `grep` gate: no Fly-specific imports or types outside `apps/server/src/sandboxes/providers/fly/`
- [ ] `/security-check` passed (Sandboxes/Docker section)

## Files to create/change
- `apps/server/src/db/schema.ts` (add `sandboxes` table)
- `apps/server/drizzle/` (new migration for `sandboxes` table)
- `apps/server/src/sandboxes/providers/fly/fly-client.ts`
- `apps/server/src/sandboxes/providers/fly/fly-provider.ts`
- `apps/server/src/sandboxes/service.ts`
- `apps/server/src/sandboxes/sandboxes.repo.ts`
- `apps/server/src/sandboxes/routes.ts`
- `apps/server/src/index.ts` (register sandbox routes + boot reconciliation call in `buildApp()`)
- `apps/server/src/__tests__/sandboxes.test.ts`
- `packages/sandbox-image/Dockerfile`
- `packages/sandbox-image/README.md`

## Task breakdown
1. `sandboxes` table migration — **MAIN THREAD**
   - Add to `schema.ts`: `id` text PK (app-generated), `name` text notNull unique, `provider` text notNull ('fly'), `providerRef` text nullable, `volumeRef` text nullable, `accountId` text nullable, `status` text notNull, `createdAt` + `updatedAt` timestamp_ms notNull
   - Run `pnpm db:generate` to emit migration

2. Fly client + provider — **implementer (opus)**
   - `fly-client.ts`: thin fetch wrapper for Fly Machines API (`https://api.machines.dev/v1`), injectable `Fetcher` type (same pattern as Phase 1 GitHub OAuth client), typed errors (`PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`); Fly response bodies never surface in `safeMessage`
   - `fly-provider.ts`: create = provision volume → create machine (volume at `/workspace`, guest cpus/memoryMb from `SandboxResources`, env = OTEL + injected resource attrs) → exponential backoff poll for running status (cap total wait, then OutpostError); any create failure destroys machine (if created) then deletes volume (if created) before surfacing error; destroy = destroy machine → delete volume; stop = stop machine
   - Sandboxes run in a SEPARATE Fly app (`FLY_SANDBOX_APP`) from the server — machines in one Fly app share a private 6PN network, so a separate app is what guarantees sandboxes have no network path to the server's internal services (security checklist: sandbox egress). Full per-machine egress lockdown deferred to Phase 8.
   - Boot reconciliation in `fly-provider.ts` or adjacent module: `list()` against Fly app → destroy any machine (+ volume) with no matching `sandboxes` row; emit one `events` row per orphan; must complete before routes registered
   - Nothing Fly-shaped (types, URLs, field names) outside this directory

3. Sandbox image — **implementer (opus)**
   - `packages/sandbox-image/Dockerfile`: Claude Code CLI at pinned version, node, git, dockerd (DinD — NOT a host docker.sock mount); non-root user where DinD allows; `CLAUDE_CODE_ENABLE_TELEMETRY=1` baked; `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_RESOURCE_ATTRIBUTES` left as env vars (injected at create); `OTEL_LOG_USER_PROMPTS` never appears
   - `packages/sandbox-image/README.md`: pinned CLI version, bump procedure (update Dockerfile ARG, rebuild, push, update `OUTPOST_SANDBOX_IMAGE`), DinD privileged requirement justification

4. Service + repo + routes — **refactorer (sonnet)** (parallel with tasks 2–3; depends only on the `SandboxProvider` interface)
   - `sandboxes.repo.ts`: insert, updateStatus (sets `updatedAt`), findById, list; Drizzle only
   - `service.ts`: state machine guard (reject illegal transitions with `OutpostError` 409); every allowed transition calls repo.updateStatus AND inserts `events` row (kinds: `sandbox.creating`, `sandbox.running`, `sandbox.stopped`, `sandbox.destroyed`, `sandbox.error`; `sandboxId` set; `payload = { provider, providerRef }` — no secrets); depends on `SandboxProvider` interface + repo only
   - `routes.ts`: `registerSandboxRoutes(app, deps)` registered in `buildApp()`; zod schemas on request bodies; POST validates `{name, resources?}` (server-side defaults for resources); no business logic in handlers; auth gate is automatic (no PUBLIC_PATHS change needed)
   - Add `zod` as server dep if not already present (justified: runtime boundary validation on request bodies)
   - Extend `loadBootConfig()` in `apps/server/src/index.ts` with the five sandbox env vars (`FLY_API_TOKEN`, `FLY_SANDBOX_APP`, `FLY_REGION`, `OUTPOST_SANDBOX_IMAGE`, `OUTPOST_COLLECTOR_ENDPOINT`) — fail loud at boot when unset/empty

5. Tests — **test-runner (haiku)** (written alongside each task, sweep after tasks 2–4)
   - Fly client: stubbed fetcher, assert headers/bodies, assert `OutpostError` codes on non-2xx
   - Service: state transition happy paths + illegal transition 409; event rows inserted per transition; fake provider + `makeTestDb()`
   - Routes: 401 on unauthenticated; 400 on invalid body; 404 on unknown sandbox id; happy-path create returns 201 with `id`

6. Security check — **security-auditor (sonnet)** (mandatory; runs after tasks 2–5)
   - Sandboxes/Docker section of `.claude/docs/security-checklist.md`
   - Confirms: no host docker.sock; `OTEL_LOG_USER_PROMPTS` absent; Fly types isolated; orphan sweep runs before traffic; no secrets in event payloads; sandboxes isolated in their own Fly app (egress line)

Execution order: task 1 first → tasks 2, 3, 4 in parallel (max 3 subagents) → task 5 sweep → task 6.

## Dependencies
- Phase 0: monorepo, DB connection, `SandboxProvider` interface (already merged)
- Phase 1: auth hook — all sandbox routes auto-gated by existing `onRequest` preHandler; `req.githubId` available in handlers

## Risks & gotchas
- DinD requires privileged mode on Fly — document why in `packages/sandbox-image/README.md`; never mount host `docker.sock`; isolate justification per security checklist
- Fly Machines API is eventually consistent — poll with exponential backoff; never hot-loop; cap total wait time before failing with `OutpostError`
- Failed create can orphan a volume — cleanup path required: destroy machine first, then delete volume; surface error only after cleanup attempt
- Claude Code CLI version must be pinned in the Dockerfile, with a documented bump procedure
- Separate Fly app decision means two apps to deploy — add a deployment note; ops doc or deploy script update needed
- Fly volumes are region-pinned — machine and volume must be created in the same `FLY_REGION`; mismatched region causes silent failure at start
- Boot reconciliation must complete before routes accept traffic — run the sweep before `registerSandboxRoutes` in `buildApp()`; a race with a concurrent create would double-destroy a live machine
- Local dev requires `FLY_API_TOKEN`, `FLY_SANDBOX_APP`, `FLY_REGION`, `OUTPOST_SANDBOX_IMAGE`, `OUTPOST_COLLECTOR_ENDPOINT` to be set (or boot fails loud) — add to `.env.example` if it exists

## Done when
- `POST /api/sandboxes` creates a running Fly machine with a `/workspace` volume and explicit CPU/mem/disk limits
- Stop and destroy work and update `status` correctly; destroy removes the volume
- `events` rows exist for every lifecycle transition
- Boot reconciliation destroys a machine that exists in the Fly app but not in the DB
- No host `docker.sock` anywhere; `OTEL_LOG_USER_PROMPTS` never set anywhere
- `grep` shows no Fly-specific imports/types outside `apps/server/src/sandboxes/providers/fly/`
- All new server logic has tests; suite green via test-runner
- security-auditor passes the Sandboxes/Docker section of `.claude/docs/security-checklist.md`
