import { WebSocket, type RawData } from 'ws';
import { OutpostError } from '@outpost/shared-api';
import type { SandboxProvider } from '@outpost/shared-api';

/**
 * Server-side terminal session manager.
 *
 * One upstream WebSocket to the sandbox's terminal daemon per sandboxId, shared
 * by every attached browser client (multi-tab). The session (upstream socket +
 * scrollback ring buffer) outlives individual client detaches; it is only torn
 * down explicitly via destroy() when the sandbox stops/destroys.
 *
 * Wire protocol (identical on both hops):
 *   - binary frame  = raw terminal bytes
 *   - text frame    = JSON control ({"type":"resize"|"ping"|"pong"|"replay-end"|...})
 *
 * NOTE: terminal bytes and the bearer token are NEVER logged.
 */

/** ~2MB scrollback cap (≈10k lines). Drop-oldest when exceeded. */
const RING_MAX_BYTES = 2 * 1024 * 1024;

/** Upstream keepalive ping period. Fly edge idles WS at ~60s; 25s stays under it. */
const PING_INTERVAL_MS = 25_000;

/** Consecutive missed pongs before the upstream is considered dropped. */
const MAX_MISSED_PONGS = 2;

/** Reconnect backoff bounds (exponential, capped). */
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;

/** Max time attach() waits for the upstream replay-end before replaying the
 *  (possibly empty) ring anyway, so a stalled daemon never hangs an attach. */
const REPLAY_WAIT_MS = 5_000;

/** Minimal interface a client socket must satisfy. Both `ws` sockets and the
 *  socket handed over by @fastify/websocket implement this surface. */
export interface ClientSocket {
  readyState: number;
  send(data: string | Buffer): void;
  on(event: 'message', cb: (data: RawData, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  close(code?: number, reason?: string): void;
}

/** Dependencies injected so tests can supply a fake provider + timers. */
export interface SessionManagerDeps {
  provider: SandboxProvider;
  /** Resolve the per-sandbox bearer token from the DB. Null → terminal unavailable. */
  getTerminalToken(sandboxId: string): string | null;
  /** Structured logger (no terminal data / tokens ever passed in). */
  log?: { warn(msg: string): void; error(msg: string): void };
}

const OPEN = 1; // WebSocket.OPEN

interface Session {
  sandboxId: string;
  upstream: WebSocket | null;
  clients: Set<ClientSocket>;
  /** Bounded scrollback, oldest-first. */
  ring: Buffer[];
  ringBytes: number;
  /** Most recent resize control frame (JSON string) to replay after reconnect. */
  lastResize: string | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  missedPongs: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectDelay: number;
  /** True while we are (re)connecting and expect a fresh daemon replay that must
   *  repopulate the ring WITHOUT being re-forwarded to already-attached clients. */
  awaitingReplay: boolean;
  /** Resolves on the next upstream 'replay-end'. A fresh attach awaits this so the
   *  ring is populated before we replay scrollback to that client. */
  replayReady: Promise<void>;
  resolveReplayReady: () => void;
  destroyed: boolean;
}

export interface SessionManager {
  attach(sandboxId: string, client: ClientSocket): Promise<void>;
  destroy(sandboxId: string): void;
  destroyAll(): void;
  /** Test/introspection helper. */
  hasSession(sandboxId: string): boolean;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { provider, getTerminalToken } = deps;
  const log = deps.log ?? { warn: () => {}, error: () => {} };
  const sessions = new Map<string, Session>();

  function safeSend(sock: ClientSocket, data: string | Buffer): void {
    if (sock.readyState !== OPEN) return;
    try {
      sock.send(data);
    } catch (err) {
      // A single bad client must never take down the fan-out loop.
      log.warn(`terminal: client send failed: ${errMsg(err)}`);
    }
  }

  function sendControl(sock: ClientSocket, obj: Record<string, unknown>): void {
    safeSend(sock, JSON.stringify(obj));
  }

  function pushRing(session: Session, chunk: Buffer): void {
    session.ring.push(chunk);
    session.ringBytes += chunk.length;
    while (session.ringBytes > RING_MAX_BYTES && session.ring.length > 0) {
      const dropped = session.ring.shift()!;
      session.ringBytes -= dropped.length;
    }
  }

  function resetRing(session: Session): void {
    session.ring = [];
    session.ringBytes = 0;
  }

  /** Fan a daemon binary frame out to every attached client. */
  function fanOut(session: Session, chunk: Buffer): void {
    for (const client of session.clients) {
      safeSend(client, chunk);
    }
  }

  function clearTimers(session: Session): void {
    if (session.pingTimer) {
      clearInterval(session.pingTimer);
      session.pingTimer = null;
    }
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
  }

  function startKeepalive(session: Session): void {
    if (session.pingTimer) clearInterval(session.pingTimer);
    session.missedPongs = 0;
    session.pingTimer = setInterval(() => {
      const up = session.upstream;
      if (!up || up.readyState !== OPEN) return;
      session.missedPongs += 1;
      if (session.missedPongs > MAX_MISSED_PONGS) {
        // Treat as dropped: terminate triggers the 'close' handler → reconnect.
        try {
          up.terminate();
        } catch (err) {
          log.warn(`terminal: upstream terminate failed: ${errMsg(err)}`);
        }
        return;
      }
      try {
        up.send(JSON.stringify({ type: 'ping' }));
      } catch (err) {
        log.warn(`terminal: upstream ping failed: ${errMsg(err)}`);
      }
    }, PING_INTERVAL_MS);
  }

  /** Parse a text control frame; malformed frames are ignored (never crash). */
  function parseControl(raw: string): { type?: string } | null {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') return obj as { type?: string };
      return null;
    } catch {
      return null;
    }
  }

  function handleUpstreamMessage(session: Session, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      const chunk = toBuffer(data);
      pushRing(session, chunk);
      // During a (re)connect the daemon replays scrollback. On the FIRST connect
      // there are no clients-with-history, so fan-out below is harmless. After a
      // reconnect, already-attached clients already have this content locally, so
      // we repopulate the ring (done above) but must NOT re-forward the replay to
      // them. `awaitingReplay` stays true until 'replay-end' arrives.
      if (!session.awaitingReplay) {
        fanOut(session, chunk);
      }
      return;
    }

    const ctrl = parseControl(data.toString());
    if (!ctrl) return; // malformed control frame: ignore
    switch (ctrl.type) {
      case 'pong':
        session.missedPongs = 0;
        break;
      case 'replay-end':
        // Replay finished: resume live fan-out and release any attach() awaiting
        // a populated ring.
        session.awaitingReplay = false;
        session.resolveReplayReady();
        break;
      default:
        // Unknown control from daemon: ignore.
        break;
    }
  }

  function scheduleReconnect(session: Session): void {
    if (session.destroyed) return;
    if (session.clients.size === 0) {
      // No clients need the stream; keep the session but do not spin reconnects.
      // A later attach() will re-dial.
      return;
    }
    if (session.reconnectTimer) return;
    const delay = session.reconnectDelay;
    session.reconnectDelay = Math.min(session.reconnectDelay * 2, RECONNECT_MAX_MS);
    for (const client of session.clients) {
      sendControl(client, { type: 'upstream', state: 'reconnecting' });
    }
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      connectUpstream(session).catch((err) => {
        log.warn(`terminal: reconnect dial failed: ${errMsg(err)}`);
        scheduleReconnect(session);
      });
    }, delay);
  }

  async function connectUpstream(session: Session): Promise<void> {
    if (session.destroyed) return;

    const token = getTerminalToken(session.sandboxId);
    if (!token) {
      throw new OutpostError('CONFLICT', 409, 'terminal unavailable');
    }
    const endpoint = await provider.terminalEndpoint(session.sandboxId);

    // Reconnect replay must repopulate the ring from scratch, not append to stale
    // scrollback. Reset here so the incoming replay fully defines the buffer.
    resetRing(session);
    session.awaitingReplay = true;
    // Arm a fresh replay-ready gate for this dial so a concurrent attach waits
    // for THIS connection's replay-end.
    session.replayReady = new Promise<void>((resolve) => {
      session.resolveReplayReady = resolve;
    });

    const up = new WebSocket(endpoint.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    session.upstream = up;

    up.on('open', () => {
      if (session.destroyed) {
        try {
          up.close();
        } catch {
          /* ignore */
        }
        return;
      }
      session.reconnectDelay = RECONNECT_MIN_MS;
      startKeepalive(session);
      for (const client of session.clients) {
        sendControl(client, { type: 'upstream', state: 'connected' });
      }
      // Re-send the most recent resize so the daemon's PTY matches the client
      // viewport after a reconnect (last-resize-wins).
      if (session.lastResize) {
        try {
          up.send(session.lastResize);
        } catch (err) {
          log.warn(`terminal: resize replay failed: ${errMsg(err)}`);
        }
      }
    });

    up.on('message', (data: RawData, isBinary: boolean) => {
      try {
        handleUpstreamMessage(session, data, isBinary);
      } catch (err) {
        log.warn(`terminal: upstream message handling failed: ${errMsg(err)}`);
      }
    });

    up.on('error', (err: Error) => {
      log.warn(`terminal: upstream socket error: ${errMsg(err)}`);
    });

    up.on('close', () => {
      if (session.upstream === up) session.upstream = null;
      clearTimers(session);
      if (session.destroyed) return;
      scheduleReconnect(session);
    });
  }

  function wireClient(session: Session, client: ClientSocket): void {
    client.on('message', (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          // Any tab may write to the PTY.
          const up = session.upstream;
          if (up && up.readyState === OPEN) up.send(toBuffer(data));
          return;
        }
        const ctrl = parseControl(data.toString());
        if (!ctrl) return; // malformed: ignore
        if (ctrl.type === 'ping') {
          sendControl(client, { type: 'pong' });
          return;
        }
        if (ctrl.type === 'resize') {
          // last-resize-wins: forward in arrival order, remember the latest to
          // re-send after an upstream reconnect.
          const frame = data.toString();
          session.lastResize = frame;
          const up = session.upstream;
          if (up && up.readyState === OPEN) up.send(frame);
          return;
        }
        // Unknown control from client: ignore.
      } catch (err) {
        log.warn(`terminal: client message handling failed: ${errMsg(err)}`);
      }
    });

    client.on('error', (err: Error) => {
      log.warn(`terminal: client socket error: ${errMsg(err)}`);
    });

    client.on('close', () => {
      session.clients.delete(client);
      // Session intentionally survives the last client detach: upstream + ring
      // stay alive so a later reattach replays scrollback.
    });
  }

  /** Replay current scrollback to a single freshly-attached client, then mark
   *  the end of replay for that client. */
  function replayTo(session: Session, client: ClientSocket): void {
    for (const chunk of session.ring) {
      safeSend(client, chunk);
    }
    sendControl(client, { type: 'replay-end' });
  }

  async function attach(sandboxId: string, client: ClientSocket): Promise<void> {
    const existing = sessions.get(sandboxId);
    let session: Session;
    if (!existing) {
      let resolveReady: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      session = {
        sandboxId,
        upstream: null,
        clients: new Set(),
        ring: [],
        ringBytes: 0,
        lastResize: null,
        pingTimer: null,
        missedPongs: 0,
        reconnectTimer: null,
        reconnectDelay: RECONNECT_MIN_MS,
        awaitingReplay: false,
        replayReady: ready,
        resolveReplayReady: resolveReady,
        destroyed: false,
      };
      sessions.set(sandboxId, session);
      try {
        await connectUpstream(session);
      } catch (err) {
        sessions.delete(sandboxId);
        throw err;
      }
    } else {
      session = existing;
      if (!session.upstream && !session.reconnectTimer) {
        // Upstream was idle (all clients had detached); re-dial before replaying.
        const s = session;
        connectUpstream(s).catch((err) => {
          log.warn(`terminal: re-dial on attach failed: ${errMsg(err)}`);
          scheduleReconnect(s);
        });
      }
    }

    // Wire client-side handlers immediately (writes/resize can flow up now), but
    // do NOT add it to the fan-out set until after replay to avoid duplicating
    // live frames that are also present in the ring.
    wireClient(session, client);

    // Wait for the upstream's replay-end so the ring holds current scrollback,
    // then replay it to THIS client (a browser refresh loses nothing). Guarded
    // by a timeout so a stalled daemon never hangs the attach — the client still
    // gets a replay-end boundary and live output as it arrives.
    await Promise.race([session.replayReady, delay(REPLAY_WAIT_MS)]);
    if (session.destroyed) return;
    replayTo(session, client);
    // Now join live fan-out. Frames arriving after this point are appended in
    // order after the replayed scrollback.
    session.clients.add(client);
  }

  function destroy(sandboxId: string): void {
    const session = sessions.get(sandboxId);
    if (!session) return;
    session.destroyed = true;
    clearTimers(session);
    if (session.upstream) {
      try {
        session.upstream.close();
      } catch (err) {
        log.warn(`terminal: upstream close failed: ${errMsg(err)}`);
      }
      session.upstream = null;
    }
    for (const client of session.clients) {
      try {
        client.close(1000, 'sandbox terminated');
      } catch (err) {
        log.warn(`terminal: client close failed: ${errMsg(err)}`);
      }
    }
    session.clients.clear();
    sessions.delete(sandboxId);
  }

  function destroyAll(): void {
    for (const id of Array.from(sessions.keys())) destroy(id);
  }

  return {
    attach,
    destroy,
    destroyAll,
    hasSession: (id) => sessions.has(id),
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => (Buffer.isBuffer(d) ? d : Buffer.from(d))));
  return Buffer.from(data as ArrayBuffer);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
