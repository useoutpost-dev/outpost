# Security Checklist (enforced by security-auditor)

## Auth
- [ ] Every HTTP + WS route behind session check except /login, /health
- [ ] GitHub OAuth: state param verified; allowlist checked on every session, not just login
- [ ] Allowlist keyed on immutable GitHub user ID, never username (usernames can be re-registered)
- [ ] Session cookies: HttpOnly, Secure, SameSite=Lax
- [ ] Sessions expire; logout revokes server-side; session ID rotated after login
- [ ] Rate limiting on /login, WS connects, and sandbox create

## WebSocket / Terminal
- [ ] Validate Origin header on every WS upgrade (block cross-site WS hijacking)
- [ ] Max message size + backpressure on the PTY bridge (client can't flood server)
- [ ] Defined behavior for second tab attaching to same PTY (mirror or steal — never undefined)

## Sandboxes / Docker
- [ ] No host docker.sock mounted into sandboxes (DinD or microVM only)
- [ ] No privileged containers unless DinD requires it — then document + isolate
- [ ] Sandbox process runs as non-root; no-new-privileges; default seccomp; pids-limit set
- [ ] Resource limits (CPU/mem/disk) on every sandbox
- [ ] Sandbox network egress: no access to server's internal services except collector endpoint
- [ ] Reconciliation loop: orphaned provider machines (created but not in DB) get destroyed

## Credentials
- [ ] Credential reads/writes only in credentials module (grep proves it)
- [ ] API keys encrypted at rest; decrypted only at inject time
- [ ] Encryption key lives OUTSIDE the DB file (env/secret manager); documented for backups
- [ ] No credential material in logs, errors, telemetry, or client payloads
- [ ] Shared credential volume: single-refresher rule or lock on OAuth token refresh
- [ ] In-sandbox theft risk documented: code in a sandbox can read its mounted token.
      Per-sandbox credentials are the default; shared mode is opt-in with a warning.

## Proxy
- [ ] Preview routes auth-gated by default; public toggle is per-port and explicit
- [ ] No proxying to server-internal ports (collector, DB) — allowlist sandbox IPs only
- [ ] IP allowlist checked at connect time per request (DNS rebinding safe)
- [ ] Block redirects/requests to private ranges and cloud metadata (169.254.169.254)

## Telemetry
- [ ] OTEL_LOG_USER_PROMPTS never enabled
- [ ] Collector endpoint only reachable from sandbox network

## Open-core / Supply chain
- [ ] Pro install tokens: fine-grained, read-only, single-repo only
- [ ] `packages/shared/api` is semver'd; Pro packages pin to a major

## Compliance
- [ ] Run the 3 questions in compliance-boundaries skill on any account/auth/billing change
