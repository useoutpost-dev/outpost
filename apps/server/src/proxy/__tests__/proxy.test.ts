import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo, LookupFunction } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { buildApp } from '../../index.js';
import {
  assertResolvedTargetAddress,
  assertTargetShape,
  PreviewUpgradeLimiter,
  type ResolveTarget,
} from '../proxy.js';
import { createSession } from '../../auth/auth.repo.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../../auth/session.js';
import { insertSandbox } from '../../sandboxes/sandboxes.repo.js';
import { createPort, setPublic } from '../ports.repo.js';
import { PREVIEW_GRANT_COOKIE_NAME, PreviewGrantStore } from '../grants.js';
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
const PREVIEW_ORIGIN = `https://${PREVIEW_HOST}`;

const proxyLookup: LookupFunction = (_hostname, options, callback) => {
  if (options.all) {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
    return;
  }
  callback(null, '127.0.0.1', 4);
};

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

async function startEchoWs(): Promise<{
  port: number;
  receivedHeaders: () => IncomingHttpHeaders | undefined;
  close: () => Promise<void>;
}> {
  let headers: IncomingHttpHeaders | undefined;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  wss.on('connection', (ws, req) => {
    headers = req.headers;
    ws.on('message', (data: RawData, isBinary: boolean) => ws.send(data, { binary: isBinary }));
  });
  const port = (wss.address() as AddressInfo).port;
  return {
    port,
    receivedHeaders: () => headers,
    close: () => new Promise<void>((resolve, reject) => wss.close((e) => (e ? reject(e) : resolve()))),
  };
}

interface Harness {
  base: string;
  db: Db;
  cookie: string;
  previewGrants: PreviewGrantStore;
  close: () => Promise<void>;
}

async function startHarness(upstreamPort: number): Promise<Harness> {
  const db = makeTestDb();
  const resolveTarget: ResolveTarget = async () => ({
    hostname: 'machine-1.vm.test-app.internal',
    port: upstreamPort,
  });
  const previewGrants = new PreviewGrantStore();
  const app = buildApp({
    db,
    githubConfig: testGithubConfig,
    sandboxService: makeFakeSandboxService(db),
    sessionManager: makeStubSessionManager(),
    credentialsService: makeFakeCredentialsService(db),
    collectorToken: testCollectorToken,
    previewDomain: PREVIEW_DOMAIN,
    resolveTarget,
    proxyLookup,
    previewGrants,
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
    previewGrants,
    close: () => app.close(),
  };
}

/** Raw HTTP request against the harness with a spoofed preview Host header. */
function previewFetch(
  base: string,
  opts: { host?: string; cookie?: string; path?: string; method?: string; body?: string } = {},
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path: opts.path ?? '/',
        method: opts.method ?? 'GET',
        headers: {
          host: opts.host ?? PREVIEW_HOST,
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(opts.body
            ? {
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': Buffer.byteLength(opts.body),
              }
            : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
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

describe('assertResolvedTargetAddress', () => {
  it.each(['10.0.0.1', '172.16.5.4', '192.168.1.1', 'fdaa:0:1::2', 'fd12:3456::1'])(
    'accepts private address %s',
    (address) => expect(() => assertResolvedTargetAddress(address)).not.toThrow(),
  );

  it.each(['127.0.0.1', '169.254.169.254', '8.8.8.8', '::1', 'fe80::1', '2001:4860:4860::8888'])(
    'rejects non-private address %s',
    (address) => expect(() => assertResolvedTargetAddress(address)).toThrow(),
  );
});

describe('PreviewUpgradeLimiter', () => {
  it('limits a source within the window and resets afterward', () => {
    let now = 1_000;
    const limiter = new PreviewUpgradeLimiter(2, 100, 10, () => now);
    expect(limiter.allow('client')).toBe(true);
    expect(limiter.allow('client')).toBe(true);
    expect(limiter.allow('client')).toBe(false);
    now += 101;
    expect(limiter.allow('client')).toBe(true);
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

  it('exchanges a one-time grant and forwards with only the scoped preview cookie', async () => {
    createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
    const { code } = h.previewGrants.mint({ sandboxId: 'sbx-1', port: 3000 });
    const queryAttempt = await previewFetch(h.base, {
      path: `/_outpost/authorize?grant=${encodeURIComponent(code)}`,
    });
    expect(queryAttempt.status).toBe(404);
    const exchange = await previewFetch(h.base, {
      path: '/_outpost/authorize',
      method: 'POST',
      body: new URLSearchParams({ grant: code }).toString(),
    });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.location).toBe('/');
    expect(exchange.headers['cache-control']).toBe('no-store');
    expect(exchange.headers['referrer-policy']).toBe('no-referrer');
    const setCookie = exchange.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${PREVIEW_GRANT_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toContain('Domain=');

    const previewCookie = setCookie.split(';')[0];
    const forwarded = await previewFetch(h.base, {
      cookie: `${previewCookie}; other=keep`,
    });
    expect(forwarded.status).toBe(200);
    const forwardedCookie = JSON.parse(forwarded.body).headers.cookie ?? '';
    expect(forwardedCookie).not.toContain(PREVIEW_GRANT_COOKIE_NAME);
    expect(forwardedCookie).toContain('other=keep');

    const replay = await previewFetch(h.base, {
      path: '/_outpost/authorize',
      method: 'POST',
      body: new URLSearchParams({ grant: code }).toString(),
    });
    expect(replay.status).toBe(401);
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

  it('strips outpost_session cookie from a public port request', async () => {
    createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
    setPublic(h.db, 'sbx-1', 3000, true);
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
        origin: PREVIEW_ORIGIN,
      });
      await once(ws, 'open');
      ws.send('ping-frame');
      const [msg] = (await once(ws, 'message')) as [RawData];
      expect(msg.toString()).toBe('ping-frame');
      expect(upstream.receivedHeaders()?.['x-forwarded-host']).toBe(PREVIEW_HOST);
      expect(upstream.receivedHeaders()?.['x-forwarded-proto']).toBe('https');
      ws.close();
    } finally {
      await h.close();
      await upstream.close();
    }
  });

  it('accepts a private WS with only the scoped preview cookie', async () => {
    const upstream = await startEchoWs();
    const h = await startHarness(upstream.port);
    try {
      createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
      const { code } = h.previewGrants.mint({ sandboxId: 'sbx-1', port: 3000 });
      const exchange = await previewFetch(h.base, {
        path: '/_outpost/authorize',
        method: 'POST',
        body: new URLSearchParams({ grant: code }).toString(),
      });
      const previewCookie = exchange.headers['set-cookie']?.[0]?.split(';')[0];
      expect(previewCookie).toBeTruthy();

      const ws = new WebSocket(`ws://127.0.0.1:${new URL(h.base).port}/`, {
        headers: { host: PREVIEW_HOST, cookie: previewCookie ?? '' },
        origin: PREVIEW_ORIGIN,
      });
      await once(ws, 'open');
      ws.send('private-frame');
      const [msg] = (await once(ws, 'message')) as [RawData];
      expect(msg.toString()).toBe('private-frame');
      expect(upstream.receivedHeaders()?.cookie ?? '').not.toContain(PREVIEW_GRANT_COOKIE_NAME);
      ws.close();
    } finally {
      await h.close();
      await upstream.close();
    }
  });

  it.each([
    ['missing', undefined],
    ['hostile', 'https://attacker.example'],
    ['non-HTTPS', `http://${PREVIEW_HOST}`],
  ])('rejects a %s Origin before upgrade', async (_label, origin) => {
    const upstream = await startEchoWs();
    const h = await startHarness(upstream.port);
    try {
      createPort(h.db, { sandboxId: 'sbx-1', port: 3000 });
      setPublic(h.db, 'sbx-1', 3000, true);

      const status = await previewWsStatus(h.base, origin);
      expect(status).toBe(403);
    } finally {
      await h.close();
      await upstream.close();
    }
  });
});

function previewWsStatus(base: string, origin: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(base).port}/`, {
      headers: { host: PREVIEW_HOST },
      ...(origin ? { origin } : {}),
    });
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    ws.once('open', () => {
      ws.close();
      reject(new Error('unexpected WebSocket upgrade'));
    });
    ws.once('error', reject);
  });
}

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
