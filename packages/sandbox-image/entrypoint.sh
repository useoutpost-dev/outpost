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

# --- Identity layer: seed the Claude credential file (if provided) ---
# The server base64-encodes ONLY the credential file (never a whole ~/.claude
# share) and passes it as OUTPOST_CLAUDE_CREDENTIALS_B64. Decode it into
# /home/outpost/.claude/.credentials.json owned by outpost, 600 file / 700 dir.
# A bad decode must NOT brick the sandbox (set -e is active), so guard it and
# continue boot on failure. The value is never echoed.
if [ -n "${OUTPOST_CLAUDE_CREDENTIALS_B64:-}" ]; then
    CLAUDE_DIR=/home/outpost/.claude
    CRED_FILE="$CLAUDE_DIR/.credentials.json"
    mkdir -p "$CLAUDE_DIR"
    if printf '%s' "${OUTPOST_CLAUDE_CREDENTIALS_B64}" | base64 -d > "$CRED_FILE" 2>/dev/null; then
        chown outpost:outpost "$CLAUDE_DIR" "$CRED_FILE" 2>/dev/null || log "warn: could not chown Claude credential file"
        chmod 700 "$CLAUDE_DIR" || log "warn: could not chmod Claude credential dir"
        chmod 600 "$CRED_FILE" || log "warn: could not chmod Claude credential file"
        log "seeded Claude credential file"
    else
        log "warn: OUTPOST_CLAUDE_CREDENTIALS_B64 failed to decode; continuing without seeded credentials"
        rm -f "$CRED_FILE" 2>/dev/null || true
    fi
fi

# --- Terminal daemon (node-pty + ws) as the non-root `outpost` user ---
# Reachable only over Fly private networking on port 8022. It requires
# OUTPOST_TERMINAL_TOKEN and refuses to start without it. Sandboxes created
# before Phase 3 lack the token — those boot without a terminal (acceptable
# pre-GA) rather than failing the whole machine.
TERMINAL_DAEMON_PID=""
if [ -n "${OUTPOST_TERMINAL_TOKEN:-}" ]; then
    if [ -f /opt/terminal-daemon/server.js ]; then
        log "starting terminal daemon on :8022 (as outpost)"
        gosu outpost env \
            OUTPOST_TERMINAL_TOKEN="${OUTPOST_TERMINAL_TOKEN}" \
            HOME=/home/outpost \
            node /opt/terminal-daemon/server.js &
        TERMINAL_DAEMON_PID=$!
    else
        log "warn: terminal daemon not installed; skipping"
    fi
else
    log "OUTPOST_TERMINAL_TOKEN unset; terminal daemon not started"
fi

# --- Forward termination so dockerd (and the daemon) stop cleanly ---
shutdown() {
    log "shutting down"
    if [ -n "$TERMINAL_DAEMON_PID" ]; then
        kill -TERM "$TERMINAL_DAEMON_PID" 2>/dev/null || true
    fi
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
