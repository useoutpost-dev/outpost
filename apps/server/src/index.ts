import Fastify from 'fastify';
import { OutpostError } from '@outpost/shared-api';
import { runMigrations } from './db/migrate.js';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err, _req, reply) => {
    if (OutpostError.is(err)) {
      return reply.status(err.httpStatus).send(err.toJSON());
    }
    app.log.error(err);
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  app.get('/health', () => ({ ok: true }));

  return app;
}

const isDirectRun = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');

if (isDirectRun) {
  try {
    runMigrations();
    const app = buildApp();
    const port = Number(process.env.PORT ?? 3001);
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    console.error('server failed to start:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
