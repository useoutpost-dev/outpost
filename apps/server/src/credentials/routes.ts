import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { OutpostError } from '@outpost/shared-api';
import type { CredentialsService } from './service.js';

const createBodySchema = z
  .object({
    label: z.string().min(1).max(64),
    kind: z.enum(['subscription', 'api_key']),
    apiKey: z.string().min(1).optional(),
  })
  .refine((v) => (v.kind === 'api_key' ? !!v.apiKey : !v.apiKey), {
    message: 'apiKey required iff kind is api_key',
    path: ['apiKey'],
  });

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldNames = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new OutpostError('BAD_REQUEST', 400, `validation failed: ${fieldNames}`);
  }
  return result.data;
}

export function registerCredentialRoutes(
  app: FastifyInstance,
  deps: { service: CredentialsService },
): void {
  const { service } = deps;

  app.get('/api/accounts', async (_req, reply) => {
    return reply.send(service.list());
  });

  app.post('/api/accounts', async (req, reply) => {
    const input = parseBody(createBodySchema, req.body);
    const account = await service.createAccount(input);
    return reply.status(201).send(account);
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    service.remove(id);
    return reply.status(204).send();
  });
}
