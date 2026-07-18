import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerCollectorRoutes } from '../collector.js';
import { usage } from '../../db/schema.js';
import type { Db } from '../../db/client.js';
import { makeTestDb } from '../../__tests__/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readFixtureText = (name: string): string =>
  readFileSync(path.join(here, 'fixtures', name), 'utf-8');

const TOKEN = 'collector-token-0123456789abcdef-xyz';

function buildCollectorApp(db: Db) {
  const app = Fastify();
  registerCollectorRoutes(app, { db, collectorToken: TOKEN });
  return app;
}

function rowCount(db: Db): number {
  return db.select().from(usage).all().length;
}

describe('collector POST /v1/metrics', () => {
  let db: Db;
  let app: ReturnType<typeof buildCollectorApp>;

  beforeEach(() => {
    db = makeTestDb();
    app = buildCollectorApp(db);
  });

  afterEach(async () => {
    await app.close();
  });

  it('401 when the Authorization header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/metrics',
      payload: readFixtureText('otlp-valid.json'),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(401);
    expect(rowCount(db)).toBe(0);
  });

  it('401 when the bearer token is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/metrics',
      payload: readFixtureText('otlp-valid.json'),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong-token-but-same-lengthxxxxxx',
      },
    });
    expect(res.statusCode).toBe(401);
    expect(rowCount(db)).toBe(0);
  });

  it('200 + batch-inserts rows for a valid body with the correct token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/metrics',
      payload: readFixtureText('otlp-valid.json'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 3 });
    // One OTLP batch → one row per (sandbox, model), inserted in a single batch.
    expect(rowCount(db)).toBe(3);
  });

  it('400 unrecognized payload for a malformed body with the correct token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/metrics',
      payload: readFixtureText('otlp-malformed.json'),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'unrecognized payload' });
    expect(rowCount(db)).toBe(0);
  });
});
