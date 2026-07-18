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
