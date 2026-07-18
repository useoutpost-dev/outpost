import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/client.js';
import { usageTotals, usagePerSandbox } from './usage.repo.js';
import { estimateUsage } from '@outpost/claude-adapters';

/** Rolling window for usage aggregation. */
const WINDOW_DAYS = 30;

function rollingStart(): Date {
  const d = new Date();
  d.setDate(d.getDate() - WINDOW_DAYS);
  return d;
}

/**
 * `GET /api/usage` — session-gated by the global auth gate already registered
 * on the app. No additional auth code here.
 */
export function registerUsageRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.get('/api/usage', async (req, reply) => {
    try {
      const since = rollingStart();
      const totals = usageTotals(db, { since });
      const perSandbox = usagePerSandbox(db, { since });
      const estimate = estimateUsage(totals, WINDOW_DAYS);
      return reply.status(200).send({ totals, perSandbox, estimate });
    } catch (err) {
      req.log.error(err, 'GET /api/usage failed');
      return reply.status(500).send({ error: 'internal error' });
    }
  });
}
