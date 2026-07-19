# Known Limitations

Accepted risks and deployment caveats, grouped by phase. Each entry states the limitation,
why it is accepted, and the mitigation in place.

---

## Secrets as machine environment variables (Phase 4 / Phase 5)

### `OUTPOST_MASTER_KEY`

**What:** The server reads `OUTPOST_MASTER_KEY` from the Fly machine environment. Anyone
with Fly machine-config or API access for this app can read the value.

**Why accepted:** Tier 0 is single-user self-host. The user owns the Fly org and machine.
The risk profile is the same as any server secret stored in Fly secrets.

**Mitigation:** Rotate via `fly secrets set OUTPOST_MASTER_KEY=<new>` and restart. All
encrypted API keys in the DB must be re-encrypted after rotation (out of scope for Phase 4;
document backup guidance separately).

---

### `OTEL_EXPORTER_OTLP_HEADERS` (collector token)

**What:** Every sandbox receives `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>`
as a machine environment variable, sourced from `OUTPOST_COLLECTOR_TOKEN`. The token is
visible to anyone with Fly machine-config access, and to processes running inside the
sandbox.

**Why accepted:** Same risk class as `OUTPOST_MASTER_KEY` — single-user self-host, user
owns the infra. The token is not a credential for Claude or Anthropic services.

**Mitigation:** The token grants only write access to the `POST /v1/metrics` collector
endpoint — nothing else. Rotate by restarting the app with a new value of
`OUTPOST_COLLECTOR_TOKEN`. A compromised token lets an attacker write junk usage rows;
it does not expose sandbox contents, credentials, or session data.

---

## Collector endpoint network exposure (Phase 5)

**What:** `POST /v1/metrics` is exempt from session auth. It is protected only by a Bearer
token (`OUTPOST_COLLECTOR_TOKEN`). A misconfigured deployment could expose this endpoint
on the public app URL.

**Why accepted:** On a correctly deployed Fly app, sandboxes reach the collector over the
Fly private network (6PN, `fdaa::/8`). The public-facing listener never needs to expose
this path.

**Mitigation:** Keep the endpoint reachable only over the Fly private network. Token auth
is defense-in-depth, not a substitute for network isolation — both controls must be present.
Do not remove token auth even if you are confident the network is private.

---

## Master key rotation (Phase 4)

**What:** There is no automated re-encryption path when `OUTPOST_MASTER_KEY` changes. All
stored API keys become unrecoverable after a key rotation until they are re-entered.

**Why accepted:** Out of scope for Phase 4. Single-user Tier 0 installs can re-add accounts
manually after a rotation event.

**Mitigation:** Back up `OUTPOST_MASTER_KEY` offline before rotating. Treat key loss the
same as losing a password manager master password.

---

## Preview wildcard TLS and DNS (Phase 6)

**What:** Preview URLs require wildcard DNS and a matching wildcard TLS certificate for
`*.OUTPOST_PREVIEW_DOMAIN`; setting the environment variable does not provision either.

**Why accepted:** DNS and certificate ownership are deployment-specific and remain under
the self-hosting operator's control.

**Mitigation:** Configure the wildcard DNS record and certificate before enabling the
preview domain. Keep the proxy disabled when either is unavailable.

---

## Live Fly preview HMR (Phase 6)

**What:** HTTP and WebSocket proxy behavior is covered locally, but framework HMR over a
live Fly deployment has not been validated end to end and may depend on framework-specific
host, origin, or secure-WebSocket settings.

**Why accepted:** Live Fly validation requires deployed infrastructure and application-
specific dev-server configuration outside the Phase 6 test harness.

**Mitigation:** Treat HMR as best-effort until verified on the target Fly deployment; use
a full page reload or configure the dev server's public host and WSS settings if needed.

---

## Preview grants are process-local (Phase 6)

**What:** Private-preview exchange codes and cookies are held in bounded server memory.
They expire after five minutes and are invalidated by a server restart. A multi-replica
server deployment would require sticky routing or a shared grant store.

**Why accepted:** Tier 0 is a single-user, single-server self-hosted deployment. Keeping
the short-lived grants out of the database also avoids persisting bearer material.

**Mitigation:** Run one Outpost server replica. Reopen the private preview from the manager
after a restart; the manager will mint a new audience-bound one-time exchange URL.
