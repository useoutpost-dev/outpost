import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { OutpostError } from '@outpost/shared-api';
import { runMigrations } from './db/migrate.js';
import type { Db } from './db/client.js';
import { loadGithubConfig, type Fetcher, type GithubConfig } from './auth/github.js';
import { registerAuthGate, parseAllowedIds } from './auth/middleware.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerSandboxRoutes } from './sandboxes/routes.js';
import type { SandboxService } from './sandboxes/service.js';

export interface BuildAppOptions {
  db: Db;
  githubConfig: GithubConfig;
  /** Injectable fetcher so tests can stub GitHub without real network. */
  fetcher?: Fetcher;
  /** Sandbox service — required in production; tests supply a fake-provider-backed instance. */
  sandboxService: SandboxService;
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
  const { db, githubConfig, fetcher, sandboxService } = opts;
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
  registerSandboxRoutes(app, { service: sandboxService });

  return app;
}

export interface SandboxBootConfig {
  apiToken: string;
  app: string;
  region: string;
}

export interface BootConfig {
  githubConfig: GithubConfig;
  fly: SandboxBootConfig;
  sandbox: { image: string; collectorEndpoint: string };
}

/** Validate all required boot-time env; throw a loud error on any problem. */
export function loadBootConfig(env: NodeJS.ProcessEnv = process.env): BootConfig {
  // parseAllowedIds throws loudly on any non-numeric entry.
  if (parseAllowedIds(env).length === 0) {
    throw new Error('OUTPOST_ALLOWED_GITHUB_IDS is unset or empty; refusing to boot (would lock everyone out)');
  }
  const githubConfig = loadGithubConfig(env);

  const flyApiToken = env.FLY_API_TOKEN?.trim();
  if (!flyApiToken) throw new Error('FLY_API_TOKEN is required but unset or empty');

  const flyApp = env.FLY_SANDBOX_APP?.trim();
  if (!flyApp) throw new Error('FLY_SANDBOX_APP is required but unset or empty');

  const flyRegion = env.FLY_REGION?.trim();
  if (!flyRegion) throw new Error('FLY_REGION is required but unset or empty');

  const sandboxImage = env.OUTPOST_SANDBOX_IMAGE?.trim();
  if (!sandboxImage) throw new Error('OUTPOST_SANDBOX_IMAGE is required but unset or empty');

  const collectorEndpoint = env.OUTPOST_COLLECTOR_ENDPOINT?.trim();
  if (!collectorEndpoint) throw new Error('OUTPOST_COLLECTOR_ENDPOINT is required but unset or empty');

  return {
    githubConfig,
    fly: { apiToken: flyApiToken, app: flyApp, region: flyRegion },
    sandbox: { image: sandboxImage, collectorEndpoint },
  };
}

const isDirectRun = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');

if (isDirectRun) {
  try {
    const config = loadBootConfig();
    const db = runMigrations();

    // Boot-time import of Fly provider (parallel agent owns this file).
    const { createFlyProvider } = await import('./sandboxes/providers/fly/fly-provider.js');
    const { reconcileOrphans } = await import('./sandboxes/reconcile.js');
    const { createSandboxService } = await import('./sandboxes/service.js');

    const provider = createFlyProvider(config.fly);

    // Orphan sweep must complete before routes accept traffic.
    await reconcileOrphans({ db, provider });

    const sandboxService = createSandboxService({ db, provider, config: config.sandbox });
    const app = buildApp({ db, githubConfig: config.githubConfig, sandboxService });
    const port = Number(process.env.PORT ?? 3001);
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error('server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
