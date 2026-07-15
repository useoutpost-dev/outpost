import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp } from '../index.js';
import { events, sessions } from '../db/schema.js';
import { createSession } from '../auth/auth.repo.js';
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
} from '../auth/session.js';
import { STATE_COOKIE_NAME } from '../auth/github.js';
import { makeTestDb, testGithubConfig, stubFetcher, makeFakeSandboxService } from './helpers.js';

const LOGIN = 'octocat';
const GITHUB_ID = 583231;
const STRANGER_ID = 424242;

beforeEach(() => {
  process.env.OUTPOST_ALLOWED_GITHUB_IDS = String(GITHUB_ID);
});
afterEach(() => {
  delete process.env.OUTPOST_ALLOWED_GITHUB_IDS;
});

function build(user: { id: number; login: string } = { id: GITHUB_ID, login: LOGIN }) {
  const db = makeTestDb();
  const app = buildApp({
    db,
    githubConfig: testGithubConfig,
    fetcher: stubFetcher(user),
    sandboxService: makeFakeSandboxService(db),
  });
  return { db, app };
}

function authEvents(db: ReturnType<typeof makeTestDb>) {
  return db.select().from(events).all();
}

describe('auth gate', () => {
  it('unauthenticated request to a protected route returns 401 with a safe body', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'authentication required' } });
  });

  it('/health stays open without a session', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('/auth/login is open and redirects to GitHub with a state cookie', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'GET', url: '/auth/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('https://github.com/login/oauth/authorize');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain(`${STATE_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
  });
});

describe('auth callback', () => {
  it('rejects a state mismatch and creates no session', async () => {
    const { db, app } = build();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/callback?code=abc&state=WRONG',
      cookies: { [STATE_COOKIE_NAME]: 'EXPECTED' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).not.toMatch(new RegExp(`${SESSION_COOKIE_NAME}=[^;]`));
    expect(authEvents(db)).toHaveLength(0);
  });

  it('denies a non-allowlisted id with 403, logs a denied event, sets no session cookie', async () => {
    const { db, app } = build({ id: STRANGER_ID, login: 'stranger' });
    const state = 'sharedstate';
    const res = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${state}`,
      cookies: { [STATE_COOKIE_NAME]: state },
    });
    expect(res.statusCode).toBe(403);
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).not.toContain(`${SESSION_COOKIE_NAME}=gho`);
    // no session cookie set (only the state clear cookie may appear)
    expect(setCookie).not.toMatch(new RegExp(`${SESSION_COOKIE_NAME}=[0-9a-f]{64}`));
    const rows = authEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('auth.denied');
    expect(rows[0]?.payload).toEqual({ githubId: STRANGER_ID, githubLogin: 'stranger' });
  });

  it('happy path: allowlisted login sets a HttpOnly SameSite=Lax cookie and /auth/me returns the login', async () => {
    const { db, app } = build();
    const state = 'happystate';
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${state}`,
      cookies: { [STATE_COOKIE_NAME]: state },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/');
    const setCookie = String(cb.headers['set-cookie']);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');

    const rawToken = /outpost_session=([0-9a-f]{64})/.exec(setCookie)?.[1];
    expect(rawToken).toBeTruthy();
    // login event recorded, no access token in the payload
    const rows = authEvents(db);
    expect(rows.some((r) => r.kind === 'auth.login')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('gho_secret');

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: rawToken! },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ login: LOGIN });
  });
});

describe('session lifecycle', () => {
  it('expired session returns 401 and deletes the row', async () => {
    const { db, app } = build();
    const token = generateSessionToken();
    // create with an 8-day-old clock so expiry (7d TTL) is already in the past
    createSession(
      db,
      token,
      { githubId: GITHUB_ID, githubLogin: LOGIN },
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(res.statusCode).toBe(401);
    // expired row was deleted on lookup
    const gone = db.select().from(sessions).where(eq(sessions.id, hashSessionToken(token))).all();
    expect(gone).toHaveLength(0);
  });

  it('allowlist re-check: valid session but id removed from allowlist returns 401', async () => {
    const { db, app } = build();
    const token = generateSessionToken();
    createSession(db, token, { githubId: GITHUB_ID, githubLogin: LOGIN });
    process.env.OUTPOST_ALLOWED_GITHUB_IDS = String(STRANGER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(res.statusCode).toBe(401);
  });

  it('login rotates the session: a pre-existing session token is revoked', async () => {
    const { db, app } = build();
    const oldToken = generateSessionToken();
    createSession(db, oldToken, { githubId: GITHUB_ID, githubLogin: LOGIN });
    const state = 'rotatestate';
    const cb = await app.inject({
      method: 'GET',
      url: `/auth/callback?code=abc&state=${state}`,
      cookies: { [STATE_COOKIE_NAME]: state, [SESSION_COOKIE_NAME]: oldToken },
    });
    expect(cb.statusCode).toBe(302);
    // old session row deleted
    const oldGone = db.select().from(sessions).where(eq(sessions.id, hashSessionToken(oldToken))).all();
    expect(oldGone).toHaveLength(0);
    // the newly issued token differs from the old one and is valid
    const newToken = /outpost_session=([0-9a-f]{64})/.exec(String(cb.headers['set-cookie']))?.[1];
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);
  });

  it('logout clears the session and a subsequent /auth/me returns 401', async () => {
    const { db, app } = build();
    const token = generateSessionToken();
    createSession(db, token, { githubId: GITHUB_ID, githubLogin: LOGIN });

    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(out.statusCode).toBe(200);
    expect(authEvents(db).some((r) => r.kind === 'auth.logout')).toBe(true);
    // session row gone
    const gone = db.select().from(sessions).where(eq(sessions.id, hashSessionToken(token))).all();
    expect(gone).toHaveLength(0);

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(me.statusCode).toBe(401);
  });

  it('unauthenticated POST /auth/logout returns 401', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(res.statusCode).toBe(401);
  });
});
