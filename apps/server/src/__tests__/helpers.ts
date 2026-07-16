import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { GithubConfig } from '../auth/github.js';
import type { SandboxProvider, Sandbox, SandboxSpec } from '@outpost/shared-api';
import { createSandboxService } from '../sandboxes/service.js';

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

/** In-memory SandboxProvider for tests — never touches Fly. */
export function makeFakeProvider(
  opts: { terminalUrl?: (id: string) => string } = {},
): SandboxProvider & { machines: Map<string, Sandbox> } {
  const machines = new Map<string, Sandbox>();
  let counter = 0;

  return {
    machines,

    async create(spec: SandboxSpec): Promise<Sandbox> {
      const id = `machine-${++counter}`;
      const volumeRef = `vol-${counter}`;
      const sandbox: Sandbox = {
        id,
        name: spec.name,
        status: 'running',
        createdAt: new Date().toISOString(),
        volumeRef,
      };
      machines.set(id, sandbox);
      return sandbox;
    },

    async stop(id: string): Promise<void> {
      const m = machines.get(id);
      if (m) machines.set(id, { ...m, status: 'stopped' });
    },

    async destroy(id: string): Promise<void> {
      machines.delete(id);
    },

    async get(id: string): Promise<Sandbox | null> {
      return machines.get(id) ?? null;
    },

    async list(): Promise<Sandbox[]> {
      return Array.from(machines.values());
    },

    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },

    async terminalEndpoint(id: string) {
      return { url: opts.terminalUrl?.(id) ?? `ws://terminal.test/${id}` };
    },

    async mount() {},

    async ports() {
      return [];
    },
  };
}

export const testSandboxConfig = {
  image: 'outpost/sandbox:test',
  collectorEndpoint: 'http://collector.test:4318',
};

/** Build a sandbox service backed by a fake in-memory provider. */
export function makeFakeSandboxService(db: Db, provider?: SandboxProvider) {
  const p = provider ?? makeFakeProvider();
  return createSandboxService({ db, provider: p, config: testSandboxConfig });
}
