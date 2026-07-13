import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { OutpostError } from '@outpost/shared-api';
import { runMigrations } from './db/migrate.js';
import type { Db } from './db/client.js';
import { loadGithubConfig, type Fetcher, type GithubConfig } from './auth/github.js';
import { registerAuthGate, parseAllowedIds } from './auth/middleware.js';
import { registerAuthRoutes } from './auth/routes.js';

export interface BuildAppOptions {
  db: Db;
  githubConfig: GithubConfig;
  /** Injectable fetcher so tests can stub GitHub without real network. */
  fetcher?: Fetcher;
}

/**
 * Strip the query string from a URL for logging. The pino default req serializer
 * logs req.url including the query, which on /auth/callback would leak the
 * one-time OAuth `code`. Keep only the path (everything before the first '?').
 */
export function stripUrlQuery(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function buildApp(opts: BuildAppOptions) {
  const { db, githubConfig, fetcher } = opts;
  const app = Fastify({
    logger: {
      serializers: {
        // Never log the query string; it may carry the OAuth code on /auth/callback.
        req(req: { method: string; url: string }) {
          return { method: req.method, url: stripUrlQuery(req.url) };
        },
      },
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (OutpostError.is(err)) {
      return reply.status(err.httpStatus).send(err.toJSON());
    }
    app.log.error(err);
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  app.register(cookie);

  app.get('/health', () => ({ ok: true }));

  registerAuthGate(app, db);
  registerAuthRoutes(app, { db, githubConfig, fetcher });

  return app;
}

/** Validate all required boot-time env; throw a loud error on any problem. */
export function loadBootConfig(env: NodeJS.ProcessEnv = process.env): { githubConfig: GithubConfig } {
  // parseAllowedIds throws loudly on any non-numeric entry.
  if (parseAllowedIds(env).length === 0) {
    throw new Error('OUTPOST_ALLOWED_GITHUB_IDS is unset or empty; refusing to boot (would lock everyone out)');
  }
  const githubConfig = loadGithubConfig(env);
  return { githubConfig };
}

const isDirectRun = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');

if (isDirectRun) {
  try {
    const { githubConfig } = loadBootConfig();
    const db = runMigrations();
    const app = buildApp({ db, githubConfig });
    const port = Number(process.env.PORT ?? 3001);
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error('server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
