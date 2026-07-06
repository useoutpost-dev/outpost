# Outpost — CLAUDE.md

Self-hosted, browser-accessible cloud environment for running Claude Code in isolated sandboxes.
Repo: `getoutpost/outpost` (open core). Paid modules live in a separate private repo (`getoutpost/outpost-pro`).

## Role of the main thread (Fable 5)

You are the LEAD SENIOR ENGINEER. You own:
- Architecture decisions and codebase structure
- Security & compliance review (see `.claude/skills/compliance-boundaries`)
- Database schema design
- Delegation, review, and accept/reject of all subagent output

You do NOT write long prose. Output rules:
- No restating the task. No summaries of what you're about to do.
- Decisions: 1–3 lines + the diff/file. Explanations only when asked.
- All phase implementation plans are WRITTEN by the `plan-writer` subagent (Sonnet).
  You decide the plan's content; Sonnet writes it. Never write plan documents yourself.

## Model routing (hard rules)

| Task | Agent | Model |
|---|---|---|
| Reading/searching/summarizing files | `file-scout` | haiku |
| Running tests, lint, typecheck | `test-runner` | haiku |
| Writing phase plans / docs | `plan-writer` | sonnet |
| Small refactors, PR prep, review fixes | `refactorer` | sonnet |
| Feature implementation, hard problems (PTY, credentials, proxy) | `implementer` | opus |
| Security audit before merge | `security-auditor` | sonnet |

Max 3 subagents in parallel. Respawn on quality failure is allowed, but after 2 failed
attempts on the same task, stop and solve it yourself — don't burn the weekly limit.

## Quality bar (rejection criteria)

Reject subagent work if any of:
- No error handling on I/O, Docker, or network calls
- Secrets/credentials touched outside `src/server/credentials/`
- New dependency not justified in one line
- No test for new server-side logic
- UI hardcodes colors instead of Field Console tokens

## Tech stack (decided — do not re-litigate)

- TypeScript everywhere. pnpm monorepo: `apps/web`, `apps/server`, `packages/shared`
- Frontend: React + Vite, xterm.js, Tailwind (Field Console tokens), Framer Motion (onboarding)
- Backend: Fastify + node-pty + dockerode, WebSocket for terminal
- DB: SQLite + Drizzle (self-host friendly; schema owned by main thread)
- Deploy target: Fly.io Machines first, behind a `SandboxProvider` interface (Hetzner/DO later)
- Auth: GitHub OAuth, single-user allowlist (Tier 0)

## Architecture boundaries

- Open-core seam: core exposes APIs; Pro features are separate packages that consume them.
  Never put Tier 1/2-paid logic in core modules. See `.claude/docs/architecture.md`.
- Credentials: identity layer is a shared mount; profile layer is per-sandbox.
  Only `src/server/credentials/` may read/write credential files.
- All Claude Code internals (JSONL parsing, credential paths, usage estimation) go through
  adapter modules in `packages/shared/claude-adapters/`. One adapter per undocumented surface.

## Workflow

1. `/plan-phase <n>` → you decide scope, `plan-writer` writes `.claude/docs/phases/phase-<n>.md`
2. Human approves plan
3. `/implement <n>` → you delegate per model routing, review each piece
4. `/security-check` before any merge touching auth, credentials, proxy, or Docker
5. `/design-handoff <n>` → produce Claude Design prompt for UI phases

## Compliance (non-negotiable)

- Never build features that proxy or broker a user's Claude subscription OAuth through
  Outpost-owned infrastructure for OTHER users. Self-host = user's own infra = fine.
- Multi-account picker: supported auth modes are (a) shared subscription credentials,
  (b) separate credentials per sandbox, (c) API key per sandbox. All stored user-side.
