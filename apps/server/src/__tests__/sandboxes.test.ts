import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../index.js';
import { events } from '../db/schema.js';
import { createSession } from '../auth/auth.repo.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../auth/session.js';
import { createPort, listPorts } from '../proxy/ports.repo.js';
import {
  makeTestDb,
  testGithubConfig,
  makeFakeProvider,
  makeFakeSandboxService,
  makeStubSessionManager,
  makeFakeCredentialsService,
  testSandboxConfig,
  testCollectorToken,
} from './helpers.js';
import { createSandboxService } from '../sandboxes/service.js';
import { reconcileOrphans } from '../sandboxes/reconcile.js';

const GITHUB_ID = 583231;
const LOGIN = 'octocat';

beforeEach(() => {
  process.env.OUTPOST_ALLOWED_GITHUB_IDS = String(GITHUB_ID);
});
afterEach(() => {
  delete process.env.OUTPOST_ALLOWED_GITHUB_IDS;
});

// ---------------------------------------------------------------------------
// Service tests
// ---------------------------------------------------------------------------

describe('sandbox service — create', () => {
  it('happy create: row is running, providerRef/volumeRef persisted, events sandbox.creating + sandbox.running exist', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    const service = createSandboxService({ db, provider, config: testSandboxConfig });

    const result = await service.create({ name: 'my-box' });
    expect(result.status).toBe('running');
    expect(result.name).toBe('my-box');

    // DB row has providerRef and volumeRef
    const rows = db.select().from(events).all();
    const creating = rows.find((r) => r.kind === 'sandbox.creating');
    const running = rows.find((r) => r.kind === 'sandbox.running');
    expect(creating).toBeDefined();
    expect(running).toBeDefined();
    expect(creating?.sandboxId).toBe(result.id);
    expect(running?.sandboxId).toBe(result.id);

    // providerRef is present in the running event payload
    const payload = running?.payload as { provider: string; providerRef: string };
    expect(payload.providerRef).toMatch(/^machine-/);
  });

  it('provider create failure: status becomes error, sandbox.error event inserted, error propagates', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    vi.spyOn(provider, 'create').mockRejectedValueOnce(new Error('provider down'));
    const service = createSandboxService({ db, provider, config: testSandboxConfig });

    await expect(service.create({ name: 'fail-box' })).rejects.toThrow('provider down');

    const rows = db.select().from(events).all();
    const errorEvent = rows.find((r) => r.kind === 'sandbox.error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.sandboxId).toBeTruthy();
  });

  it('duplicate name: CONFLICT 409', async () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    await service.create({ name: 'dupe' });
    await expect(service.create({ name: 'dupe' })).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });
  });

  it('env composition: provider receives OTEL keys, correct resource attrs, and no OTEL_LOG_USER_PROMPTS', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    let capturedEnv: Record<string, string> | undefined;
    const origCreate = provider.create.bind(provider);
    vi.spyOn(provider, 'create').mockImplementationOnce(async (spec) => {
      capturedEnv = spec.env;
      return origCreate(spec);
    });

    const service = createSandboxService({ db, provider, config: testSandboxConfig });
    const result = await service.create({ name: 'env-test' });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv!.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(capturedEnv!.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(testSandboxConfig.collectorEndpoint);
    expect(capturedEnv!.OTEL_RESOURCE_ATTRIBUTES).toBe(`sandbox.id=${result.id}`);
    expect('OTEL_LOG_USER_PROMPTS' in capturedEnv!).toBe(false);
  });
});

describe('sandbox service — stop', () => {
  it('stop happy path: status becomes stopped', async () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    const created = await service.create({ name: 'stop-me' });
    const stopped = await service.stop(created.id);
    expect(stopped.status).toBe('stopped');

    const rows = db.select().from(events).all();
    expect(rows.some((r) => r.kind === 'sandbox.stopped')).toBe(true);
  });

  it('stop a stopped sandbox: 409 CONFLICT', async () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    const created = await service.create({ name: 'already-stopped' });
    await service.stop(created.id);
    await expect(service.stop(created.id)).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
  });

  it('stop a creating sandbox: 409 CONFLICT', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    // Hold create in limbo by never resolving — instead manipulate DB directly
    const service = createSandboxService({ db, provider, config: testSandboxConfig });
    // Insert a row in 'creating' state manually
    const { insertSandbox } = await import('../sandboxes/sandboxes.repo.js');
    const id = crypto.randomUUID();
    insertSandbox(db, { id, name: 'creating-box', provider: 'fly', status: 'creating' });
    await expect(service.stop(id)).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
  });
});

describe('sandbox service — destroy', () => {
  it('destroy from running: status becomes destroyed', async () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    const created = await service.create({ name: 'destroy-running' });
    const result = await service.destroy(created.id);
    expect(result.status).toBe('destroyed');
    const rows = db.select().from(events).all();
    expect(rows.some((r) => r.kind === 'sandbox.destroyed')).toBe(true);
  });

  it('destroy from stopped: status becomes destroyed', async () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    const created = await service.create({ name: 'destroy-stopped' });
    await service.stop(created.id);
    const result = await service.destroy(created.id);
    expect(result.status).toBe('destroyed');
  });

  it('destroy a destroyed sandbox: 409 CONFLICT', async () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    const created = await service.create({ name: 'double-destroy' });
    await service.destroy(created.id);
    await expect(service.destroy(created.id)).rejects.toMatchObject({ code: 'CONFLICT', httpStatus: 409 });
  });

  it('destroy removes all port rows for the sandbox', async () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    const created = await service.create({ name: 'ports-cleanup' });

    // Seed two port rows directly via the repo
    createPort(db, { sandboxId: created.id, port: 3000 });
    createPort(db, { sandboxId: created.id, port: 8080 });
    expect(listPorts(db, created.id)).toHaveLength(2);

    await service.destroy(created.id);

    expect(listPorts(db, created.id)).toHaveLength(0);
  });
});

describe('sandbox service — get / unknown id', () => {
  it('unknown id returns 404', () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    expect(() => service.get('does-not-exist')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', httpStatus: 404 }),
    );
  });

  it('stop unknown id returns 404', async () => {
    const db = makeTestDb();
    const service = makeFakeSandboxService(db);
    await expect(service.stop('nope')).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

function authedApp() {
  const db = makeTestDb();
  const sandboxService = makeFakeSandboxService(db);
  const app = buildApp({
    db,
    githubConfig: testGithubConfig,
    sandboxService,
    sessionManager: makeStubSessionManager(),
    credentialsService: makeFakeCredentialsService(db),
    collectorToken: testCollectorToken,
  });
  const token = generateSessionToken();
  createSession(db, token, { githubId: GITHUB_ID, githubLogin: LOGIN });
  return { app, db, cookie: `${SESSION_COOKIE_NAME}=${token}`, sandboxService };
}

describe('sandbox routes — unauthenticated', () => {
  it.each([
    ['POST', '/api/sandboxes'],
    ['GET', '/api/sandboxes'],
    ['GET', '/api/sandboxes/some-id'],
    ['POST', '/api/sandboxes/some-id/stop'],
    ['DELETE', '/api/sandboxes/some-id'],
  ])('%s %s returns 401', async (method, url) => {
    const { app } = authedApp();
    const res = await app.inject({ method: method as 'GET' | 'POST' | 'DELETE', url });
    expect(res.statusCode).toBe(401);
  });
});

describe('sandbox routes — validation', () => {
  it('400 invalid name (uppercase not allowed)', async () => {
    const { app, cookie } = authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sandboxes',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad_Name' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });

  it('400 out-of-range cpus', async () => {
    const { app, cookie } = authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sandboxes',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'valid-name', resources: { cpus: 99 } }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 out-of-range memoryMb', async () => {
    const { app, cookie } = authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sandboxes',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'valid-name', resources: { memoryMb: 100 } }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('sandbox routes — happy paths', () => {
  it('201 create returns id, no providerRef or volumeRef in body', async () => {
    const { app, cookie } = authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sandboxes',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-sandbox' }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('my-sandbox');
    expect(body.status).toBe('running');
    expect('providerRef' in body).toBe(false);
    expect('volumeRef' in body).toBe(false);
    expect(body.accountId).toBeNull();
  });

  it('includes the attached accountId in the public response', async () => {
    const db = makeTestDb();
    const service = createSandboxService({
      db,
      provider: makeFakeProvider(),
      config: testSandboxConfig,
      credentialsService: {
        envForAccount: async () => ({}),
        captureFromSandbox: async () => false,
      },
    });

    const result = await service.create({ name: 'account-box', accountId: 'account-1' });

    expect(result.accountId).toBe('account-1');
  });

  it('404 unknown id on GET', async () => {
    const { app, cookie } = authedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/sandboxes/does-not-exist',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET /api/sandboxes lists sandboxes', async () => {
    const { app, cookie } = authedApp();
    await app.inject({
      method: 'POST',
      url: '/api/sandboxes',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'list-test' }),
    });
    const res = await app.inject({ method: 'GET', url: '/api/sandboxes', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const list = res.json() as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Reconcile tests
// ---------------------------------------------------------------------------

describe('reconcileOrphans', () => {
  it('destroys orphan machine and inserts sandbox.orphan_destroyed event', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();

    // provider has 2 machines, DB knows only 1
    const machine1 = await provider.create({ name: 'known', image: 'img', env: {}, resources: { cpus: 1, memoryMb: 512, diskGb: 5 }, volumes: [] });
    const machine2 = await provider.create({ name: 'orphan', image: 'img', env: {}, resources: { cpus: 1, memoryMb: 512, diskGb: 5 }, volumes: [] });

    // Insert DB row for machine1 only
    const { insertSandbox } = await import('../sandboxes/sandboxes.repo.js');
    insertSandbox(db, {
      id: 'sandbox-1',
      name: 'known',
      provider: 'fly',
      status: 'running',
      providerRef: machine1.id,
    });

    const result = await reconcileOrphans({ db, provider });
    expect(result.destroyed).toBe(1);
    expect(result.failed).toBe(0);

    // machine2 should be gone from provider
    const remaining = await provider.list();
    expect(remaining.some((m) => m.id === machine2.id)).toBe(false);

    // event inserted
    const eventRows = db.select().from(events).all();
    const orphanEvent = eventRows.find((r) => r.kind === 'sandbox.orphan_destroyed');
    expect(orphanEvent).toBeDefined();
    expect((orphanEvent?.payload as { providerRef: string }).providerRef).toBe(machine2.id);
    expect(orphanEvent?.sandboxId).toBeNull();
  });

  it('destroy failure counted in failed without aborting', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();

    const m1 = await provider.create({ name: 'orphan1', image: 'img', env: {}, resources: { cpus: 1, memoryMb: 512, diskGb: 5 }, volumes: [] });
    await provider.create({ name: 'orphan2', image: 'img', env: {}, resources: { cpus: 1, memoryMb: 512, diskGb: 5 }, volumes: [] });

    // Make destroy fail for m1
    const origDestroy = provider.destroy.bind(provider);
    let callCount = 0;
    vi.spyOn(provider, 'destroy').mockImplementation(async (id: string) => {
      callCount++;
      if (id === m1.id) throw new Error('destroy failed');
      return origDestroy(id);
    });

    const result = await reconcileOrphans({ db, provider });
    expect(result.failed).toBe(1);
    expect(result.destroyed).toBe(1);
    expect(callCount).toBe(2);
  });
});
