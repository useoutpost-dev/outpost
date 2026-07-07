# Phase 3 — Terminal (Wire)

## Goal
Browser terminal to a sandbox that survives disconnects. The terminal is the product —
state lives on the server (design pattern 8), refresh must lose nothing.

## Deliverables
- [ ] Server-side PTY session registry, sessions outlive browser disconnects
- [ ] Scrollback ring buffer (~10k lines) replayed on reattach
- [ ] WebSocket bridge: auth-gated, binary frames for data, JSON control frames for resize/ping
- [ ] xterm.js terminal UI with fit addon and reconnect-with-backoff
- [ ] Mobile toolbar: sticky key row (Esc, Tab, Ctrl, arrows, /) that injects keys
- [ ] Multi-tab attach to one session (fan-out writes, last-resize-wins)
- [ ] Tests: reattach survival, scrollback replay, WS auth rejection, resize propagation

## Files to create/change
- `apps/server/src/terminal/session-manager.ts` — PTY session registry, scrollback buffer, reattach logic
- `apps/server/src/terminal/pty-bridge.ts` — exec into sandbox via provider exec/attach, node-pty semantics
- `apps/server/src/terminal/ws.ts` — WebSocket route, P1 session middleware auth gate, binary + JSON control frames
- `apps/web/src/screens/Terminal.tsx` — xterm.js, fit addon, reconnect-with-backoff, reconnecting UI state
- `apps/web/src/components/TermToolbar.tsx` — mobile sticky key row, iOS/Android soft keyboard support
- `apps/server/src/terminal/*.test.ts` — session survival, scrollback replay, auth rejection, resize tests

## Task breakdown
1. **implementer (opus)** — PTY session manager + WS bridge + survival/reattach (hard problem: node-pty semantics over WS, ring buffer, provider exec/attach). Includes writing the tests listed below.
2. **refactorer (sonnet)** — xterm.js UI (`Terminal.tsx`) + `TermToolbar.tsx` + reconnect UX, wired to the WS bridge from task 1.
3. **test-runner (haiku)** — runs the tests implementer wrote in task 1: session survives WS drop, scrollback replay, unauthenticated WS rejected, resize propagation.

Order: task 1 must land before task 2 (UI needs a real WS contract to build against).

## Dependencies
- P1 (auth) — WS upgrade must be gated by session middleware.
- P2 (sandbox lifecycle) — need a running sandbox to exec into.

## Risks & gotchas
- WS proxying through Fly edge has idle timeouts — need ping/pong keepalive on the control frame channel.
- Backpressure on fast output — decided: bounded buffer with drop-oldest policy, not pause/resume.
- Resize races with reattach — last-resize-wins must be enforced server-side, not client-side.
- Mobile soft-keyboard quirks — input composition events (IME) can double-fire keystrokes; test on real iOS/Android, not just devtools emulation.
- Multi-tab fan-out — writes from any tab go to the PTY; all attached tabs must receive the same output stream.

## Done when
- Run a long-lived command, kill the browser tab, reopen — session intact with scrollback.
- Two tabs mirror one session (same output, both can write).
- Unauthenticated WS upgrade is rejected with 401.
- Resize from the browser reflects in `tput cols` inside the sandbox.
- Toolbar keys (Esc, Tab, Ctrl, arrows, /) work on a phone browser.
