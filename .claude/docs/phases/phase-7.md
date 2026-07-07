# Phase 7 — Onboarding & Field Console Polish

## Goal
First-run spotlight onboarding and a full Field Console token/typography pass across
every screen. No new capabilities.

## Deliverables
- [ ] `user_state` table migration (github_login, onboarding_step, completed)
- [ ] 4-step spotlight onboarding overlay (Framer Motion), skippable at every step,
      replayable from Settings, respects `prefers-reduced-motion`
- [ ] Onboarding progress persisted server-side; refresh mid-flow resumes the same step
- [ ] Settings screen: replay onboarding, account list (from P4), read-only allowlist
      display
- [ ] Token audit across Login, SandboxList, Terminal, Usage, Settings — zero hardcoded
      hex, one-beacon-per-screen enforced, correct typography roles
- [ ] Tests: step persistence across refresh, skip, replay, reduced-motion path,
      grep-test for hardcoded hex
- [ ] Note (not write): `/design-handoff` prompts per screen are produced by the main
      thread after this plan — list as a follow-up step, do not draft prompts here

## Files to create/change
- `apps/server/src/db/migrations/` — new `user_state` table migration
- `apps/server/src/routes/onboarding.ts` — new: get/set onboarding step
- `apps/server/src/db/user-state.repo.ts` — new repo
- `apps/web/src/onboarding/` — new: spotlight engine, 4 step components, reduced-motion
  fallback
- `apps/web/src/screens/Settings/` — new: replay control, account list, allowlist
  display
- `apps/web/src/screens/Login/`, `SandboxList/`, `Terminal/`, `Usage/` — token-pass
  edits only, no new components
- `apps/web/src/theme/tokens.ts` (or equivalent Tailwind theme file) — reference point
  for the grep-audit
- Font assets — bundle Clash Grotesk, Switzer, IBM Plex Mono locally (no CDN)
- Test files colocated per repo convention

## Task breakdown
1. `user_state` migration — **MAIN THREAD**
2. Onboarding overlay: spotlight engine + 4 steps + reduced-motion fallback —
   **refactorer (sonnet)**
3. Settings screen — **refactorer (sonnet)**
4. Token audit + fixes across Login, SandboxList, Terminal, Usage, Settings —
   **refactorer (sonnet)**
5. Tests: step persistence across refresh, skip, replay; grep-test for hardcoded hex —
   **test-runner (haiku)** runs
6. Main thread produces `/design-handoff` prompts per screen — follow-up, out of scope
   for this plan's execution

## Dependencies
- P3 (terminal), P4 (credentials/accounts), P5 (telemetry/usage), P6 (manager UI +
  proxy) — spotlights point at real UI from these phases; must exist first

## Risks & gotchas
- Spotlight positioning breaks on responsive layouts — anchor to element refs, recompute
  on resize, don't hardcode coordinates
- Framer Motion bundle size — import per-component, not the whole library
- Clash Grotesk licensing/self-hosting — bundle the font file, no CDN dependency
- `prefers-reduced-motion` path is easy to skip in testing — make it an explicit test
  case, not an afterthought
- Onboarding state must live server-side per design pattern 8 — don't let it leak into
  localStorage as the source of truth

## Done when
- Fresh allowlisted login lands in onboarding step 1
- Refresh mid-flow resumes the same step (server-side state proven)
- Skip works at every step; Settings replay restarts the full flow
- `prefers-reduced-motion` shows instant, non-animated steps with no spotlight sweep
- Grep finds zero hardcoded hex values in `apps/web/src`
- Every screen uses the three font roles correctly (Clash Grotesk headings, Switzer body,
  IBM Plex Mono for terminal + numerals)
- Every authenticated screen renders inside the single shared AppShell top bar
