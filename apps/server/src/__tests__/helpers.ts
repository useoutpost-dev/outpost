import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from 'ws';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { GithubConfig } from '../auth/github.js';
import type { SandboxProvider, Sandbox, SandboxSpec } from '@outpost/shared-api';
import { createSandboxService } from '../sandboxes/service.js';
import { createCredentialsService } from '../credentials/service.js';
import { createSessionManager, type SessionManager } from '../terminal/session-manager.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

/** A fresh, migrated in-memory SQLite DB for a single test. */
export function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export const testGithubConfig: GithubConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  baseUrl: 'https://outpost.example',
};

import type { Fetcher } from '../auth/github.js';

/** A fetcher that returns a fixed access token then a fixed { id, login } user. */
export function stubFetcher(user: { id: number; login: string }): Fetcher {
  return async (url) => {
    if (url.includes('access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_secret' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ id: user.id, login: user.login }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/** In-memory SandboxProvider for tests — never touches Fly. */
export function makeFakeProvider(
  opts: { terminalUrl?: (id: string) => string } = {},
): SandboxProvider & { machines: Map<string, Sandbox> } {
  const machines = new Map<string, Sandbox>();
  let counter = 0;

  return {
    machines,

    async create(spec: SandboxSpec): Promise<Sandbox> {
      const id = `machine-${++counter}`;
      const volumeRef = `vol-${counter}`;
      const sandbox: Sandbox = {
        id,
        name: spec.name,
        status: 'running',
        createdAt: new Date().toISOString(),
        volumeRef,
      };
      machines.set(id, sandbox);
      return sandbox;
    },

    async stop(id: string): Promise<void> {
      const m = machines.get(id);
      if (m) machines.set(id, { ...m, status: 'stopped' });
    },

    async destroy(id: string): Promise<void> {
      machines.delete(id);
    },

    async get(id: string): Promise<Sandbox | null> {
      return machines.get(id) ?? null;
    },

    async list(): Promise<Sandbox[]> {
      return Array.from(machines.values());
    },

    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },

    async terminalEndpoint(id: string) {
      return { url: opts.terminalUrl?.(id) ?? `ws://terminal.test/${id}` };
    },

    async mount() {},

    async ports() {
      return [];
    },
  };
}

export const testSandboxConfig = {
  image: 'outpost/sandbox:test',
  collectorEndpoint: 'http://collector.test:4318',
};

/** Build a sandbox service backed by a fake in-memory provider. */
export function makeFakeSandboxService(
  db: Db,
  provider?: SandboxProvider,
  onTeardown?: (id: string) => void,
) {
  const p = provider ?? makeFakeProvider();
  return createSandboxService({ db, provider: p, config: testSandboxConfig, onTeardown });
}

/** Build a credentials service backed by a fake in-memory provider. Tests that
 *  need one for buildApp can use this; it requires OUTPOST_MASTER_KEY to be set
 *  before any encrypt/decrypt call. */
export function makeFakeCredentialsService(db: Db, provider?: SandboxProvider) {
  const p = provider ?? makeFakeProvider();
  return createCredentialsService({ db, provider: p });
}

/** A session manager that never dials a real daemon — used by non-terminal
 *  tests that only need buildApp to accept the dependency. */
export function makeStubSessionManager(): SessionManager {
  return {
    async attach() {},
    destroy() {},
    destroyAll() {},
    hasSession() {
      return false;
    },
  };
}

/** Build a real session manager wired to a provider + token lookup, for the
 *  terminal integration tests. */
export function makeSessionManager(
  provider: SandboxProvider,
  getTerminalToken: (id: string) => string | null,
): SessionManager {
  return createSessionManager({ provider, getTerminalToken });
}

// ---------------------------------------------------------------------------
// In-process fake terminal daemon — a real `ws` server implementing the daemon
// side of the wire protocol: bearer-token check, replay-then-replay-end,
// scripted/echo output, resize recording. Used by terminal.test.ts.
// ---------------------------------------------------------------------------

export interface FakeDaemon {
  url: string;
  /** All resize control frames received, in order. */
  resizes: Array<{ cols: number; rows: number }>;
  /** All binary writes received from the server (utf-8 decoded). */
  writes: string[];
  /** Send a binary frame to every connected client. */
  emit(data: string | Buffer): void;
  /** Number of times a client has connected (counts reconnects). */
  connectionCount(): number;
  /** Replace the scrollback returned on (re)connect replay. */
  setReplay(data: string): void;
  /** Abruptly drop all connected clients to simulate an upstream WS drop. The
   *  server keeps listening so the session manager can reconnect. */
  dropClients(): void;
  close(): Promise<void>;
}

export interface FakeDaemonOptions {
  /** Bearer token the daemon requires; connections without it are rejected. */
  token: string;
  /** Initial scrollback replayed on connect (before replay-end). */
  replay?: string;
  /** When true, echo binary writes back to all clients (default true). */
  echo?: boolean;
}

/**
 * Starts a real WebSocketServer on an ephemeral port that behaves like the
 * in-sandbox terminal daemon. Returns its ws:// URL and inspection hooks.
 */
export async function startFakeDaemon(opts: FakeDaemonOptions): Promise<FakeDaemon> {
  const echo = opts.echo ?? true;
  const resizes: FakeDaemon['resizes'] = [];
  const writes: string[] = [];
  const clients = new Set<WsSocket>();
  let replay = opts.replay ?? '';
  let connectionCount = 0;

  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');

  wss.on('connection', (ws: WsSocket, req) => {
    // Bearer-token auth: reject a missing/wrong token before doing anything.
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${opts.token}`) {
      ws.close(4401, 'unauthorized');
      return;
    }
    connectionCount += 1;
    clients.add(ws);

    // Replay-then-replay-end contract.
    if (replay.length > 0) ws.send(Buffer.from(replay, 'utf-8'));
    ws.send(JSON.stringify({ type: 'replay-end' }));

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        writes.push(buf.toString('utf-8'));
        if (echo) for (const c of clients) if (c.readyState === c.OPEN) c.send(buf);
        return;
      }
      let ctrl: { type?: string; cols?: number; rows?: number };
      try {
        ctrl = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (ctrl.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (ctrl.type === 'resize') {
        resizes.push({ cols: ctrl.cols ?? 0, rows: ctrl.rows ?? 0 });
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
    });
    ws.on('error', () => {
      clients.delete(ws);
    });
  });

  const port = (wss.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    resizes,
    writes,
    emit(data) {
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
      for (const c of clients) if (c.readyState === c.OPEN) c.send(buf);
    },
    connectionCount: () => connectionCount,
    setReplay(data) {
      replay = data;
    },
    dropClients() {
      for (const c of Array.from(clients)) {
        try {
          c.terminate();
        } catch {
          /* ignore */
        }
        clients.delete(c);
      }
    },
    async close() {
      for (const c of clients) {
        try {
          c.terminate();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
