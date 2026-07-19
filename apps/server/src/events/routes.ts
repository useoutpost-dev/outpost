import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { listEvents, countEvents } from '../db/events.repo.js';

const querySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v === undefined ? 20 : parseInt(v, 10);
      return Number.isNaN(n) ? 20 : Math.min(Math.max(n, 1), 100);
    }),
  offset: z
    .string()
    .optional()
    .transform((v) => {
      const n = v === undefined ? 0 : parseInt(v, 10);
      return Number.isNaN(n) ? 0 : Math.max(n, 0);
    }),
});

/**
 * GET /api/events — paginated event feed, session-gated by the global auth gate.
 */
export function registerEventRoutes(
  app: FastifyInstance,
  deps: { db: Db },
): void {
  const { db } = deps;

  app.get('/api/events', async (req, reply) => {
    const result = querySchema.safeParse(req.query);
    if (!result.success) {
      const fieldNames = result.error.issues.map((i) => i.path.join('.')).join(', ');
      return reply
        .status(400)
        .send({ error: { code: 'BAD_REQUEST', message: `validation failed: ${fieldNames}` } });
    }
    const { limit, offset } = result.data;
    const rows = listEvents(db, { limit, offset });
    const total = countEvents(db);
    const eventsOut = rows.map((r) => ({
      id: r.id,
      ts: r.ts instanceof Date ? r.ts.getTime() : Number(r.ts),
      kind: r.kind,
      sandboxId: r.sandboxId ?? null,
      payload: r.payload ?? null,
    }));
    return reply.status(200).send({ events: eventsOut, total });
  });
}
