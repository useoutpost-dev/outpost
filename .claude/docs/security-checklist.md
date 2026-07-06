# Security Checklist (enforced by security-auditor)

## Auth
- [ ] Every HTTP + WS route behind session check except /login, /health
- [ ] GitHub OAuth: state param verified; allowlist checked on every session, not just login
- [ ] Session cookies: HttpOnly, Secure, SameSite=Lax

## Sandboxes / Docker
- [ ] No host docker.sock mounted into sandboxes (DinD or microVM only)
- [ ] No privileged containers unless DinD requires it — then document + isolate
- [ ] Resource limits (CPU/mem/disk) on every sandbox
- [ ] Sandbox network egress: no access to server's internal services except collector endpoint

## Credentials
- [ ] Credential reads/writes only in credentials module (grep proves it)
- [ ] API keys encrypted at rest; decrypted only at inject time
- [ ] No credential material in logs, errors, telemetry, or client payloads

## Proxy
- [ ] Preview routes auth-gated by default; public toggle is per-port and explicit
- [ ] No proxying to server-internal ports (collector, DB) — allowlist sandbox IPs only

## Telemetry
- [ ] OTEL_LOG_USER_PROMPTS never enabled
- [ ] Collector endpoint only reachable from sandbox network

## Compliance
- [ ] Run the 3 questions in compliance-boundaries skill on any account/auth/billing change
