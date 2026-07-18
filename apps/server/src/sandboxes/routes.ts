import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { OutpostError } from '@outpost/shared-api';
import type { SandboxService } from './service.js';

const nameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'invalid sandbox name');

const resourcesSchema = z
  .object({
    cpus: z.int().min(1).max(8),
    memoryMb: z.int().min(256).max(16384),
    diskGb: z.int().min(1).max(50),
  })
  .partial()
  .optional();

const createBodySchema = z.object({
  name: nameSchema,
  resources: resourcesSchema,
  accountId: z.string().min(1).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldNames = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new OutpostError('BAD_REQUEST', 400, `validation failed: ${fieldNames}`);
  }
  return result.data;
}

export function registerSandboxRoutes(
  app: FastifyInstance,
  deps: { service: SandboxService },
): void {
  const { service } = deps;

  app.post('/api/sandboxes', async (req, reply) => {
    const input = parseBody(createBodySchema, req.body);
    const sandbox = await service.create(input);
    return reply.status(201).send(sandbox);
  });

  app.get('/api/sandboxes', async (_req, reply) => {
    return reply.send(service.list());
  });

  app.get('/api/sandboxes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(service.get(id));
  });

  app.post('/api/sandboxes/:id/stop', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sandbox = await service.stop(id);
    return reply.send(sandbox);
  });

  app.delete('/api/sandboxes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const sandbox = await service.destroy(id);
    return reply.send(sandbox);
  });
}
