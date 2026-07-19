import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { PortInfo } from '@outpost/shared-api';
import type { Db } from '../db/client.js';
import { findSandboxById } from '../sandboxes/sandboxes.repo.js';
import {
  appendPortEvent,
  createPort,
  deletePort,
  getPort,
  listPorts,
  setPublic,
} from './ports.repo.js';

/**
 * Ports the proxy must never expose. 8022 is the in-sandbox terminal daemon —
 * proxying it would bypass the terminal auth path. Enforced BOTH here (POST is
 * rejected) and independently at the proxy layer (defense in depth).
 */
export const DENIED_PORTS = new Set<number>([8022]);

const createBodySchema = z.object({
  port: z.number().int().min(1).max(65535),
});

const patchBodySchema = z.object({
  public: z.boolean(),
});

/** Build the public preview URL for a port, or null when no domain is configured. */
function previewUrl(
  sandboxName: string,
  port: number,
  previewDomain: string | undefined,
): string | null {
  if (!previewDomain) return null;
  return `https://${sandboxName}-${port}.${previewDomain}`;
}

/**
 * Ports management API. All routes are session-gated by the global auth gate
 * (registerAuthGate) — no per-route auth code here. `:id` is validated against
 * the sandboxes table before any port operation (404 if absent).
 */
export function registerPortRoutes(
  app: FastifyInstance,
  deps: { db: Db; previewDomain?: string },
): void {
  const { db, previewDomain } = deps;

  app.get('/api/sandboxes/:id/ports', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sandbox = findSandboxById(db, id);
    if (!sandbox) return reply.status(404).send({ error: 'sandbox not found' });

    try {
      const rows = listPorts(db, id);
      const out: PortInfo[] = rows.map((r) => ({
        port: r.port,
        public: r.public,
        url: previewUrl(sandbox.name, r.port, previewDomain),
      }));
      return reply.status(200).send({ ports: out });
    } catch (err) {
      req.log.error(err, 'GET ports failed');
      return reply.status(500).send({ error: 'internal error' });
    }
  });

  app.post('/api/sandboxes/:id/ports', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sandbox = findSandboxById(db, id);
    if (!sandbox) return reply.status(404).send({ error: 'sandbox not found' });

    const parsed = createBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(422).send({ error: 'invalid port' });

    const { port } = parsed.data;
    if (DENIED_PORTS.has(port)) {
      return reply.status(422).send({ error: 'port not allowed' });
    }

    try {
      const row = createPort(db, { sandboxId: id, port });
      return reply.status(201).send({
        port: row.port,
        public: row.public,
        url: previewUrl(sandbox.name, row.port, previewDomain),
      });
    } catch (err) {
      // Unique-constraint (ports_sandbox_port_idx) → already registered.
      if (err instanceof Error && /UNIQUE|constraint/i.test(err.message)) {
        return reply.status(409).send({ error: 'port already registered' });
      }
      req.log.error(err, 'POST ports failed');
      return reply.status(500).send({ error: 'internal error' });
    }
  });

  app.patch('/api/sandboxes/:id/ports/:port', async (req, reply) => {
    const { id, port: portParam } = req.params as { id: string; port: string };
    const sandbox = findSandboxById(db, id);
    if (!sandbox) return reply.status(404).send({ error: 'sandbox not found' });

    const port = Number(portParam);
    if (!Number.isInteger(port)) return reply.status(422).send({ error: 'invalid port' });

    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(422).send({ error: 'invalid body' });

    try {
      const existing = getPort(db, id, port);
      if (!existing) return reply.status(404).send({ error: 'port not found' });

      setPublic(db, id, port, parsed.data.public);
      appendPortEvent(db, id, port, parsed.data.public ? 'port.exposed' : 'port.hidden');
      return reply.status(200).send({
        port,
        public: parsed.data.public,
        url: previewUrl(sandbox.name, port, previewDomain),
      });
    } catch (err) {
      req.log.error(err, 'PATCH ports failed');
      return reply.status(500).send({ error: 'internal error' });
    }
  });

  app.delete('/api/sandboxes/:id/ports/:port', async (req, reply) => {
    const { id, port: portParam } = req.params as { id: string; port: string };
    const sandbox = findSandboxById(db, id);
    if (!sandbox) return reply.status(404).send({ error: 'sandbox not found' });

    const port = Number(portParam);
    if (!Number.isInteger(port)) return reply.status(422).send({ error: 'invalid port' });

    try {
      const existing = getPort(db, id, port);
      if (!existing) return reply.status(404).send({ error: 'port not found' });
      deletePort(db, id, port);
      return reply.status(204).send();
    } catch (err) {
      req.log.error(err, 'DELETE ports failed');
      return reply.status(500).send({ error: 'internal error' });
    }
  });
}
