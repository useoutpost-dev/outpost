import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OutpostError } from '@outpost/shared-api';
import { buildApp } from '../index.js';
import { createSession } from '../auth/auth.repo.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../auth/session.js';
import { makeTestDb, testGithubConfig, makeFakeSandboxService } from './helpers.js';

const LOGIN = 'octocat';
const GITHUB_ID = 583231;

beforeEach(() => {
  process.env.OUTPOST_ALLOWED_GITHUB_IDS = String(GITHUB_ID);
});
afterEach(() => {
  delete process.env.OUTPOST_ALLOWED_GITHUB_IDS;
});

/** Build an app with an authenticated session cookie helper for gated routes. */
function authedApp() {
  const db = makeTestDb();
  const app = buildApp({ db, githubConfig: testGithubConfig, sandboxService: makeFakeSandboxService(db) });
  const token = generateSessionToken();
  createSession(db, token, { githubId: GITHUB_ID, githubLogin: LOGIN });
  return { app, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

describe('server app', () => {
  it('GET /health returns 200 {ok:true}', async () => {
    const { app } = authedApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('maps OutpostError to its httpStatus and safe body', async () => {
    const { app, cookie } = authedApp();
    app.get('/boom', () => {
      throw new OutpostError('NOT_FOUND', 404, 'no such sandbox');
    });
    const res = await app.inject({ method: 'GET', url: '/boom', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'no such sandbox' } });
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const { app, cookie } = authedApp();
    app.get('/crash', () => {
      throw new Error('secret internal detail');
    });
    const res = await app.inject({ method: 'GET', url: '/crash', headers: { cookie } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(res.body).not.toContain('secret internal detail');
  });
});
