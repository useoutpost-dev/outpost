import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { buildApp } from '../../index.js';
import { assertTargetShape, type ResolveTarget } from '../proxy.js';
import { createSession } from '../../auth/auth.repo.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../../auth/session.js';
import { insertSandbox } from '../../sandboxes/sandboxes.repo.js';
import { createPort, setPublic } from '../ports.repo.js';
import {
  makeTestDb,
  testGithubConfig,
  makeFakeSandboxService,
  makeStubSessionManager,
  makeFakeCredentialsService,
  testCollectorToken,
} from '../../__tests__/helpers.js';
import type { Db } from '../../db/client.js';

const GITHUB_ID = 583231;
const PREVIEW_DOMAIN = 'sandbox.outpost.dev';
const PREVIEW_HOST = 'my-box-3000.sandbox.outpost.dev';

beforeEach(() => {
  process.env.OUTPOST_ALLOWED_GITHUB_IDS = String(GITHUB_ID);
});
afterEach(() => {
  delete process.env.OUTPOST_ALLOWED_GITHUB_IDS;
});

// ---------------------------------------------------------------------------
// Fake upstream HTTP server that echoes the request headers it received.
// ---------------------------------------------------------------------------
async function startEchoHttp(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ headers: req.headers, url: req.url }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function startEchoWs(): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  wss.on('connection', (ws) => {
    ws.on('message', (data: RawData, isBinary: boolean) => ws.send(data, { binary: isBinary }));
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => wss.close((e) => (e ? reject(e) : resolve()))),
  };
}

interface Harness {
  base: string;
  db: Db;
  cookie: string;
  close: () => Promise<void>;
}

async function startHarness(upstreamPort: number): Promise<Harness> {
  const db = makeTestDb();
  const resolveTarget: ResolveTarget = async () => ({
    hostname: '127.0.0.1',
    port: upstreamPort,
  });
  const app = buildApp({
    db,
    githubConfig: testGithubConfig,
    sandboxService: makeFakeSandboxService(db),
    sessionManager: makeStubSessionManager(),
    credentialsService: makeFakeCredentialsService(db),
    collectorToken: testCollectorToken,
    previewDomain: PREVIEW_DOMAIN,
    resolveTarget,
    allowLoopbackTargets: true,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  const token = generateSessionToken();
  createSession(db, token, { githubId: GITHUB_ID, githubLogin: 'octocat' });
  insertSandbox(db, {
    id: 'sbx-1',
    name: 'my-box',
    provider: 'fly',
    status: 'running',
    providerRef: 'machine-1',
  });
  return {
    base: `http://127.0.0.1:${addr.port}`,
    db,
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    close: () => app.close(),
  };
}

/** Raw HTTP request against the harness with a spoofed preview Host header. */
function previewFetch(
  base: string,
  opts: { host?: string; cookie?: string; path?: string } = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: opts.path ?? '/',
        method: 'GET',
        headers: {
          host: opts.host ?? PREVIEW_HOST,
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('assertTargetShape', () => {
  it('accepts Fly internal DNS', () => {
    expect(() => assertTargetShape('machine-1.vm.myapp.internal')).not.toThrow();
  });
  it('accepts an RFC-1918 IP', () => {
    expect(() => assertTargetShape('10.0.0.1')).not.toThrow();
    expect(() => assertTargetShape('172.16.5.4')).not.toThrow();
    expect(() => assertTargetShape('192.168.1.1')).not.toThrow();
  });
  it('rejects localhost and 127.0.0.1', () => {
    expect(() => assertTargetShape('localhost')).toThrow();
    expect(() => assertTargetShape('127.0.0.1')).toThrow();
  });
  it('rejects a public address', () => {
    expect(() => assertTargetShape('example.com')).toThrow();
    expect(() => assertTargetShape('8.8.8.8')).toThrow();
  });
});

describe('preview proxy — HTTP', () => {
  let upstream: Awaited<ReturnType<typeof startEchoHttp>>;
  let h: Harness;

  beforeEach(async () => {
    upstream = await startEchoHttp();
    h = await startHarness(upstream.port);
  });
  afterEach(async () => {
    await h.close();
    await upstream.close();
  });

  it('private port + no cookie → 401', async () => {
    createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
    const res = await previewFetch(h.base);
    expect(res.status).toBe(401);
  });

  it('private port + valid session cookie → 200 forwarded', async () => {
    createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
    const res = await previewFetch(h.base, { cookie: h.cookie });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).url).toBe('/');
  });

  it('public port + no cookie → 200 forwarded', async () => {
    createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
    setPublic(h.db, 'sbx-1', 3000, true);
    const res = await previewFetch(h.base);
    expect(res.status).toBe(200);
  });

  it('no ports row → 404', async () => {
    const res = await previewFetch(h.base, { cookie: h.cookie });
    expect(res.status).toBe(404);
  });

  it('port 8022 row somehow exists → hard-denied 404', async () => {
    // Insert directly (routes would reject 8022, so bypass them for the test).
    h.db
      .insert((await import('../../db/schema.js')).ports)
      .values({ sandboxId: 'sbx-1', port: 8022, public: true })
      .run();
    const res = await previewFetch(h.base, { host: 'my-box-8022.sandbox.outpost.dev' });
    expect(res.status).toBe(404);
  });

  it('strips outpost_session cookie from the forwarded request', async () => {
    createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
    const res = await previewFetch(h.base, { cookie: `${h.cookie}; other=keep` });
    expect(res.status).toBe(200);
    const forwardedCookie = JSON.parse(res.body).headers.cookie ?? '';
    expect(forwardedCookie).not.toContain(SESSION_COOKIE_NAME);
    expect(forwardedCookie).toContain('other=keep');
  });
});

describe('preview proxy — WebSocket', () => {
  it('passes through a WS echo frame', async () => {
    const upstream = await startEchoWs();
    const h = await startHarness(upstream.port);
    try {
      createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
      setPublic(h.db, 'sbx-1', 3000, true);

      const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.base).port}/`, {
        headers: { host: PREVIEW_HOST },
      });
      await once(ws, 'open');
      ws.send('ping-frame');
      const [msg] = (await once(ws, 'message')) as [RawData];
      expect(msg.toString()).toBe('ping-frame');
      ws.close();
    } finally {
      await h.close();
      await upstream.close();
    }
  });
});

describe('preview proxy — disabled', () => {
  it('falls through to normal routing (404) when no previewDomain', async () => {
    const db = makeTestDb();
    const app = buildApp({
      db,
      githubConfig: testGithubConfig,
      sandboxService: makeFakeSandboxService(db),
      sessionManager: makeStubSessionManager(),
      credentialsService: makeFakeCredentialsService(db),
      collectorToken: testCollectorToken,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const token = generateSessionToken();
    createSession(db, token, { githubId: GITHUB_ID, githubLogin: 'octocat' });
    const addr = app.server.address() as AddressInfo;
    try {
      // Preview host with a valid cookie: no proxy hook, so Fastify routes it
      // normally and returns 404 (no such route).
      const res = await previewFetch(`http://127.0.0.1:${addr.port}`, {
        cookie: `${SESSION_COOKIE_NAME}=${token}`,
      });
      expect(res.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
