import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import { OutpostError } from '@outpost/shared-api';
import { runMigrations } from './db/migrate.js';
import type { Db } from './db/client.js';
import { loadGithubConfig, type Fetcher, type GithubConfig } from './auth/github.js';
import { registerAuthGate, parseAllowedIds } from './auth/middleware.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerSandboxRoutes } from './sandboxes/routes.js';
import type { SandboxService } from './sandboxes/service.js';
import { registerCredentialRoutes } from './credentials/routes.js';
import type { CredentialsService } from './credentials/service.js';
import { registerTerminalRoute } from './terminal/ws.js';
import type { SessionManager } from './terminal/session-manager.js';
import { findSandboxById } from './sandboxes/sandboxes.repo.js';
import { registerCollectorRoutes } from './telemetry/collector.js';
import { registerUsageRoutes } from './telemetry/routes.js';

export interface BuildAppOptions {
  db: Db;
  githubConfig: GithubConfig;
  /** Injectable fetcher so tests can stub GitHub without real network. */
  fetcher?: Fetcher;
  /** Sandbox service — required in production; tests supply a fake-provider-backed instance. */
  sandboxService: SandboxService;
  /** Terminal session manager — gates and serves the terminal WS route. */
  sessionManager: SessionManager;
  /** Credential/account service — backs the /api/accounts routes. */
  credentialsService: CredentialsService;
  /** Bearer token the OTLP collector (`POST /v1/metrics`) requires. */
  collectorToken: string;
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
  const {
    db,
    githubConfig,
    fetcher,
    sandboxService,
    sessionManager,
    credentialsService,
    collectorToken,
  } = opts;
  const app = Fastify({
    logger: {
      serializers: {
        // Never log the query string; it may carry the OAuth code on /auth/callback.
        // Whitelist serializer: method + url only — request bodies (which carry
        // API keys on POST /api/accounts) must never reach the logger.
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
  // First-party Fastify WS transport for the terminal route. The global
  // onRequest auth gate still runs on the upgrade request before the handler.
  // maxPayload caps a single frame (1MB covers any paste) so one oversized
  // frame can't balloon memory before the ring buffer ever sees it.
  app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.get('/health', () => ({ ok: true }));

  registerAuthGate(app, db);
  registerAuthRoutes(app, { db, githubConfig, fetcher });
  registerSandboxRoutes(app, { service: sandboxService });
  registerCredentialRoutes(app, { service: credentialsService });
  registerCollectorRoutes(app, { db, collectorToken });
  registerUsageRoutes(app, { db });

  // WS route registration must be inside a plugin scope that has @fastify/websocket
  // loaded; register after the plugin above so `{ websocket: true }` is recognized.
  app.register(async (scope) => {
    registerTerminalRoute(scope, {
      sessionManager,
      allowedOrigin: githubConfig.baseUrl,
      lookupSandbox: (id) => {
        const row = findSandboxById(db, id);
        if (!row) return undefined;
        return { status: row.status, terminalToken: row.terminalToken };
      },
    });
  });

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
  sandbox: { image: string; collectorEndpoint: string; collectorToken: string };
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

  // Bearer token gating POST /v1/metrics and injected into every sandbox's
  // OTEL_EXPORTER_OTLP_HEADERS. Fail at boot, not on the first metric flush.
  // The error must never echo the token value.
  const collectorToken = env.OUTPOST_COLLECTOR_TOKEN?.trim();
  if (!collectorToken) throw new Error('OUTPOST_COLLECTOR_TOKEN is required but unset or empty');
  if (collectorToken.length < 32) {
    throw new Error('OUTPOST_COLLECTOR_TOKEN must be at least 32 characters (e.g. `openssl rand -hex 32`)');
  }

  // Fail at boot, not on the first account operation. Only the shape is checked
  // here (32 bytes base64); crypto.ts owns the actual key derivation. The error
  // must never echo the key value.
  const masterKey = env.OUTPOST_MASTER_KEY?.trim();
  if (!masterKey) throw new Error('OUTPOST_MASTER_KEY is required but unset or empty');
  if (Buffer.from(masterKey, 'base64').length !== 32) {
    throw new Error('OUTPOST_MASTER_KEY must be 32 bytes base64 (e.g. `openssl rand -base64 32`)');
  }

  return {
    githubConfig,
    fly: { apiToken: flyApiToken, app: flyApp, region: flyRegion },
    sandbox: { image: sandboxImage, collectorEndpoint, collectorToken },
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
    const { createSessionManager } = await import('./terminal/session-manager.js');
    const { createCredentialsService } = await import('./credentials/service.js');

    const provider = createFlyProvider(config.fly);

    // Orphan sweep must complete before routes accept traffic.
    await reconcileOrphans({ db, provider });

    const sessionManager = createSessionManager({
      provider,
      getTerminalToken: (id) => findSandboxById(db, id)?.terminalToken ?? null,
      log: { warn: (m) => console.warn(m), error: (m) => console.error(m) },
    });

    const credentialsService = createCredentialsService({ db, provider });

    const sandboxService = createSandboxService({
      db,
      provider,
      config: config.sandbox,
      onTeardown: (id) => sessionManager.destroy(id),
      credentialsService,
    });
    const app = buildApp({
      db,
      githubConfig: config.githubConfig,
      sandboxService,
      sessionManager,
      credentialsService,
      collectorToken: config.sandbox.collectorToken,
    });
    // Guard against an empty or non-numeric PORT (e.g. a blank `PORT=` line in
    // .env): Number('') is 0, which makes Node bind a random ephemeral port.
    const parsedPort = Number(process.env.PORT);
    const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 3001;
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error('server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
