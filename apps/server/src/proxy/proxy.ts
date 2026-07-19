import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { Db } from '../db/client.js';
import { authorizeToken } from '../auth/middleware.js';
import { SESSION_COOKIE_NAME } from '../auth/session.js';
import { findSandboxByName } from '../sandboxes/sandboxes.repo.js';
import { getPort } from './ports.repo.js';
import { DENIED_PORTS } from './routes.js';
import { parsePreviewHost } from './host.js';

/** Milliseconds to wait for the upstream TCP connect before returning 502. */
const DIAL_TIMEOUT_MS = 10_000;

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
  /** Resolve the forward address from a DB sandbox row (invariant 1). */
  resolveTarget: ResolveTarget;
  /**
   * TEST-ONLY. When true, `assertTargetShape` also accepts loopback so fake
   * upstream servers on 127.0.0.1 are reachable. Defaults to false; production
   * wiring never sets it. The guard itself is still unit-tested strictly.
   */
  allowLoopbackTargets?: boolean;
}

/** Copy request headers, dropping hop-by-hop and the outpost session cookie. */
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
  // Invariant 5: strip the outpost_session cookie in ALL cases.
  const cookie = out['cookie'];
  if (cookie !== undefined) {
    const stripped = stripSessionCookie(Array.isArray(cookie) ? cookie.join('; ') : cookie);
    if (stripped) out['cookie'] = stripped;
    else delete out['cookie'];
  }
  Object.assign(out, extra);
  return out;
}

/** Remove the outpost_session pair from a Cookie header value. */
function stripSessionCookie(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && !c.startsWith(`${SESSION_COOKIE_NAME}=`))
    .join('; ');
}

/**
 * Registered ONLY when OUTPOST_PREVIEW_DOMAIN is set. Adds an onRequest hook at
 * the top of the chain (before the auth gate) plus a raw `upgrade` handler for
 * WebSocket passthrough. Any request whose Host is not a preview host falls
 * through completely untouched — non-preview traffic behaves exactly as before.
 */
export function registerPreviewProxy(app: FastifyInstance, deps: PreviewProxyDeps): void {
  const { db, previewDomain, resolveTarget, allowLoopbackTargets = false } = deps;

  const guard = (hostname: string): void => {
    if (allowLoopbackTargets && /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost)$/i.test(hostname)) {
      return;
    }
    assertTargetShape(hostname);
  };

  // ----- HTTP forwarding -----------------------------------------------------
  app.addHook('onRequest', (req, reply, done) => {
    const host = req.headers.host;
    const match = host ? parsePreviewHost(host, previewDomain) : null;
    if (!match) {
      // Not a preview host: leave the request for normal Fastify routing.
      done();
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
    guard(target.hostname);

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
  const previewWss = new WebSocketServer({ noServer: true });
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
    const decision = await authorizePreview(match, reqRaw.headers);
    if (!decision.ok) {
      writeHttpAndClose(socket, decision.status, decision.body);
      return;
    }
    const { target } = decision;
    guard(target.hostname);

    // Rebuild the upstream ws URL and forward subprotocols unmodified (HMR).
    const wsUrl = `ws://${target.hostname}:${target.port}${reqRaw.url ?? '/'}`;
    const subprotocol = reqRaw.headers['sec-websocket-protocol'];
    const forwardHeaders = sanitizeHeaders(reqRaw.headers, {});
    // The ws client sets its own websocket handshake headers; drop the ones it
    // manages to avoid duplicates, but keep everything else the browser sent.
    for (const k of Object.keys(forwardHeaders)) {
      if (/^sec-websocket-|^upgrade$|^connection$|^host$/i.test(k)) delete forwardHeaders[k];
    }

    const upstream = new WebSocket(wsUrl, subprotocol ? splitProtocols(subprotocol) : undefined, {
      headers: forwardHeaders as Record<string, string>,
      handshakeTimeout: DIAL_TIMEOUT_MS,
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
      const token = tokenFromHeaders(headers);
      try {
        authorizeToken(db, token);
      } catch {
        return { ok: false, status: 401, body: 'Unauthorized' };
      }
    }

    const target = await resolveTarget({ providerRef: sandbox.providerRef }, match.port);
    return { ok: true, target };
  }
}

/** Pull the outpost_session token from a raw Cookie header. */
function tokenFromHeaders(headers: IncomingMessage['headers']): string | undefined {
  const raw = headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

function splitProtocols(value: string | string[]): string[] {
  const joined = Array.isArray(value) ? value.join(',') : value;
  return joined.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Pipe both directions of a WS pair with close + error propagation. */
function pipeWebSockets(client: WebSocket, upstream: WebSocket): void {
  client.on('message', (data, isBinary) => forward(upstream, data, isBinary));
  upstream.on('message', (data, isBinary) => forward(client, data, isBinary));

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

function forward(target: WebSocket, data: unknown, isBinary: boolean): void {
  if (target.readyState !== WebSocket.OPEN) return;
  try {
    target.send(data as Buffer, { binary: isBinary });
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
