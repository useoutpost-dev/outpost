import http from 'node:http';
import { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LookupFunction, Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { Db } from '../db/client.js';
import { authorizeToken } from '../auth/middleware.js';
import { SESSION_COOKIE_NAME } from '../auth/session.js';
import { findSandboxByName } from '../sandboxes/sandboxes.repo.js';
import { getPort } from './ports.repo.js';
import { DENIED_PORTS } from './routes.js';
import { parsePreviewHost } from './host.js';
import {
  PREVIEW_GRANT_COOKIE_NAME,
  type PreviewGrantStore,
} from './grants.js';

/** Milliseconds to wait for the upstream TCP connect before returning 502. */
const DIAL_TIMEOUT_MS = 10_000;
const MAX_WS_FRAME_BYTES = 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const WS_UPGRADE_WINDOW_MS = 60_000;
const WS_UPGRADE_LIMIT = 120;
const WS_RATE_BUCKET_LIMIT = 4096;
const MAX_GRANT_FORM_BYTES = 4096;

export class PreviewUpgradeLimiter {
  private readonly attempts = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly limit = WS_UPGRADE_LIMIT,
    private readonly windowMs = WS_UPGRADE_WINDOW_MS,
    private readonly bucketLimit = WS_RATE_BUCKET_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const current = this.attempts.get(key);
    if (!current || now - current.startedAt >= this.windowMs) {
      if (this.attempts.size >= this.bucketLimit) {
        for (const [storedKey, value] of this.attempts) {
          if (now - value.startedAt >= this.windowMs) this.attempts.delete(storedKey);
        }
        if (this.attempts.size >= this.bucketLimit) {
          const oldest = this.attempts.keys().next().value as string | undefined;
          if (oldest) this.attempts.delete(oldest);
        }
      }
      this.attempts.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

/** Hop-by-hop headers that must never be forwarded verbatim on HTTP/1.1. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Resolved forward target for a preview request. */
export interface ProxyTarget {
  hostname: string;
  port: number;
}

/**
 * SSRF guard (invariant 4). The resolved hostname MUST be either the Fly 6PN
 * internal-DNS shape (`<machine>.vm.<app>.internal`) or a private RFC-1918 IP.
 * Anything else — localhost, 127.0.0.1, the collector, the DB host, a public
 * address — throws, structurally preventing the proxy from dialing them.
 */
export function assertTargetShape(hostname: string): void {
  const h = hostname.toLowerCase();
  if (/^[a-z0-9-]+\.vm\.[a-z0-9-]+\.internal$/.test(h)) return;
  if (isPrivateIpv4(h)) return;
  throw new Error(`proxy: refusing to dial non-internal target '${hostname}'`);
}

/** Connect-time DNS guard against rebinding an allowed internal name publicly. */
export function assertResolvedTargetAddress(address: string): void {
  const normalized = address.toLowerCase();
  if (isPrivateIpv4(normalized)) return;
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)?.[1];
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) return;
  // IPv6 unique-local range fc00::/7, including Fly 6PN fdaa::/16.
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return;
  throw new Error(`proxy: refusing resolved non-private address '${address}'`);
}

export function createGuardedLookup(
  baseLookup: LookupFunction = dnsLookup as LookupFunction,
): LookupFunction {
  return (hostname, options, callback) => {
    baseLookup(hostname, options, (err, address, family) => {
      if (err) {
        callback(err, address, family);
        return;
      }
      try {
        if (Array.isArray(address)) {
          for (const item of address) assertResolvedTargetAddress(item.address);
        } else {
          assertResolvedTargetAddress(address);
        }
        callback(null, address, family);
      } catch (cause) {
        const denied = new Error('proxy target DNS resolved outside the private network', {
          cause,
        }) as NodeJS.ErrnoException;
        denied.code = 'EACCES';
        callback(denied, Array.isArray(address) ? [] : '', family);
      }
    });
  };
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  if (oct.some((n) => n > 255)) return false;
  const [a, b] = oct as [number, number, number, number];
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/** Injected target resolver. Never derives the address from Host/path/query. */
export type ResolveTarget = (sandbox: { providerRef: string | null }, port: number) => Promise<ProxyTarget>;

export interface PreviewProxyDeps {
  db: Db;
  previewDomain: string;
  previewGrants: PreviewGrantStore;
  /** Resolve the forward address from a DB sandbox row (invariant 1). */
  resolveTarget: ResolveTarget;
  /** Optional DNS lookup implementation; does not bypass target-shape validation. */
  lookup?: LookupFunction;
}

/** Copy request headers, dropping hop-by-hop and all Outpost auth cookies. */
function sanitizeHeaders(
  headers: IncomingMessage['headers'],
  extra: Record<string, string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  // Invariant 5: strip Outpost auth cookies in ALL cases.
  const cookie = out['cookie'];
  if (cookie !== undefined) {
    const stripped = stripSessionCookie(Array.isArray(cookie) ? cookie.join('; ') : cookie);
    if (stripped) out['cookie'] = stripped;
    else delete out['cookie'];
  }
  Object.assign(out, extra);
  return out;
}

/** Remove Outpost authorization cookies from a forwarded Cookie header. */
function stripSessionCookie(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => {
      if (c.length === 0) return false;
      return !c.startsWith(`${SESSION_COOKIE_NAME}=`)
        && !c.startsWith(`${PREVIEW_GRANT_COOKIE_NAME}=`);
    })
    .join('; ');
}

/**
 * Registered ONLY when OUTPOST_PREVIEW_DOMAIN is set. Adds an onRequest hook at
 * the top of the chain (before the auth gate) plus a raw `upgrade` handler for
 * WebSocket passthrough. Any request whose Host is not a preview host falls
 * through completely untouched — non-preview traffic behaves exactly as before.
 */
export function registerPreviewProxy(app: FastifyInstance, deps: PreviewProxyDeps): void {
  const { db, previewDomain, previewGrants, resolveTarget, lookup } = deps;
  const upgradeLimiter = new PreviewUpgradeLimiter();
  if (lookup && process.env.NODE_ENV !== 'test') {
    throw new Error('custom preview proxy DNS lookup is test-only');
  }
  const dialLookup = lookup ?? createGuardedLookup();

  // ----- HTTP forwarding -----------------------------------------------------
  app.addHook('onRequest', (req, reply, done) => {
    const host = req.headers.host;
    const match = host ? parsePreviewHost(host, previewDomain) : null;
    if (!match) {
      // Not a preview host: leave the request for normal Fastify routing.
      done();
      return;
    }

    if (isGrantExchangePath(req.raw.url)) {
      reply.hijack();
      exchangePreviewGrant(req.raw, reply.raw, match).catch(() => {
        safeRespond(reply.raw, 400, 'Bad Request');
      });
      return;
    }

    // Take over the raw response; from here we own the socket for this request.
    reply.hijack();
    forwardHttp(req.raw, reply.raw, match).catch((err) => {
      req.log.error(err, 'preview proxy forward failed');
      safeRespond(reply.raw, 502, 'Bad Gateway');
    });
  });

  async function forwardHttp(
    reqRaw: IncomingMessage,
    resRaw: ServerResponse,
    match: { name: string; port: number },
  ): Promise<void> {
    const decision = await authorizePreview(match, reqRaw.headers);
    if (!decision.ok) {
      safeRespond(resRaw, decision.status, decision.body);
      reqRaw.resume(); // drain the request body so the socket can close cleanly
      return;
    }
    const { target } = decision;
    assertTargetShape(target.hostname);

    const headers = sanitizeHeaders(reqRaw.headers, {
      host: `${target.hostname}:${target.port}`,
      'x-forwarded-host': reqRaw.headers.host ?? '',
      'x-forwarded-proto': 'https',
    });

    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        method: reqRaw.method,
        path: reqRaw.url,
        headers,
        timeout: DIAL_TIMEOUT_MS,
        lookup: dialLookup,
      },
      (upRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined) continue;
          if (HOP_BY_HOP.has(k.toLowerCase())) continue;
          outHeaders[k] = v;
        }
        resRaw.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(resRaw);
        upRes.on('error', () => resRaw.destroy());
      },
    );

    upstream.on('timeout', () => upstream.destroy(new Error('upstream dial timeout')));
    upstream.on('error', () => safeRespond(resRaw, 502, 'Bad Gateway'));
    resRaw.on('close', () => upstream.destroy());

    reqRaw.pipe(upstream);
    reqRaw.on('error', () => upstream.destroy());
  }

  // ----- WebSocket passthrough ----------------------------------------------
  // A dedicated noServer WSS: we complete the client-side handshake ourselves
  // rather than routing preview upgrades through Fastify's router.
  const previewWss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
  previewWss.on('error', (err) => app.log.error(err, 'preview wss error'));

  // @fastify/websocket registers its OWN `upgrade` listener that dispatches
  // through the Fastify router (for the terminal route). If both listeners ran
  // on a preview upgrade they would fight over the same socket. So once the app
  // is ready — after that listener is attached — we take over: capture the
  // existing upgrade listeners, remove them, and install a single dispatcher
  // that handles preview hosts here and delegates every other upgrade to the
  // captured listeners unchanged (terminal route keeps working exactly as before).
  app.addHook('onReady', async () => {
    const server = app.server;
    const prior = server.listeners('upgrade') as Array<
      (req: IncomingMessage, socket: Socket, head: Buffer) => void
    >;
    server.removeAllListeners('upgrade');

    server.on('upgrade', (reqRaw: IncomingMessage, socket: Socket, head: Buffer) => {
      const host = reqRaw.headers.host;
      const match = host ? parsePreviewHost(host, previewDomain) : null;
      if (!match) {
        // Not a preview host — replay to the original listeners untouched.
        for (const fn of prior) fn(reqRaw, socket, head);
        return;
      }
      if (!upgradeLimiter.allow(reqRaw.socket.remoteAddress ?? 'unknown')) {
        writeHttpAndClose(socket, 429, 'Too Many Requests');
        return;
      }
      handleUpgrade(reqRaw, socket, head, match).catch((err) => {
        app.log.error(err, 'preview proxy ws upgrade failed');
        destroySocket(socket);
      });
    });
  });

  async function handleUpgrade(
    reqRaw: IncomingMessage,
    socket: Socket,
    _head: Buffer,
    match: { name: string; port: number },
  ): Promise<void> {
    if (!isAllowedPreviewOrigin(reqRaw.headers.origin, reqRaw.headers.host)) {
      writeHttpAndClose(socket, 403, 'Forbidden');
      return;
    }

    const decision = await authorizePreview(match, reqRaw.headers);
    if (!decision.ok) {
      writeHttpAndClose(socket, decision.status, decision.body);
      return;
    }
    const { target } = decision;
    assertTargetShape(target.hostname);

    // Rebuild the upstream ws URL and forward subprotocols unmodified (HMR).
    const wsUrl = `ws://${target.hostname}:${target.port}${reqRaw.url ?? '/'}`;
    const subprotocol = reqRaw.headers['sec-websocket-protocol'];
    const forwardHeaders = sanitizeHeaders(reqRaw.headers, {
      'x-forwarded-host': reqRaw.headers.host ?? '',
      'x-forwarded-proto': 'https',
    });
    // The ws client sets its own websocket handshake headers; drop the ones it
    // manages to avoid duplicates, but keep everything else the browser sent.
    for (const k of Object.keys(forwardHeaders)) {
      if (/^sec-websocket-|^upgrade$|^connection$|^host$/i.test(k)) delete forwardHeaders[k];
    }

    const upstream = new WebSocket(wsUrl, subprotocol ? splitProtocols(subprotocol) : undefined, {
      headers: forwardHeaders as Record<string, string>,
      handshakeTimeout: DIAL_TIMEOUT_MS,
      maxPayload: MAX_WS_FRAME_BYTES,
      lookup: dialLookup,
    });

    upstream.on('open', () => {
      previewWss.handleUpgrade(reqRaw, socket, _head, (client) => {
        pipeWebSockets(client, upstream);
      });
    });

    upstream.on('error', () => {
      writeHttpAndClose(socket, 502, 'Bad Gateway');
    });
  }

  // ----- Shared authorization (invariants 1–3) -------------------------------
  interface AuthzOk {
    ok: true;
    target: ProxyTarget;
  }
  interface AuthzFail {
    ok: false;
    status: number;
    body: string;
  }

  async function authorizePreview(
    match: { name: string; port: number },
    headers: IncomingMessage['headers'],
  ): Promise<AuthzOk | AuthzFail> {
    // Invariant 2 (defense in depth): hard-deny the terminal port pre-DB.
    if (DENIED_PORTS.has(match.port)) {
      return { ok: false, status: 404, body: 'Not Found' };
    }

    // Invariant 1: resolve the sandbox exclusively from the DB, must be running.
    const sandbox = findSandboxByName(db, match.name);
    if (!sandbox || sandbox.status !== 'running') {
      return { ok: false, status: 404, body: 'Not Found' };
    }

    // Invariant 2: the port must be a registered row for this sandbox.
    const portRow = getPort(db, sandbox.id, match.port);
    if (!portRow) {
      return { ok: false, status: 404, body: 'Not Found' };
    }

    // Invariant 3: private ports require a valid session; public ports skip auth.
    if (!portRow.public) {
      const token = cookieFromHeaders(headers, SESSION_COOKIE_NAME);
      let managerAuthorized = false;
      try {
        authorizeToken(db, token);
        managerAuthorized = true;
      } catch {
        // Preview subdomains do not receive the host-only manager cookie. Fall
        // back to the short-lived cookie scoped to this exact sandbox + port.
      }
      const previewToken = cookieFromHeaders(headers, PREVIEW_GRANT_COOKIE_NAME);
      if (!managerAuthorized && !previewGrants.authorize(previewToken, {
        sandboxId: sandbox.id,
        port: match.port,
      })) {
        return { ok: false, status: 401, body: 'Unauthorized' };
      }
    }

    const target = await resolveTarget({ providerRef: sandbox.providerRef }, match.port);
    return { ok: true, target };
  }

  async function exchangePreviewGrant(
    reqRaw: IncomingMessage,
    resRaw: ServerResponse,
    match: { name: string; port: number },
  ): Promise<void> {
    resRaw.setHeader('cache-control', 'no-store');
    resRaw.setHeader('referrer-policy', 'no-referrer');
    if (reqRaw.method !== 'POST' || DENIED_PORTS.has(match.port)) {
      safeRespond(resRaw, 404, 'Not Found');
      return;
    }
    const contentType = reqRaw.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/x-www-form-urlencoded') {
      safeRespond(resRaw, 415, 'Unsupported Media Type');
      reqRaw.resume();
      return;
    }

    const sandbox = findSandboxByName(db, match.name);
    if (!sandbox || sandbox.status !== 'running') {
      safeRespond(resRaw, 404, 'Not Found');
      return;
    }
    const portRow = getPort(db, sandbox.id, match.port);
    if (!portRow || portRow.public) {
      safeRespond(resRaw, 404, 'Not Found');
      return;
    }

    let code: string | undefined;
    try {
      code = await readGrantForm(reqRaw);
    } catch {
      safeRespond(resRaw, 400, 'Bad Request');
      return;
    }
    const exchanged = previewGrants.exchange(code, {
      sandboxId: sandbox.id,
      port: match.port,
    });
    if (!exchanged) {
      safeRespond(resRaw, 401, 'Unauthorized');
      return;
    }

    const maxAge = Math.max(1, Math.ceil((exchanged.expiresAt - Date.now()) / 1000));
    const cookie = [
      `${PREVIEW_GRANT_COOKIE_NAME}=${exchanged.token}`,
      'Path=/',
      `Max-Age=${maxAge}`,
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
    ].join('; ');
    resRaw.writeHead(303, {
      location: '/',
      'set-cookie': cookie,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-length': '0',
    });
    resRaw.end();
  }
}

async function readGrantForm(req: IncomingMessage): Promise<string | undefined> {
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_GRANT_FORM_BYTES) {
    throw new Error('invalid preview grant form length');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_GRANT_FORM_BYTES) throw new Error('preview grant form too large');
    chunks.push(buffer);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const grant = form.get('grant');
  return grant && grant.length <= 256 ? grant : undefined;
}

/** Pull one named token from a raw Cookie header. */
function cookieFromHeaders(
  headers: IncomingMessage['headers'],
  cookieName: string,
): string | undefined {
  const raw = headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === cookieName) return rest.join('=');
  }
  return undefined;
}

function isGrantExchangePath(rawUrl: string | undefined): boolean {
  try {
    return new URL(rawUrl ?? '/', 'https://preview.invalid').pathname === '/_outpost/authorize';
  } catch {
    return false;
  }
}

function splitProtocols(value: string | string[]): string[] {
  const joined = Array.isArray(value) ? value.join(',') : value;
  return joined.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Browser preview upgrades must originate from the exact HTTPS preview host. */
function isAllowedPreviewOrigin(origin: string | undefined, requestHost: string | undefined): boolean {
  if (!origin || !requestHost) return false;
  try {
    const actual = new URL(origin);
    const expected = new URL(`https://${requestHost}`);
    return actual.protocol === 'https:' && actual.origin === expected.origin;
  } catch {
    return false;
  }
}

/** Pipe both directions of a WS pair with close + error propagation. */
function pipeWebSockets(client: WebSocket, upstream: WebSocket): void {
  client.on('message', (data, isBinary) => forward(client, upstream, data, isBinary));
  upstream.on('message', (data, isBinary) => forward(upstream, client, data, isBinary));

  const closeBoth = (): void => {
    try { client.close(); } catch { /* ignore */ }
    try { upstream.close(); } catch { /* ignore */ }
  };
  client.on('close', closeBoth);
  upstream.on('close', closeBoth);
  // Error listeners on BOTH sides prevent an unhandled 'error' from crashing.
  client.on('error', closeBoth);
  upstream.on('error', closeBoth);
}

function forward(source: WebSocket, target: WebSocket, data: unknown, isBinary: boolean): void {
  if (target.readyState !== WebSocket.OPEN) return;
  if (target.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    try { source.close(1013, 'backpressure'); } catch { /* ignore */ }
    try { target.close(1013, 'backpressure'); } catch { /* ignore */ }
    return;
  }
  try {
    target.send(data as Buffer, { binary: isBinary }, (err) => {
      if (!err) return;
      try { source.close(); } catch { /* ignore */ }
      try { target.close(); } catch { /* ignore */ }
    });
  } catch {
    /* target closed mid-send; the close handlers will tear down */
  }
}

function safeRespond(res: ServerResponse, status: number, message: string): void {
  try {
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    }
    res.end(`<!doctype html><title>${status}</title><h1>${status} ${message}</h1>`);
  } catch {
    try { res.destroy(); } catch { /* ignore */ }
  }
}

function writeHttpAndClose(socket: Socket, status: number, message: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    /* ignore */
  }
  destroySocket(socket);
}

function destroySocket(socket: Socket): void {
  try { socket.destroy(); } catch { /* ignore */ }
}
