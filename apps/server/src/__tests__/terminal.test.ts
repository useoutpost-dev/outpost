import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import { buildApp } from '../index.js';
import { sandboxes } from '../db/schema.js';
import { createSession } from '../auth/auth.repo.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../auth/session.js';
import { findSandboxById } from '../sandboxes/sandboxes.repo.js';
import {
  makeTestDb,
  testGithubConfig,
  makeFakeProvider,
  makeFakeSandboxService,
  makeSessionManager,
  startFakeDaemon,
  type FakeDaemon,
} from './helpers.js';
import type { Db } from '../db/client.js';

const GITHUB_ID = 583231;
const LOGIN = 'octocat';
const TOKEN = 'a'.repeat(64);

beforeEach(() => {
  process.env.OUTPOST_ALLOWED_GITHUB_IDS = String(GITHUB_ID);
});
afterEach(() => {
  delete process.env.OUTPOST_ALLOWED_GITHUB_IDS;
});

// --- test rig -------------------------------------------------------------

interface Rig {
  baseUrl: string;
  cookie: string;
  db: Db;
  sandboxId: string;
  close(): Promise<void>;
}

/**
 * Boots a real listening app wired to a real session manager whose provider
 * points terminalEndpoint at the given fake daemon. Inserts a running sandbox
 * row (id -> terminalToken) unless overridden.
 */
async function makeRig(
  daemonUrl: string,
  opts: { status?: string; terminalToken?: string | null } = {},
): Promise<Rig> {
  const db = makeTestDb();
  const provider = makeFakeProvider({ terminalUrl: () => daemonUrl });
  const sessionManager = makeSessionManager(
    provider,
    (id) => findSandboxById(db, id)?.terminalToken ?? null,
  );
  const sandboxService = makeFakeSandboxService(db, provider, (id) => sessionManager.destroy(id));
  const app = buildApp({ db, githubConfig: testGithubConfig, sandboxService, sessionManager });

  const sandboxId = 'sbx-1';
  db.insert(sandboxes)
    .values({
      id: sandboxId,
      name: 'termbox',
      provider: 'fly',
      providerRef: 'machine-1',
      status: opts.status ?? 'running',
      terminalToken: opts.terminalToken === undefined ? TOKEN : opts.terminalToken,
    })
    .run();

  const token = generateSessionToken();
  createSession(db, token, { githubId: GITHUB_ID, githubLogin: LOGIN });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  const baseUrl = `ws://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    db,
    sandboxId,
    async close() {
      sessionManager.destroyAll();
      await app.close();
    },
  };
}

type Frame = { text?: string; bin?: Buffer };

/**
 * A WS client that buffers every frame from creation so no message is lost in
 * the gap between 'open' and a later listener registration.
 */
interface Client {
  ws: WebSocket;
  frames: Frame[];
  waitFor(done: (frames: Frame[]) => boolean, timeoutMs?: number): Promise<Frame[]>;
}

/** Open a terminal WS client with the session cookie, buffering all frames. */
function connect(rig: Rig, cookie = rig.cookie): Client {
  const ws = new WebSocket(`${rig.baseUrl}/api/sandboxes/${rig.sandboxId}/terminal`, {
    headers: cookie ? { cookie } : {},
  });
  const frames: Frame[] = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (data: RawData, isBinary: boolean) => {
    frames.push(isBinary ? { bin: toBuf(data) } : { text: data.toString() });
    for (const w of waiters.splice(0)) w();
  });
  return {
    ws,
    frames,
    waitFor(done, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (done(frames)) {
            clearTimeout(timer);
            resolve(frames);
          } else {
            waiters.push(check);
          }
        };
        const timer = setTimeout(
          () => reject(new Error(`timeout; frames=${JSON.stringify(frames.map((f) => f.text ?? '<bin>'))}`)),
          timeoutMs,
        );
        ws.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
        check();
      });
    },
  };
}

function toBuf(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
}

function hasControl(frames: Array<{ text?: string }>, type: string): boolean {
  return frames.some((f) => f.text !== undefined && safeType(f.text) === type);
}

function safeType(text: string): string | undefined {
  try {
    return JSON.parse(text).type;
  } catch {
    return undefined;
  }
}

// --- tests ----------------------------------------------------------------

describe('terminal WS — auth gate on upgrade', () => {
  let daemon: FakeDaemon;
  beforeEach(async () => {
    daemon = await startFakeDaemon({ token: TOKEN });
  });
  afterEach(async () => {
    await daemon.close();
  });

  it('unauthenticated upgrade → 401 and no session created', async () => {
    const rig = await makeRig(daemon.url);
    try {
      const { ws } = connect(rig, '');
      // @fastify/websocket aborts the upgrade when onRequest throws; the client
      // sees an 'unexpected-response' with the HTTP status, never 'open'.
      const [, res] = (await once(ws, 'unexpected-response')) as [unknown, { statusCode: number }];
      expect(res.statusCode).toBe(401);
      // No upstream daemon connection was ever attempted.
      expect(daemon.connectionCount()).toBe(0);
    } finally {
      await rig.close();
    }
  });
});

describe('terminal WS — attach + replay', () => {
  let daemon: FakeDaemon;
  afterEach(async () => {
    await daemon.close();
  });

  it('authenticated attach receives scrollback then replay-end', async () => {
    daemon = await startFakeDaemon({ token: TOKEN, replay: 'hello-scrollback' });
    const rig = await makeRig(daemon.url);
    try {
      const c = connect(rig);
      const frames = await c.waitFor((f) => hasControl(f, 'replay-end'));
      const binText = frames
        .filter((f) => f.bin)
        .map((f) => f.bin!.toString('utf-8'))
        .join('');
      expect(binText).toContain('hello-scrollback');
      expect(hasControl(frames, 'replay-end')).toBe(true);
      c.ws.close();
    } finally {
      await rig.close();
    }
  });
});

describe('terminal WS — session survives disconnect/reattach', () => {
  let daemon: FakeDaemon;
  afterEach(async () => {
    await daemon.close();
  });

  it('scrollback is replayed to a reattaching client after the first client leaves', async () => {
    daemon = await startFakeDaemon({ token: TOKEN, replay: '' });
    const rig = await makeRig(daemon.url);
    try {
      const c1 = connect(rig);
      await c1.waitFor((f) => hasControl(f, 'replay-end'));

      // Daemon streams output while client 1 is attached; it lands in the ring.
      daemon.emit('line-from-session\r\n');
      await c1.waitFor((f) => f.some((x) => x.bin?.toString('utf-8').includes('line-from-session')));

      c1.ws.close();
      await once(c1.ws, 'close');

      // Reattach: server-side scrollback must replay to the new client.
      const c2 = connect(rig);
      const frames = await c2.waitFor((f) => hasControl(f, 'replay-end'));
      const replayed = frames
        .filter((f) => f.bin)
        .map((f) => f.bin!.toString('utf-8'))
        .join('');
      expect(replayed).toContain('line-from-session');
      c2.ws.close();
    } finally {
      await rig.close();
    }
  });
});

describe('terminal WS — multi-tab fan-out / fan-in', () => {
  let daemon: FakeDaemon;
  afterEach(async () => {
    await daemon.close();
  });

  it('both clients receive the same daemon output and both can write', async () => {
    daemon = await startFakeDaemon({ token: TOKEN, echo: true });
    const rig = await makeRig(daemon.url);
    try {
      const c1 = connect(rig);
      const c2 = connect(rig);
      await Promise.all([
        c1.waitFor((f) => hasControl(f, 'replay-end')),
        c2.waitFor((f) => hasControl(f, 'replay-end')),
      ]);

      // Daemon pushes output; both tabs must see it.
      const seen1 = c1.waitFor((f) => f.some((x) => x.bin?.toString('utf-8').includes('broadcast')));
      const seen2 = c2.waitFor((f) => f.some((x) => x.bin?.toString('utf-8').includes('broadcast')));
      daemon.emit('broadcast');
      await Promise.all([seen1, seen2]);

      // Writes from BOTH tabs reach the daemon (echo returns them to all).
      c1.ws.send(Buffer.from('from-tab-1'));
      c2.ws.send(Buffer.from('from-tab-2'));
      await waitFor(() => daemon.writes.includes('from-tab-1') && daemon.writes.includes('from-tab-2'));
      expect(daemon.writes).toContain('from-tab-1');
      expect(daemon.writes).toContain('from-tab-2');

      c1.ws.close();
      c2.ws.close();
    } finally {
      await rig.close();
    }
  });
});

describe('terminal WS — resize propagation and re-send after reconnect', () => {
  let daemon: FakeDaemon;
  afterEach(async () => {
    await daemon.close();
  });

  it('resize reaches daemon, and latest resize is re-sent after upstream reconnect', async () => {
    daemon = await startFakeDaemon({ token: TOKEN });
    const rig = await makeRig(daemon.url);
    try {
      const c = connect(rig);
      await c.waitFor((f) => hasControl(f, 'replay-end'));

      c.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
      await waitFor(() => daemon.resizes.length >= 1);
      expect(daemon.resizes.at(-1)).toEqual({ cols: 100, rows: 40 });

      const before = daemon.resizes.length;
      // Force an upstream drop: terminate all daemon-side sockets. The session
      // manager reconnects and must re-send the latest resize on reconnect.
      const reconnected = c.waitFor((f) => f.some((x) => safeTypeState(x.text) === 'connected'), 5000);
      forceUpstreamDrop(daemon);
      await reconnected;
      await waitFor(() => daemon.resizes.length > before, 5000);
      expect(daemon.resizes.at(-1)).toEqual({ cols: 100, rows: 40 });

      c.ws.close();
    } finally {
      await rig.close();
    }
  });
});

describe('terminal WS — upstream reconnect repopulates buffer', () => {
  let daemon: FakeDaemon;
  afterEach(async () => {
    await daemon.close();
  });

  it('after an upstream drop the ring is repopulated from the daemon replay', async () => {
    daemon = await startFakeDaemon({ token: TOKEN, replay: 'v1' });
    const rig = await makeRig(daemon.url);
    try {
      const c = connect(rig);
      await c.waitFor((f) => hasControl(f, 'replay-end'));

      // Daemon's next replay content changes; drop the upstream to force reconnect.
      daemon.setReplay('v2-after-reconnect');
      const reconnected = c.waitFor((f) => f.some((x) => safeTypeState(x.text) === 'connected'), 5000);
      forceUpstreamDrop(daemon);
      await reconnected;

      // The already-attached client must NOT be re-forwarded the replay, but the
      // server-side ring must now hold v2. Verify via a fresh attach: its replay
      // should contain v2, not v1.
      await waitFor(() => daemon.connectionCount() >= 2, 5000);
      const c2 = connect(rig);
      const frames = await c2.waitFor((f) => hasControl(f, 'replay-end'));
      const replayed = frames.filter((f) => f.bin).map((f) => f.bin!.toString('utf-8')).join('');
      expect(replayed).toContain('v2-after-reconnect');
      expect(replayed).not.toContain('v1');
      // The already-attached client was NOT re-forwarded the reconnect replay.
      expect(c.frames.some((f) => f.bin?.toString('utf-8').includes('v2-after-reconnect'))).toBe(false);

      c.ws.close();
      c2.ws.close();
    } finally {
      await rig.close();
    }
  });
});

describe('terminal WS — sandbox not running / token null', () => {
  let daemon: FakeDaemon;
  beforeEach(async () => {
    daemon = await startFakeDaemon({ token: TOKEN });
  });
  afterEach(async () => {
    await daemon.close();
  });

  it('sandbox not running → closed with conflict, no daemon connection', async () => {
    const rig = await makeRig(daemon.url, { status: 'stopped' });
    try {
      const { ws } = connect(rig);
      const [code] = (await once(ws, 'close')) as [number, Buffer];
      expect(code).toBe(4409);
      expect(daemon.connectionCount()).toBe(0);
    } finally {
      await rig.close();
    }
  });

  it('terminal token null → closed with conflict, no daemon connection', async () => {
    const rig = await makeRig(daemon.url, { terminalToken: null });
    try {
      const { ws } = connect(rig);
      const [code] = (await once(ws, 'close')) as [number, Buffer];
      expect(code).toBe(4409);
      expect(daemon.connectionCount()).toBe(0);
    } finally {
      await rig.close();
    }
  });
});

// --- helpers --------------------------------------------------------------

function safeTypeState(text?: string): string | undefined {
  if (text === undefined) return undefined;
  try {
    const o = JSON.parse(text);
    return o.type === 'upstream' ? o.state : undefined;
  } catch {
    return undefined;
  }
}

/** Terminate every daemon-side socket to simulate an upstream drop. The daemon
 *  keeps listening so the session manager can reconnect. */
function forceUpstreamDrop(daemon: FakeDaemon): void {
  daemon.dropClients();
}

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
