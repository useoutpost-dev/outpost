import type { FastifyInstance, FastifyRequest } from 'fastify';
import { OutpostError } from '@outpost/shared-api';
import type { Db } from '../db/client.js';
import { lookupSession } from './auth.repo.js';
import { SESSION_COOKIE_NAME } from './session.js';

/** Routes reachable without a valid session. Everything else is gated. */
export const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/login',
  '/auth/callback',
  // Collector is token-gated (collector bearer token), not session-gated.
  '/v1/metrics',
]);

/** Authorized identity resolved from a session and re-checked against the allowlist. */
export interface AuthorizedUser {
  githubId: number;
  githubLogin: string;
}

/**
 * Parse the comma-separated allowlist of immutable GitHub numeric user IDs.
 * Entries are trimmed and empties dropped. Keyed on the numeric ID, never the
 * username, since usernames can be re-registered by a different person.
 * Fails loud (throws) if any non-empty entry is not a numeric ID.
 */
export function parseAllowedIds(env: NodeJS.ProcessEnv = process.env): number[] {
  return (env.OUTPOST_ALLOWED_GITHUB_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      if (!/^\d+$/.test(s)) {
        throw new Error(`OUTPOST_ALLOWED_GITHUB_IDS contains a non-numeric entry: ${s}`);
      }
      return Number(s);
    });
}

/** True if the github id is currently on the allowlist (re-checked every call, never cached). */
export function isAllowed(githubId: number, env: NodeJS.ProcessEnv = process.env): boolean {
  return parseAllowedIds(env).includes(githubId);
}

/**
 * Resolve and authorize the session for a raw token.
 * Reusable across HTTP requests and (Phase 3) WebSocket upgrades.
 * Returns the authorized github id and login, or throws UNAUTHORIZED.
 * The allowlist is re-checked on every call by immutable id, login-time
 * membership is never trusted.
 */
export function authorizeToken(
  db: Db,
  rawToken: string | undefined,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): AuthorizedUser {
  if (!rawToken) {
    throw new OutpostError('UNAUTHORIZED', 401, 'authentication required');
  }
  const session = lookupSession(db, rawToken, now);
  if (!session) {
    throw new OutpostError('UNAUTHORIZED', 401, 'authentication required');
  }
  if (!isAllowed(session.githubId, env)) {
    throw new OutpostError('UNAUTHORIZED', 401, 'authentication required');
  }
  return { githubId: session.githubId, githubLogin: session.githubLogin };
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Authorized github numeric id, set by the auth hook on gated routes. */
    githubId?: number;
    /** Authorized github login, set by the auth hook on gated routes. */
    githubLogin?: string;
  }
}

function tokenFromRequest(req: FastifyRequest): string | undefined {
  const cookies = (req as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  return cookies?.[SESSION_COOKIE_NAME];
}

/**
 * Register the global onRequest gate. Every route requires a valid, allowlisted
 * session except the explicit PUBLIC_PATHS. Attaches the login to the request.
 */
export function registerAuthGate(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (req) => {
    if (PUBLIC_PATHS.has(req.url.split('?')[0] ?? req.url)) {
      return;
    }
    const user = authorizeToken(db, tokenFromRequest(req));
    req.githubId = user.githubId;
    req.githubLogin = user.githubLogin;
  });
}
