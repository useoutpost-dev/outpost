# Design Patterns (project conventions)

1. **Provider pattern** — `SandboxProvider` interface; concrete impls in `providers/<name>/`.
2. **Adapter pattern** — one file per undocumented Claude Code surface in
   `claude-adapters/`. Adapters expose stable types; internals may churn.
3. **Repository pattern (thin)** — Drizzle queries live in `*.repo.ts` per domain.
   Route handlers never touch the DB directly.
4. **Command handlers** — server routes are thin: validate (zod) -> call domain fn ->
   map errors. Domain fns are pure-ish and unit-tested.
5. **Event log** — sandbox lifecycle + auth events appended to an `events` table.
   Powers the activity feed (Tier 1) for free.
6. **Errors** — typed `OutpostError(code, httpStatus, safeMessage)`. Never leak internals
   or paths to the client.
7. **Feature flags for Pro** — UI checks `proModules.has('analytics')`, no license logic
   in core. Pro packages self-register.
8. **State on the server** — the browser is a viewport. Terminal sessions, sandbox state,
   onboarding progress all live server-side; refresh must lose nothing.
