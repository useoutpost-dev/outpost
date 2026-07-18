# Phase 3 — Terminal (Wire)

## Goal
Browser terminal to a sandbox that survives disconnects. State lives server/sandbox-side;
a browser refresh loses nothing.

## Deliverables
- [ ] `terminalToken` column + migration on `sandboxes` table (nullable text)
- [ ] `TerminalEndpoint` type + `terminalEndpoint()` method added to `SandboxProvider` interface; fake-provider stub updated
- [ ] Terminal daemon in `packages/sandbox-image/terminal-daemon/` — node-pty, ws, bearer-token auth (constant-time compare), replay buffer; PTY survives WS drops
- [ ] `packages/sandbox-image/Dockerfile` extended — build-stage tooling (python3/make/g++) for node-pty native compile; daemon installed; entrypoint starts daemon on port 8022 alongside dockerd
- [ ] `packages/sandbox-image/README.md` — daemon port/auth/token contract, bump notes
- [ ] `fly-provider.ts` — `terminalEndpoint()` impl using Fly 6PN DNS; per-sandbox token injected as `OUTPOST_TERMINAL_TOKEN` env at machine create
- [ ] `service.ts` — 256-bit random token generated at sandbox create; stored in `terminalToken` column; never appears in event payloads or logs
- [ ] `session-manager.ts` — upstream WS registry keyed by sandboxId; ring buffer ~10k lines drop-oldest; fan-out to all attached clients; last-resize-wins; upstream reconnect with exponential backoff; session survives last client detach
- [ ] `ws.ts` — `GET /api/sandboxes/:id/terminal` WS route via `@fastify/websocket`; 409 if sandbox not `running`; existing global `onRequest` auth hook gates upgrade (verified by test)
- [ ] Wire protocol on both hops: binary frames = raw bytes; text frames = JSON control (`resize`, `ping`/`pong`, `replay-end`); 25s keepalive ping; replay-then-`replay-end` on (re)connect
- [ ] `apps/server/src/__tests__/terminal.test.ts` + fake daemon helper: unauth upgrade → 401; session + scrollback survive disconnect/reattach; replay content correct; resize propagates upstream; last-resize-wins; multi-tab fan-out and fan-in; upstream reconnect repopulates buffer
- [ ] `Terminal.tsx` — xterm + fit addon, binary WS wiring, reconnect-with-backoff, visible reconnecting state, resize → control frame
- [ ] `TermToolbar.tsx` — sticky mobile key row (Esc, Tab, Ctrl modifier-latch, arrows, /); injects key sequences into terminal
- [ ] `AppShell.tsx` minimal update — sandbox list (GET /api/sandboxes) + Connect action opening Terminal.tsx; real manager UI deferred to Phase 6
- [ ] `apps/web/vite.config.ts` — `ws: true` on the `/api` dev proxy
- [ ] New deps justified: `@fastify/websocket` (only maintained first-party Fastify WS transport); `@xterm/xterm` + `@xterm/addon-fit` (decided stack, standard terminal emulator)
- [ ] grep gate: nothing Fly-shaped outside `apps/server/src/sandboxes/providers/fly/`
- [ ] security-auditor passes (auth + WS + image sections)

## Files to create/change
- `apps/server/src/db/schema.ts` (add `terminalToken` nullable text to `sandboxes`)
- `apps/server/drizzle/` (new migration for `terminalToken` column)
- `packages/shared/api/src/sandbox-provider.ts` (`TerminalEndpoint` type, `terminalEndpoint()` method; update index exports)
- `packages/sandbox-image/terminal-daemon/` (daemon source — new directory)
- `packages/sandbox-image/Dockerfile` (build stage for node-pty; daemon install; entrypoint update)
- `packages/sandbox-image/README.md` (daemon port/auth/bump notes)
- `apps/server/src/sandboxes/providers/fly/fly-provider.ts` (`terminalEndpoint()` impl; token env injection at create)
- `apps/server/src/sandboxes/service.ts` (token generation at create; pass token to provider; store in DB)
- `apps/server/src/terminal/session-manager.ts` (new file)
- `apps/server/src/terminal/ws.ts` (new file)
- `apps/server/src/index.ts` (register `@fastify/websocket`; register terminal WS route)
- `apps/server/src/__tests__/terminal.test.ts` (new file)
- `apps/server/src/__tests__/helpers.ts` (fake provider `terminalEndpoint`; in-process fake daemon WS server)
- `apps/web/src/screens/Terminal.tsx` (new file)
- `apps/web/src/components/TermToolbar.tsx` (new file)
- `apps/web/src/AppShell.tsx` (minimal sandbox list + Connect action)
- `apps/web/vite.config.ts` (`ws: true` on `/api` proxy)

## Task breakdown
1. Schema migration + shared interface — **MAIN THREAD**
   - Add `terminalToken` nullable text column to `schema.ts`; run `pnpm db:generate` for migration
   - Add `TerminalEndpoint` (`{ url: string }`) and `terminalEndpoint(id: string): Promise<TerminalEndpoint>` to `SandboxProvider` in `packages/shared/api/src/sandbox-provider.ts`; update index exports
   - Update fake provider stub in `apps/server/src/__tests__/helpers.ts` with a no-op / configurable `terminalEndpoint` impl
   - Lands first; fixes the contract both parallel tasks compile against

2. Sandbox-image terminal daemon — **implementer (opus)** (parallel with task 3)
   - `packages/sandbox-image/terminal-daemon/`: node-pty + ws daemon; spawns shell as `outpost` user in `/workspace`; listens on port 8022; rejects connections with wrong or missing bearer token (constant-time compare); owns its own replay buffer; PTY lifetime independent of any WS connection; resize via JSON control frame; replays buffer then sends `replay-end` on connect/reconnect
   - `packages/sandbox-image/Dockerfile`: add build stage (python3/make/g++) for node-pty native compile; match node ABI of runtime stage; install daemon; entrypoint starts daemon on port 8022 before yielding to dockerd
   - `packages/sandbox-image/README.md`: daemon port 8022, bearer-token auth contract, how to bump daemon version
   - Required: local `docker build` + ws-client smoke test — connect, run command, drop, reconnect, verify replay

3. Server terminal module — **implementer (opus)** (parallel with task 2)
   - `session-manager.ts`: registry keyed by sandboxId; dials daemon via `provider.terminalEndpoint()` + `Authorization: Bearer <terminalToken>` header; ring buffer ~10k lines bounded bytes, drop-oldest backpressure (no pause/resume); fan-out output to all attached client sockets; writes from any client forwarded to PTY; last-resize-wins enforced server-side; upstream reconnect exponential backoff; session persists when last client detaches
   - `ws.ts`: `GET /api/sandboxes/:id/terminal` registered via `@fastify/websocket`; 409 if sandbox not `running`; existing global `onRequest` hook gates upgrade — no PUBLIC_PATHS change; binary frames pass through; text frames parsed as JSON control
   - `fly-provider.ts`: implement `terminalEndpoint()` returning `ws://<machineId>.vm.<FLY_SANDBOX_APP>.internal:8022`; inject `OUTPOST_TERMINAL_TOKEN` env at machine create
   - `service.ts`: generate 256-bit random token at sandbox create; store in `terminalToken`; pass to provider; token never in event payloads or logs
   - `apps/server/src/index.ts`: register `@fastify/websocket` plugin; register terminal WS route in `buildApp()`
   - Tests written alongside (in-process fake daemon WS server in helpers.ts): unauth upgrade → 401; session + scrollback survive client disconnect/reattach; replay content correct; resize propagates upstream; last-resize-wins with two clients; multi-tab fan-out same output, both can write; upstream reconnect repopulates buffer

4. Web UI — **refactorer (sonnet)** (after task 3 merges locally)
   - `Terminal.tsx`: xterm + fit addon; binary WS wiring; reconnect-with-backoff; visible reconnecting state; resize observer → JSON resize control frame
   - `TermToolbar.tsx`: sticky mobile key row (Esc, Tab, Ctrl modifier-latch, arrows, /); injects key byte sequences into terminal; Field Console tokens only, zero hardcoded hex
   - `AppShell.tsx`: minimal sandbox list via GET /api/sandboxes; Connect action navigates to Terminal.tsx; real manager UI deferred to Phase 6
   - `vite.config.ts`: add `ws: true` to the `/api` dev proxy entry
   - Browser WS uses cookie auth (same-origin); no custom headers on browser hop; bearer header only on server→daemon hop

5. Full sweep — **test-runner (haiku)** (after task 4)
   - `pnpm install`, lint, typecheck, full test suite, web build; report any failure with exact error

6. Security audit — **security-auditor (sonnet)** (after task 5; mandatory)
   - Token handling: not in logs, not in event payloads, constant-time compare in daemon
   - WS auth gate actually fires on upgrade (test evidence required)
   - No public daemon exposure (port 8022 not in Fly services config)
   - grep gate: no Fly-shaped imports/types outside `apps/server/src/sandboxes/providers/fly/`
   - Dep audit: `@fastify/websocket`, `ws`, `@xterm/xterm`, `@xterm/addon-fit`

Execution order: 1 → (2 | 3) → 4 → 5 → 6. Max 3 parallel.

## Dependencies
- Phase 1 (auth) — global `onRequest` hook gates WS upgrade; `authorizeToken()` reusable; verify with a test that it fires on upgrade
- Phase 2 (sandbox lifecycle) — running Fly machine to dial; sandbox image to extend; `sandboxes` table and `service.ts` already exist
- Sandboxes created before this phase lack `terminalToken` → terminal returns 409/unavailable; acceptable pre-GA; document in code comment

## Risks & gotchas
- 6PN cross-app reachability assumes both apps are on the org default Fly network; verify at the pending live-Fly check (due 18 Jul); documented fallback is public-edge dial with `fly-force-instance-id` header + TLS if custom networks land in Phase 8
- node-pty native compile in slim image — build-stage tooling (python3/make/g++) required; daemon node ABI must match runtime stage node version
- Fly edge WS idle timeout — 25s ping/pong keepalive required on both hops
- Backpressure: bounded drop-oldest ring buffer; never unbounded queue
- Resize race on reattach — server-side last-resize-wins; do not trust client ordering
- Mobile IME double-fire — test on real iOS/Android devices, not devtools emulation
- Browser WS cannot set custom headers — cookie auth on browser↔server hop; bearer header only on server→daemon hop
- Multi-tab write fan-in is intentional — any tab writes to the PTY; all tabs receive same output
- Live-Fly terminal verification is impossible locally — folds into the pending live-Fly task (due 18 Jul)

## Done when
- Run a long-lived command, kill the browser tab, reopen — session intact with scrollback replayed
- Two tabs mirror one session: same output in both, both can type
- Unauthenticated WS upgrade to `/api/sandboxes/:id/terminal` is rejected with 401
- Resize from the browser reflects in `tput cols` inside the sandbox
- Toolbar keys (Esc, Tab, Ctrl, arrows, /) work on a phone browser
- Daemon port 8022 unreachable without the per-sandbox token; token absent from logs and event payloads
- All new server logic tested; full suite green via test-runner; grep gate passes
- security-auditor passes (auth + WS + image sections)
