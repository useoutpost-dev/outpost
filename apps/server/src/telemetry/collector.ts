import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { normalize } from './normalize.js';
import { insertUsageRows } from './usage.repo.js';

const BEARER_PREFIX = 'Bearer ';
/** 1 MB cap on a single metrics batch — a large OTLP flush stays well under this. */
const BODY_LIMIT_BYTES = 1_048_576;

/**
 * Constant-time compare of the presented bearer token against the configured
 * one. `timingSafeEqual` throws on length mismatch, so guard length first
 * (that leaks only the length, never the value).
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isAuthorized(req: FastifyRequest, collectorToken: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return false;
  return tokenMatches(header.slice(BEARER_PREFIX.length), collectorToken);
}

/**
 * Register the token-gated OTLP metrics collector. `/v1/metrics` is in
 * PUBLIC_PATHS (bypasses the session gate) precisely because it is gated by the
 * collector bearer token instead. The token and payload bodies are never logged.
 */
export function registerCollectorRoutes(
  app: FastifyInstance,
  deps: { db: Db; collectorToken: string },
): void {
  const { db, collectorToken } = deps;

  app.post(
    '/v1/metrics',
    { bodyLimit: BODY_LIMIT_BYTES },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // Auth is checked before the body is touched. 401 on any mismatch.
      if (!isAuthorized(req, collectorToken)) {
        return reply.status(401).send({ error: 'unauthorized' });
      }

      try {
        const rows = normalize(req.body);
        if (rows.length === 0) {
          return reply.status(400).send({ error: 'unrecognized payload' });
        }
        insertUsageRows(db, rows);
        return reply.status(200).send({ accepted: rows.length });
      } catch (err) {
        // A body that fastify could not parse arrives as a parse error; treat
        // it as a bad request. Never echo the payload back.
        if (err instanceof SyntaxError) {
          return reply.status(400).send({ error: 'unrecognized payload' });
        }
        // Server-side failure (e.g. DB write). Log the error object only — never
        // the request body or the token — and return an opaque 500.
        req.log.error(err, 'metrics collector failed');
        return reply.status(500).send({ error: 'internal error' });
      }
    },
  );
}
