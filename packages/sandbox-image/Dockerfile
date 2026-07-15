# Outpost sandbox image — Claude Code CLI + Docker-in-Docker.
# Fly machines run this image (server env OUTPOST_SANDBOX_IMAGE points at it).
#
# Structure: entrypoint starts dockerd (needs root inside the machine VM), then
# drops to the non-root `outpost` user for the long-lived workspace process.
# This is DinD — the host /var/run/docker.sock is NEVER mounted or referenced.

FROM node:22-bookworm-slim

# --- Pinned versions (bumps are a one-line change) ---
# Claude Code CLI: found via `npm view @anthropic-ai/claude-code version`.
ARG CLAUDE_CODE_VERSION=2.1.208
# Docker Engine major version (docker-ce apt package, pinned to 27.x).
ARG DOCKER_CE_MAJOR=27

# --- Base tooling: git, ca-certs, gosu (privilege drop), curl/gnupg for docker repo ---
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        gosu \
        iptables \
        openssh-client \
        procps; \
    rm -rf /var/lib/apt/lists/*

# --- Docker Engine (docker-ce) inside the image for DinD ---
# Installs the docker-ce package pinned to the DOCKER_CE_MAJOR series so dockerd
# can run nested containers from within this sandbox.
RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg \
        -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    ARCH="$(dpkg --print-architecture)"; \
    CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"; \
    echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${CODENAME} stable" \
        > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    DOCKER_PKG_VERSION="$(apt-cache madison docker-ce \
        | awk -v maj="${DOCKER_CE_MAJOR}" '$3 ~ ("^5:" maj "\\.") {print $3; exit}')"; \
    test -n "${DOCKER_PKG_VERSION}"; \
    apt-get install -y --no-install-recommends \
        docker-ce="${DOCKER_PKG_VERSION}" \
        docker-ce-cli="${DOCKER_PKG_VERSION}" \
        containerd.io \
        docker-buildx-plugin; \
    rm -rf /var/lib/apt/lists/*

# --- Claude Code CLI at the pinned exact version ---
RUN set -eux; \
    npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    npm cache clean --force

# --- Non-root workspace user, member of the docker group ---
# The node base image owns uid 1000 via its `node` user; remove it so `outpost`
# gets uid 1000 and the runtime Fly volume chown is deterministic.
RUN set -eux; \
    userdel -r node; \
    groupadd --system docker 2>/dev/null || true; \
    useradd --create-home --uid 1000 --gid docker --shell /bin/bash outpost

# Telemetry on; endpoint + resource attrs are injected at machine-create time.
# OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_RESOURCE_ATTRIBUTES are intentionally unset.
ENV CLAUDE_CODE_ENABLE_TELEMETRY=1

# Fly volume mounts here at runtime; entrypoint chowns it to `outpost`.
WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Entrypoint runs as root to start dockerd, then drops to `outpost`.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
