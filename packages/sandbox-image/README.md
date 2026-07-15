# Outpost sandbox image

The container image Fly machines run for a sandbox. Each sandbox is a Fly machine
running this image with a persistent `/workspace` volume. The server references the
built image via the `OUTPOST_SANDBOX_IMAGE` env var; Phase 3 execs Claude Code
sessions into a running container.

Contents: Node LTS (`node:22-bookworm-slim`), `git`, the Claude Code CLI
(`@anthropic-ai/claude-code`, pinned), and a full Docker Engine (`docker-ce`) so
tools inside the sandbox can run their own containers — this is Docker-in-Docker
(DinD).

## Pinned versions

| Component | Version | Where |
|---|---|---|
| Claude Code CLI | `2.1.208` | `ARG CLAUDE_CODE_VERSION` in `Dockerfile` |
| Docker Engine (docker-ce) | `27.x` (major pinned) | `ARG DOCKER_CE_MAJOR` in `Dockerfile` |

### Bumping the Claude Code CLI

1. Find the target version: `npm view @anthropic-ai/claude-code version`.
2. Update `ARG CLAUDE_CODE_VERSION=<x.y.z>` in `Dockerfile` (one-line change).
3. Rebuild and push the image (see below).
4. Update the `OUTPOST_SANDBOX_IMAGE` env var on the **server** app to the new tag.
   New sandbox machines pick up the new image on next create; existing machines
   keep their pinned image until recreated.

## Docker-in-Docker and privileged mode

The image installs the Docker Engine and starts `dockerd` from the entrypoint.
It does **not** and must **never** mount or reference the host
`/var/run/docker.sock` — that would give a sandbox control over the host's Docker
and every other container. Sandboxes get their own nested daemon instead.

Running `dockerd` needs kernel capabilities that a default *container* does not
have (nested `containerd`, `iptables`/NAT rules, mount/cgroup management). On Fly
no special flag is required for this: **Fly Machines are Firecracker microVMs, not
containers**. The image is unpacked into the VM's root filesystem and the
entrypoint runs with full root in its own kernel, so `dockerd` has everything it
needs. The Machines API has no `privileged` field — there is nothing to set. This
is the same pattern as Fly's own remote builders, which run a Docker daemon inside
a machine.

Why root-in-VM is acceptable for Phase 2: sandboxes run in a **separate Fly app**
(`FLY_SANDBOX_APP`) from the server app. Fly's private 6PN network is per-app, so
a root-capable sandbox VM has **no 6PN network path to the server** or its
internal services. The blast radius of a compromised sandbox is limited to the
sandbox app. Full per-machine egress lockdown is deferred to Phase 8.

### Privilege model inside the container

The entrypoint runs as **root** only to start `dockerd` and chown the runtime
`/workspace` volume, then **drops to the non-root `outpost` user** (member of the
`docker` group) for the long-lived workspace process. This is "non-root where DinD
allows": the daemon needs root, the workspace shell does not.

## Telemetry env

- `CLAUDE_CODE_ENABLE_TELEMETRY=1` is baked into the image.
- `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_RESOURCE_ATTRIBUTES` are **not** baked —
  the server injects them at machine-create time (`OTEL_RESOURCE_ATTRIBUTES`
  carries `sandbox.id` + `account.id`).
- User-prompt logging is never enabled; that telemetry flag is deliberately absent
  from the image, entrypoint, and this document.

## Build and push

Registry: **`ghcr.io/useoutpost-dev/outpost-sandbox`**.

```sh
# From packages/sandbox-image/
docker build -t ghcr.io/useoutpost-dev/outpost-sandbox:latest .

# Tag with the Claude Code CLI version for traceability (recommended):
docker build \
  -t ghcr.io/useoutpost-dev/outpost-sandbox:cc-2.1.208 \
  -t ghcr.io/useoutpost-dev/outpost-sandbox:latest .

# Push (requires a GHCR login: `docker login ghcr.io`):
docker push ghcr.io/useoutpost-dev/outpost-sandbox:cc-2.1.208
docker push ghcr.io/useoutpost-dev/outpost-sandbox:latest
```

Then set `OUTPOST_SANDBOX_IMAGE` on the server app to the pushed tag.

## Deployment: two Fly apps

Outpost runs **two** Fly apps:

1. **Server app** — the Outpost server; deployed normally with a `fly.toml` /
   `fly deploy`. Holds `OUTPOST_SANDBOX_IMAGE` and `FLY_SANDBOX_APP`.
2. **Sandbox app** (`FLY_SANDBOX_APP`) — where sandbox machines live. It has **no
   `fly deploy` config of its own**: sandbox machines are created
   **programmatically by the server** via the Fly Machines API using this image.
   There is nothing to `fly deploy` here — the app is a container for
   server-managed machines and volumes.

This is a build artifact, not a deployable Fly service: `docker build` + push to
GHCR, then point the server at the tag.
