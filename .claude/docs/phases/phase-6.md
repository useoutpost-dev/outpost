# Phase 6 — Manager UI + Preview Proxy

## Goal
Run the fleet from the browser: list/status/actions on sandboxes, an activity feed, and a
preview proxy so apps running inside a sandbox are reachable at a subdomain URL.

## Deliverables
- [ ] `ports` table migration (sandbox_id, port, public boolean)
- [ ] Preview proxy: wildcard subdomain routing to sandbox private IP:port
- [ ] Proxy auth gate (session cookie) with per-port public toggle
- [ ] WebSocket passthrough on the proxy (HMR-compatible)
- [ ] Hard-deny list for server-internal targets (collector, DB, server itself)
- [ ] SandboxList screen: rows (name, status chip, account label, last activity),
      actions (open terminal, stop, destroy with confirm), create button opens P4
      account-picker flow
- [ ] ActivityFeed component, paginated, newest first
- [ ] `/api/events` route + `events.repo.ts`
- [ ] Manager UI ships list/status/actions only in core; Pro extras (bulk ops, profile
      lab) gated behind `proModules` registry, zero Pro logic in core
- [ ] Tests: proxy auth-gate, public toggle, internal-port deny, subdomain parse
- [ ] `/security-check` passed on the Proxy section

## Files to create/change
- `apps/server/src/db/migrations/` — new `ports` table migration
- `apps/server/src/proxy/` — new: subdomain router, auth gate, public-toggle lookup,
  WS passthrough, internal-target denylist
- `apps/server/src/routes/events.ts` — new `/api/events` route
- `apps/server/src/db/events.repo.ts` — new repo (events table exists since P0)
- `apps/server/src/db/ports.repo.ts` — new repo for the `ports` table
- `apps/web/src/screens/SandboxList/` — new: list screen, row component, actions,
  create-button wiring into P4 account picker
- `apps/web/src/components/ActivityFeed/` — new
- `packages/shared/api/` — add typed contracts for events + ports if not present
- Test files colocated per repo convention (`*.test.ts` next to source)

## Task breakdown
1. `ports` table migration — **MAIN THREAD**
2. Preview proxy: subdomain routing, auth gate, public toggle, WS passthrough,
   internal-target deny — **implementer (opus)** — hard problem, do first since UI and
   security review depend on it
3. SandboxList + ActivityFeed + actions wiring — **refactorer (sonnet)**
4. `/api/events` route + `events.repo.ts` — **refactorer (sonnet)**
5. Tests: proxy auth-gate, public toggle, internal-port deny, subdomain parse —
   **test-runner (haiku)** runs the suite written alongside task 2
6. `/security-check` — **security-auditor (sonnet)** — MANDATORY, proxy domain flagged
   in security-checklist.md

## Dependencies
- P2 (sandbox lifecycle) — needed for sandbox private IPs and lifecycle actions
- P1 (auth) — needed for session-cookie gating
- Parallel-safe with P4 per phases README

## Risks & gotchas
- Wildcard TLS cert + DNS for `<sandbox>-<port>.<domain>` needs Fly cert setup —
  document the steps, don't assume it's automatic
- SSRF risk via crafted subdomain or spoofed Host header — parse strictly, allowlist
  sandbox private IPs only, never trust Host header alone for routing decisions
- Public toggle must default OFF and require an explicit action to flip per port
- WS passthrough can silently break HMR — test against a real Vite dev server inside
  a sandbox, not a mock
- Keep Pro manager features (bulk ops, profile lab) out of core; check via
  `proModules.has(...)`, never inline license checks

## Done when
- Sandbox list reflects live statuses; open terminal, stop, and destroy-with-confirm
  all work
- Activity feed shows lifecycle + auth events, paginated, newest first
- A Vite dev server on port 5173 inside a sandbox is reachable at its preview URL only
  when logged in
- Toggling public makes that port reachable while logged out; other ports on the same
  sandbox remain gated
- Requests resolving to collector/DB/server-internal targets are refused
- `security-auditor` passes the Proxy section of security-checklist.md
