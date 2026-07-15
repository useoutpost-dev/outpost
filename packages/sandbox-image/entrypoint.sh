#!/usr/bin/env bash
# Outpost sandbox entrypoint.
# Runs as root: starts Docker-in-Docker (dockerd), fixes the runtime /workspace
# volume ownership, then drops to the non-root `outpost` user for the long-lived
# process. The container stays alive when idle so Phase 3 can exec Claude Code
# sessions into it. The host docker.sock is never mounted or referenced.
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# --- /workspace ownership ---
# The Fly volume appears at runtime, so chown here (not at build time).
if [ -d /workspace ]; then
    chown outpost:docker /workspace || log "warn: could not chown /workspace"
fi

# --- Start dockerd (DinD) in the background ---
# Requires root inside the machine. A Fly Machine is a Firecracker microVM, so
# root here has full VM capabilities; no privileged flag exists or is needed.
log "starting dockerd"
dockerd >/var/log/dockerd.log 2>&1 &
DOCKERD_PID=$!

# --- Wait for the Docker daemon to accept connections ---
DOCKER_READY=0
for _ in $(seq 1 30); do
    if ! kill -0 "$DOCKERD_PID" 2>/dev/null; then
        log "dockerd exited during startup; see /var/log/dockerd.log"
        tail -n 40 /var/log/dockerd.log >&2 || true
        exit 1
    fi
    if docker info >/dev/null 2>&1; then
        DOCKER_READY=1
        break
    fi
    sleep 1
done

if [ "$DOCKER_READY" -ne 1 ]; then
    log "dockerd did not become ready in time; see /var/log/dockerd.log"
    tail -n 40 /var/log/dockerd.log >&2 || true
    exit 1
fi
log "dockerd ready"

# --- Forward termination so dockerd stops cleanly ---
shutdown() {
    log "shutting down"
    kill -TERM "$DOCKERD_PID" 2>/dev/null || true
    wait "$DOCKERD_PID" 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

# --- Drop to non-root `outpost` and run the long-lived process ---
# If args were passed, run them as `outpost`; otherwise idle so the sandbox
# stays alive for exec'd sessions.
if [ "$#" -gt 0 ]; then
    log "running as outpost: $*"
    gosu outpost "$@" &
else
    log "idle; ready for exec'd sessions"
    gosu outpost sleep infinity &
fi
CHILD_PID=$!

# Wait on the foreground child; keep dockerd running underneath it.
wait "$CHILD_PID"
