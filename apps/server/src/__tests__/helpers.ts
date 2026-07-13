import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { GithubConfig } from '../auth/github.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

/** A fresh, migrated in-memory SQLite DB for a single test. */
export function makeTestDb(): Db {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export const testGithubConfig: GithubConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  baseUrl: 'https://outpost.example',
};

import type { Fetcher } from '../auth/github.js';

/** A fetcher that returns a fixed access token then a fixed { id, login } user. */
export function stubFetcher(user: { id: number; login: string }): Fetcher {
  return async (url) => {
    if (url.includes('access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_secret' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ id: user.id, login: user.login }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
