# Phase 1 — Auth gate (Gatehouse)

## Goal
GitHub OAuth with a single-user allowlist; every route gated; minimal login screen.

## Deliverables
- [ ] GitHub OAuth flow with verified `state` param
- [ ] Session create/lookup/expiry, stored in SQLite (`sessions` table)
- [ ] Global preHandler gates every HTTP + WS route except `/login`, `/auth/callback`, `/health`
- [ ] Allowlist (`OUTPOST_ALLOWED_GITHUB_LOGINS`) checked on every session validation, not just login
- [ ] Auth events (login, denied, logout) appended to `events` table
- [ ] Minimal login screen in `apps/web` using Field Console tokens only
- [ ] Web session guard: check on app load, redirect to login on 401
- [ ] Route + unit tests covering 401 paths, state mismatch, allowlist deny
- [ ] `/security-check` passed (Auth section)

## Files to create/change
- `apps/server/src/auth/github.ts` (OAuth flow, state param generation + verification)
- `apps/server/src/auth/session.ts` (session create/lookup/expiry)
- `apps/server/src/auth/middleware.ts` (global preHandler)
- `apps/server/src/auth/auth.repo.ts` (Drizzle queries)
- `apps/server/src/auth/routes.ts` (zod-validated thin handlers)
- `apps/server/src/db/schema.ts` (add `sessions` table)
- `apps/server/drizzle/` (new migration for `sessions` table)
- `apps/web/src/routes/Login.tsx` (or equivalent login screen component)
- `apps/web/src/lib/session.ts` (client-side session check + redirect)

## Task breakdown
1. `sessions` table migration (id, github_login, created_at, expires_at) — **MAIN THREAD**
2. OAuth flow + session module + global middleware, including cookie flags (HttpOnly, Secure, SameSite=Lax) and allowlist check on every session validation — **implementer (opus; security-critical)**
3. Login screen + web session guard (basalt background, console card, one beacon CTA "Continue with GitHub") — **refactorer (sonnet)**
4. Unit + route tests (401 paths, state mismatch, allowlist deny) written by implementer, executed by — **test-runner (haiku)**
5. `/security-check` against Auth section of security checklist — **security-auditor (sonnet)**, mandatory for this domain

## Dependencies
Phase 0 (monorepo, DB, Fastify, web shell, tokens must exist).

## Risks & gotchas
- OAuth callback URL differs between local and deployed — must be env-driven, not hardcoded.
- Cookie `Secure` flag breaks plain-HTTP local dev — allow override only behind a dev-only env flag, never in prod code path.
- Empty allowlist locks everyone out — fail loud at server boot if `OUTPOST_ALLOWED_GITHUB_LOGINS` is unset or empty.
- Allowlist must be re-checked on every session validation, not cached from login time, per security checklist.
- Every HTTP and WS route must be covered by the preHandler except the three explicit exceptions — easy to miss a route group.

## Done when
- Unauthenticated API request returns `401`
- Full OAuth roundtrip with an allowlisted GitHub login sets a session cookie with correct flags (HttpOnly, Secure, SameSite=Lax)
- A non-allowlisted GitHub user is denied and a `denied` event is logged
- A mismatched `state` param is rejected
- security-auditor passes the Auth section of `.claude/docs/security-checklist.md`
