import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../index.js';
import { createSession } from '../../auth/auth.repo.js';
import { generateSessionToken, SESSION_COOKIE_NAME } from '../../auth/session.js';
import {
  makeTestDb,
  testGithubConfig,
  makeFakeSandboxService,
  makeStubSessionManager,
  makeFakeCredentialsService,
  testCollectorToken,
} from '../../__tests__/helpers.js';
import { events } from '../../db/schema.js';

const GITHUB_ID = 583231;
const LOGIN = 'octocat';

beforeEach(() => {
  process.env.OUTPOST_ALLOWED_GITHUB_IDS = String(GITHUB_ID);
});
afterEach(() => {
  delete process.env.OUTPOST_ALLOWED_GITHUB_IDS;
});

function authedApp() {
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
  createSession(db, token, { githubId: GITHUB_ID, githubLogin: LOGIN });
  return { app, db, cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/** Insert n events into the db. Timestamps are spaced 1ms apart (oldest first). */
function insertEvents(db: ReturnType<typeof makeTestDb>, count: number) {
  const base = Date.now();
  for (let i = 0; i < count; i++) {
    db.insert(events)
      .values({
        kind: 'test.event',
        ts: new Date(base + i),
        sandboxId: null,
        payload: { seq: i },
      })
      .run();
  }
}

describe('GET /api/events', () => {
  it('returns 20 rows for page 1 when 25 events exist, total=25, ordered newest-first', async () => {
    const { app, db, cookie } = authedApp();
    insertEvents(db, 25);

    const res = await app.inject({
      method: 'GET',
      url: '/api/events?limit=20&offset=0',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: Array<{ ts: number }>; total: number }>();
    expect(body.total).toBe(25);
    expect(body.events).toHaveLength(20);
    // newest-first: each ts should be >= the next
    for (let i = 0; i < body.events.length - 1; i++) {
      const cur = body.events[i]!;
      const next = body.events[i + 1]!;
      expect(cur.ts).toBeGreaterThanOrEqual(next.ts);
    }
  });

  it('returns remaining 5 rows for page 2 (offset=20)', async () => {
    const { app, db, cookie } = authedApp();
    insertEvents(db, 25);

    const res = await app.inject({
      method: 'GET',
      url: '/api/events?limit=20&offset=20',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: unknown[]; total: number }>();
    expect(body.total).toBe(25);
    expect(body.events).toHaveLength(5);
  });

  it('returns 401 when no session cookie is present', async () => {
    const { app } = authedApp();

    const res = await app.inject({ method: 'GET', url: '/api/events' });
    expect(res.statusCode).toBe(401);
  });

  it('caps limit at 100: requesting limit=200 returns at most 100 rows', async () => {
    const { app, db, cookie } = authedApp();
    insertEvents(db, 150);

    const res = await app.inject({
      method: 'GET',
      url: '/api/events?limit=200',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: unknown[]; total: number }>();
    expect(body.events).toHaveLength(100);
    expect(body.total).toBe(150);
  });

  it('serializes ts as epoch ms number', async () => {
    const { app, db, cookie } = authedApp();
    const now = new Date(2024, 0, 15, 12, 0, 0, 0);
    db.insert(events)
      .values({ kind: 'test.event', ts: now, sandboxId: null, payload: null })
      .run();

    const res = await app.inject({
      method: 'GET',
      url: '/api/events?limit=1',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ events: Array<{ ts: unknown }> }>();
    const firstEvent = body.events[0]!;
    expect(typeof firstEvent.ts).toBe('number');
    expect(firstEvent.ts).toBe(now.getTime());
  });
});
