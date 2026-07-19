import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../index.js';
import { createSession } from '../../auth/auth.repo.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../../auth/session.js';
import { insertSandbox } from '../../sandboxes/sandboxes.repo.js';
import { events } from '../../db/schema.js';
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

beforeEach(() => {
  process.env.OUTPOST_ALLOWED_GITHUB_IDS = String(GITHUB_ID);
});
afterEach(() => {
  delete process.env.OUTPOST_ALLOWED_GITHUB_IDS;
});

function seedSandbox(db: Db): string {
  const row = insertSandbox(db, {
    id: 'sbx-1',
    name: 'my-box',
    provider: 'fly',
    status: 'running',
    providerRef: 'machine-1',
  });
  return row.id;
}

function makeApp() {
  const db = makeTestDb();
  const app = buildApp({
    db,
    githubConfig: testGithubConfig,
    sandboxService: makeFakeSandboxService(db),
    sessionManager: makeStubSessionManager(),
    credentialsService: makeFakeCredentialsService(db),
    collectorToken: testCollectorToken,
  });
  const token = generateSessionToken();
  createSession(db, token, { githubId: GITHUB_ID, githubLogin: 'octocat' });
  const id = seedSandbox(db);
  return { app, db, id, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

describe('ports routes', () => {
  it('rejects DENIED port 8022 with 422', async () => {
    const { app, id, cookie } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${id}/ports`,
      headers: { cookie },
      payload: { port: 8022 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: 'port not allowed' });
  });

  it('creates a port (201) then 409 on duplicate', async () => {
    const { app, id, cookie } = makeApp();
    const first = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${id}/ports`,
      headers: { cookie },
      payload: { port: 3000 },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ port: 3000, public: false });

    const dup = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${id}/ports`,
      headers: { cookie },
      payload: { port: 3000 },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'port already registered' });
  });

  it('PATCH toggle public appends a port.exposed event', async () => {
    const { app, db, id, cookie } = makeApp();
    await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${id}/ports`,
      headers: { cookie },
      payload: { port: 3000 },
    });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/sandboxes/${id}/ports/3000`,
      headers: { cookie },
      payload: { public: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ port: 3000, public: true });

    const rows = db.select().from(events).all();
    const exposed = rows.find((r) => r.kind === 'port.exposed');
    expect(exposed).toBeDefined();
    expect(exposed?.sandboxId).toBe(id);
    expect(exposed?.payload).toEqual({ port: 3000 });
  });

  it('DELETE returns 204 and the port is gone', async () => {
    const { app, id, cookie } = makeApp();
    await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${id}/ports`,
      headers: { cookie },
      payload: { port: 3000 },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/sandboxes/${id}/ports/3000`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: `/api/sandboxes/${id}/ports`,
      headers: { cookie },
    });
    expect(list.json().ports).toEqual([]);
  });

  it('url is null when no preview domain configured', async () => {
    const { app, id, cookie } = makeApp();
    await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${id}/ports`,
      headers: { cookie },
      payload: { port: 3000 },
    });
    const list = await app.inject({
      method: 'GET',
      url: `/api/sandboxes/${id}/ports`,
      headers: { cookie },
    });
    expect(list.json().ports[0].url).toBeNull();
  });

  it('all routes require a session cookie (401 without)', async () => {
    const { app, id } = makeApp();
    const get = await app.inject({ method: 'GET', url: `/api/sandboxes/${id}/ports` });
    expect(get.statusCode).toBe(401);
    const post = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/${id}/ports`,
      payload: { port: 3000 },
    });
    expect(post.statusCode).toBe(401);
  });

  it('404 when the sandbox does not exist', async () => {
    const { app, cookie } = makeApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/sandboxes/nope/ports`,
      headers: { cookie },
      payload: { port: 3000 },
    });
    expect(res.statusCode).toBe(404);
  });
});
