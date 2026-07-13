import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OutpostError } from '@outpost/shared-api';
import type { Db } from '../db/client.js';
import {
  authorizeUrl,
  generateState,
  resolveGithubUser,
  verifyState,
  STATE_COOKIE_NAME,
  STATE_COOKIE_TTL_SECONDS,
  type Fetcher,
  type GithubConfig,
} from './github.js';
import {
  appendAuthEvent,
  createSession,
  deleteSession,
} from './auth.repo.js';
import { isAllowed } from './middleware.js';
import {
  SESSION_COOKIE_NAME,
  generateSessionToken,
  sessionCookieOptions,
  cookieOptions,
  clearCookieOptions,
} from './session.js';

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export interface AuthRouteOptions {
  db: Db;
  githubConfig: GithubConfig;
  /** Injectable fetcher so tests can stub GitHub without real network. */
  fetcher?: Fetcher;
}

export function registerAuthRoutes(app: FastifyInstance, opts: AuthRouteOptions): void {
  const { db, githubConfig, fetcher } = opts;

  app.get('/auth/login', async (_req, reply) => {
    const state = generateState();
    reply.setCookie(STATE_COOKIE_NAME, state, cookieOptions(STATE_COOKIE_TTL_SECONDS));
    return reply.redirect(authorizeUrl(githubConfig, state));
  });

  app.get('/auth/callback', async (req, reply) => {
    const parsed = callbackQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new OutpostError('BAD_REQUEST', 400, 'invalid callback parameters');
    }
    const { code, state } = parsed.data;

    const expectedState = req.cookies?.[STATE_COOKIE_NAME];
    // Clear the one-time state cookie regardless of outcome. Flags must match the set.
    reply.clearCookie(STATE_COOKIE_NAME, clearCookieOptions());
    if (!verifyState(expectedState, state)) {
      throw new OutpostError('UNAUTHORIZED', 401, 'invalid oauth state');
    }

    const user = await resolveGithubUser(githubConfig, code, fetcher);

    if (!isAllowed(user.id)) {
      appendAuthEvent(db, 'denied', { githubId: user.id, githubLogin: user.login });
      throw new OutpostError('FORBIDDEN', 403, 'access denied');
    }

    // Rotate the session id after login: revoke any pre-existing session token
    // carried on the request before minting a fresh one.
    const priorToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (priorToken) {
      deleteSession(db, priorToken);
    }

    const rawToken = generateSessionToken();
    createSession(db, rawToken, { githubId: user.id, githubLogin: user.login });
    appendAuthEvent(db, 'login', { githubId: user.id, githubLogin: user.login });
    reply.setCookie(SESSION_COOKIE_NAME, rawToken, sessionCookieOptions());
    return reply.redirect('/');
  });

  app.post('/auth/logout', async (req, reply) => {
    // The gate populates githubLogin on authenticated requests; its absence
    // means the caller had no valid session, so refuse rather than no-op.
    if (!req.githubLogin || req.githubId === undefined) {
      throw new OutpostError('UNAUTHORIZED', 401, 'authentication required');
    }
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (rawToken) {
      deleteSession(db, rawToken);
    }
    appendAuthEvent(db, 'logout', { githubId: req.githubId, githubLogin: req.githubLogin });
    reply.clearCookie(SESSION_COOKIE_NAME, clearCookieOptions());
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    // Reaches here only through the auth gate, so githubLogin is guaranteed set.
    if (!req.githubLogin) {
      throw new OutpostError('UNAUTHORIZED', 401, 'authentication required');
    }
    return { login: req.githubLogin };
  });
}
