import { describe, expect, it } from 'vitest';
import { OutpostError } from '@outpost/shared-api';
import { buildApp } from '../index.js';

describe('server app', () => {
  it('GET /health returns 200 {ok:true}', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('maps OutpostError to its httpStatus and safe body', async () => {
    const app = buildApp();
    app.get('/boom', () => {
      throw new OutpostError('NOT_FOUND', 404, 'no such sandbox');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'no such sandbox' } });
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const app = buildApp();
    app.get('/crash', () => {
      throw new Error('secret internal detail');
    });
    const res = await app.inject({ method: 'GET', url: '/crash' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(res.body).not.toContain('secret internal detail');
  });
});
