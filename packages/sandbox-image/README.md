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

## Identity layer: Claude credential seeding

The server may seed a single Claude Code OAuth credential file into the sandbox
at boot. This is the **identity layer** — only the credential file crosses the
boundary; session data, transcripts, and settings stay per-sandbox (the whole
`~/.claude` directory is **never** shared, or usage attribution and transcripts
would bleed between sandboxes).

- **Env var:** `OUTPOST_CLAUDE_CREDENTIALS_B64` — base64-encoded content of the
  credential file. If unset/empty, nothing is seeded and Claude Code prompts for
  login on first use.
- **Target path:** `/home/outpost/.claude/.credentials.json` (Claude Code runs as
  the non-root `outpost` user with `HOME=/home/outpost`; on macOS *hosts* Claude
  Code uses the Keychain instead, but sandboxes are Linux so this file is
  authoritative).
- **Permissions:** the file is `chown outpost:outpost`, `chmod 600`; its parent
  `~/.claude` dir is `chmod 700`.
- **Fail-open:** a decode failure logs a warning and boot continues (the sandbox
  is never bricked by bad credentials). The env value is never echoed or logged.

The path and file format are owned exclusively by
`packages/shared/claude-adapters/src/credentials.ts`; the entrypoint only decodes
and places the bytes.

## Terminal daemon (port 8022)

The image ships a small in-sandbox WebSocket terminal daemon
(`terminal-daemon/`, node-pty + ws). The Outpost server dials it over Fly
private networking; browsers never reach it directly. It is **not** published on
any public edge — `EXPOSE` is intentionally unset for 8022.

- **Listen:** `0.0.0.0:8022` (WS). Reachable only over Fly 6PN.
- **Auth:** every WS upgrade must carry `Authorization: Bearer <token>` matching
  the `OUTPOST_TERMINAL_TOKEN` env (a per-sandbox 256-bit token the server
  injects at machine create). Compared in constant time
  (`crypto.timingSafeEqual` over equal-length SHA-256 digests). A missing/wrong
  token is rejected with `401` and the socket is closed. If
  `OUTPOST_TERMINAL_TOKEN` is unset/empty the daemon **refuses to start**
  (fail-loud); the entrypoint then boots the sandbox without a terminal
  (acceptable for pre-Phase-3 sandboxes).
- **Process identity:** the daemon and the PTY shell both run as the non-root
  `outpost` user (never root). The entrypoint launches it with `gosu outpost`.
- **One PTY per sandbox:** a single login shell (`bash -l`, `TERM=xterm-256color`,
  cwd `/workspace`). Its lifetime is independent of any WS connection — it
  survives socket drops and is respawned on the next connect if it exited.
- **One upstream connection at a time:** a new authenticated connection replaces
  the previous one (the old socket is closed). Fan-out to multiple browser tabs
  is the server's job, not the daemon's.
- **Replay buffer:** a bounded (~2 MB, drop-oldest) ring buffer of PTY output.
  On every (re)connection the daemon replays the buffer as binary frames, then
  sends a `{"type":"replay-end"}` text frame.

### Wire protocol

| Frame | Direction | Meaning |
|---|---|---|
| binary | client → daemon | bytes written to the PTY |
| binary | daemon → client | raw PTY output |
| text `{"type":"resize","cols":N,"rows":N}` | client → daemon | resize the PTY |
| text `{"type":"ping"}` | client → daemon | daemon replies `{"type":"pong"}` |
| text `{"type":"replay-end"}` | daemon → client | end of scrollback replay |
| text `{"type":"ping"}` | daemon → client | keepalive every 25 s |
| text `{"type":"pong"}` | client → daemon | answers the daemon's keepalive |

The daemon drops the socket after 2 unanswered keepalive pings. Malformed
control frames are ignored (never fatal). The token and terminal data are
**never** logged.

### Dependencies (only two, compiled/bundled in the image)

- **`node-pty`** — allocates the PTY and the login shell. No pure-JS substitute
  exists; native compile is required.
- **`ws`** — the WebSocket server. Fastify's WS transport is server-side only;
  the daemon is a standalone Node process, so it uses `ws` directly (matching
  the server's `ws@^8.18`).

The daemon is **plain CommonJS JavaScript** (no TypeScript build step): it keeps
the image build free of a TS toolchain, and the logic units (ring buffer,
control-frame parser, token compare) are covered by `node --test`.

### Bumping / rebuilding the daemon

1. Edit sources under `terminal-daemon/` (bump dep versions in
   `terminal-daemon/package.json` if needed).
2. Run the unit tests: `cd terminal-daemon && node --test`.
3. Rebuild the image (see **Build and push** below). The `daemon-build` stage
   recompiles `node-pty` against node 22; the runtime stage copies the result.
4. Smoke-test locally:
   ```sh
   docker build -t outpost-sandbox:local .
   docker run --rm --privileged \
     -e OUTPOST_TERMINAL_TOKEN=testtoken -p 8022:8022 outpost-sandbox:local
   # in another shell, from terminal-daemon/ (after `npm install`):
   OUTPOST_TERMINAL_TOKEN=testtoken node test/smoke-client.js
   ```

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
