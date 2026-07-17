'use strict';

// Outpost in-sandbox terminal daemon.
//
// One PTY (login shell) per sandbox, whose lifetime is independent of any
// WebSocket connection. A single upstream WS connection at a time (the server
// fans out to browser tabs). Bearer-token auth on the HTTP upgrade with a
// constant-time compare. Bounded drop-oldest replay buffer replayed on every
// (re)connect, terminated by a {"type":"replay-end"} text frame.
//
// Wire protocol:
//   binary frame  client -> daemon : bytes written to the PTY
//   binary frame  daemon -> client : raw PTY output
//   text frame (JSON) control:
//     {"type":"resize","cols":N,"rows":N}  -> applied to the PTY
//     {"type":"ping"}   -> daemon replies {"type":"pong"}
//     {"type":"pong"}   -> answers the daemon's own keepalive ping
//   daemon sends {"type":"ping"} every PING_INTERVAL_MS; after MISSED_PONG_LIMIT
//   unanswered pings it drops the socket.
//
// No token and no terminal data are ever logged.

const http = require('http');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { RingBuffer } = require('./lib/ring-buffer');
const { parseControlFrame } = require('./lib/control-frame');
const { extractBearer, tokenMatches } = require('./lib/token');

const HOST = '0.0.0.0';
const PORT = 8022;
const REPLAY_MAX_BYTES = 2 * 1024 * 1024; // ~2MB
const PING_INTERVAL_MS = 25_000;
const MISSED_PONG_LIMIT = 2;
const SHELL = process.env.SHELL || '/bin/bash';
const WORKDIR = '/workspace';

const EXPECTED_TOKEN = process.env.OUTPOST_TERMINAL_TOKEN;

// Fail loud if no token is configured — never run an open terminal.
if (typeof EXPECTED_TOKEN !== 'string' || EXPECTED_TOKEN.length === 0) {
  process.stderr.write(
    '[terminal-daemon] refusing to start: OUTPOST_TERMINAL_TOKEN is unset or empty\n'
  );
  process.exit(1);
}

function log(msg) {
  // Only structural/lifecycle messages — never token or terminal bytes.
  process.stderr.write(`[terminal-daemon] ${msg}\n`);
}

// ---- PTY lifecycle (independent of WS connections) ----

const replay = new RingBuffer(REPLAY_MAX_BYTES);
let ptyProc = null;
let lastResize = { cols: 80, rows: 24 };
// The single active upstream socket, or null.
let activeWs = null;

function spawnPty() {
  try {
    const proc = pty.spawn(SHELL, ['-l'], {
      name: 'xterm-256color',
      cols: lastResize.cols,
      rows: lastResize.rows,
      cwd: WORKDIR,
      env: { ...process.env, TERM: 'xterm-256color' },
    });
    proc.onData((data) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      replay.push(chunk);
      if (activeWs && activeWs.readyState === activeWs.OPEN) {
        try {
          activeWs.send(chunk, { binary: true });
        } catch {
          // Send failure is non-fatal for the PTY; the socket will be torn down
          // by its own error/close handler.
        }
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      log(`shell exited (code=${exitCode} signal=${signal ?? 0}); will respawn on next connect`);
      ptyProc = null;
    });
    log('shell spawned');
    return proc;
  } catch (err) {
    log(`failed to spawn shell: ${err && err.message ? err.message : 'unknown error'}`);
    return null;
  }
}

// Ensure a live PTY exists; (re)spawn if the previous shell exited.
function ensurePty() {
  if (ptyProc === null) {
    ptyProc = spawnPty();
  }
  return ptyProc;
}

function writeToPty(chunk) {
  const proc = ensurePty();
  if (!proc) return;
  try {
    proc.write(chunk);
  } catch (err) {
    log(`pty write failed: ${err && err.message ? err.message : 'unknown error'}`);
  }
}

function resizePty(cols, rows) {
  lastResize = { cols, rows };
  const proc = ensurePty();
  if (!proc) return;
  try {
    proc.resize(cols, rows);
  } catch (err) {
    log(`pty resize failed: ${err && err.message ? err.message : 'unknown error'}`);
  }
}

// ---- HTTP + WS server ----

const server = http.createServer((_req, res) => {
  // The daemon serves no HTTP routes; everything is a WS upgrade.
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Upgrade Required\n');
});

server.on('clientError', (_err, socket) => {
  try {
    socket.destroy();
  } catch {
    /* already gone */
  }
});

// noServer: we gate the upgrade ourselves before handing off to ws.
// maxPayload caps a single frame so one oversized frame can't balloon memory.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const authorized = (() => {
    try {
      const presented = extractBearer(req.headers['authorization']);
      return presented !== null && tokenMatches(presented, EXPECTED_TOKEN);
    } catch {
      return false;
    }
  })();

  if (!authorized) {
    // Reject the upgrade with a 401 and close.
    try {
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\n' +
          'Connection: close\r\n' +
          'Content-Length: 0\r\n' +
          '\r\n'
      );
    } catch {
      /* socket may already be broken */
    }
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
    log('rejected unauthorized upgrade');
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws);
  });
});

function replayTo(ws) {
  // Replay buffered output as binary frames, then signal replay-end.
  try {
    for (const chunk of replay.snapshot()) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(chunk, { binary: true });
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'replay-end' }));
    }
  } catch (err) {
    log(`replay send failed: ${err && err.message ? err.message : 'unknown error'}`);
  }
}

wss.on('connection', (ws) => {
  // Single upstream connection: replace any existing one.
  if (activeWs && activeWs !== ws) {
    const old = activeWs;
    activeWs = null;
    try {
      old.close(1000, 'replaced');
    } catch {
      /* ignore */
    }
    try {
      old.terminate();
    } catch {
      /* ignore */
    }
  }
  activeWs = ws;
  log('client connected');

  // Make sure a PTY exists before replay so a respawned shell is wired up.
  ensurePty();

  // Keepalive state.
  let missedPongs = 0;
  const pingTimer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (missedPongs >= MISSED_PONG_LIMIT) {
      log('client missed pongs; dropping socket');
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      return;
    }
    missedPongs += 1;
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch {
      /* handled by close/error */
    }
  }, PING_INTERVAL_MS);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      writeToPty(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    // Text frame: JSON control. Malformed frames are ignored, never fatal.
    let text;
    try {
      text = data.toString('utf8');
    } catch {
      return;
    }
    const cmd = parseControlFrame(text);
    switch (cmd.type) {
      case 'resize':
        resizePty(cmd.cols, cmd.rows);
        break;
      case 'ping':
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* handled by close/error */
        }
        break;
      case 'pong':
        missedPongs = 0;
        break;
      default:
        // 'error' / unknown: ignore silently (no terminal-data logging).
        break;
    }
  });

  ws.on('error', (err) => {
    log(`socket error: ${err && err.message ? err.message : 'unknown error'}`);
  });

  ws.on('close', () => {
    clearInterval(pingTimer);
    if (activeWs === ws) activeWs = null;
    log('client disconnected');
  });

  // Send scrollback, then replay-end.
  replayTo(ws);
});

wss.on('error', (err) => {
  log(`ws server error: ${err && err.message ? err.message : 'unknown error'}`);
});

server.on('error', (err) => {
  log(`http server error: ${err && err.message ? err.message : 'unknown error'}`);
  process.exit(1);
});

function shutdown(signal) {
  log(`received ${signal}; shutting down`);
  try {
    if (ptyProc) ptyProc.kill();
  } catch {
    /* ignore */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
});
