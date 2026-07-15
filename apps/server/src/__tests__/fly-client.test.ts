import { describe, expect, it } from 'vitest';
import { OutpostError } from '@outpost/shared-api';
import { createFlyClient, type Fetcher } from '../sandboxes/providers/fly/fly-client.js';

const TOKEN = 'fly-token-abc';
const APP = 'outpost-sandboxes';

interface Call {
  url: string;
  method?: string;
  authHeader?: string;
  body?: unknown;
}

/** Records each request and returns a scripted Response. */
function recordingFetcher(response: () => Response): { fetcher: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method,
      authHeader: headers.get('authorization') ?? undefined,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return response();
  };
  return { fetcher, calls };
}

describe('fly-client requests', () => {
  it('createVolume POSTs name/region/size_gb with bearer auth', async () => {
    const { fetcher, calls } = recordingFetcher(
      () => new Response(JSON.stringify({ id: 'vol_1', region: 'iad' }), { status: 200 }),
    );
    const client = createFlyClient(TOKEN, APP, fetcher);
    const vol = await client.createVolume({ name: 'ws_x', region: 'iad', size_gb: 10 });

    expect(vol).toEqual({ id: 'vol_1', region: 'iad' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.machines.dev/v1/apps/${APP}/volumes`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.authHeader).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({ name: 'ws_x', region: 'iad', size_gb: 10 });
  });

  it('createMachine POSTs to /machines and returns the parsed machine', async () => {
    const { fetcher, calls } = recordingFetcher(
      () => new Response(JSON.stringify({ id: 'm_1', state: 'created' }), { status: 200 }),
    );
    const client = createFlyClient(TOKEN, APP, fetcher);
    const m = await client.createMachine({
      name: 'sb',
      region: 'iad',
      config: { image: 'img' },
    });

    expect(m).toEqual({ id: 'm_1', state: 'created' });
    expect(calls[0]!.url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines`);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ name: 'sb', region: 'iad', config: { image: 'img' } });
  });

  it('getMachine GETs the machine by id', async () => {
    const { fetcher, calls } = recordingFetcher(
      () => new Response(JSON.stringify({ id: 'm_1', state: 'started' }), { status: 200 }),
    );
    const client = createFlyClient(TOKEN, APP, fetcher);
    const m = await client.getMachine('m_1');

    expect(m.state).toBe('started');
    expect(calls[0]!.url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/m_1`);
    expect(calls[0]!.method).toBe('GET');
  });

  it('listMachines GETs the machines collection', async () => {
    const { fetcher, calls } = recordingFetcher(
      () => new Response(JSON.stringify([{ id: 'm_1', state: 'started' }]), { status: 200 }),
    );
    const client = createFlyClient(TOKEN, APP, fetcher);
    const list = await client.listMachines();

    expect(list).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines`);
    expect(calls[0]!.method).toBe('GET');
  });

  it('stopMachine POSTs to /stop', async () => {
    const { fetcher, calls } = recordingFetcher(() => new Response(null, { status: 200 }));
    const client = createFlyClient(TOKEN, APP, fetcher);
    await client.stopMachine('m_1');
    expect(calls[0]!.url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/m_1/stop`);
    expect(calls[0]!.method).toBe('POST');
  });

  it('destroyMachine DELETEs with force=true', async () => {
    const { fetcher, calls } = recordingFetcher(() => new Response(null, { status: 200 }));
    const client = createFlyClient(TOKEN, APP, fetcher);
    await client.destroyMachine('m_1');
    expect(calls[0]!.url).toBe(`https://api.machines.dev/v1/apps/${APP}/machines/m_1?force=true`);
    expect(calls[0]!.method).toBe('DELETE');
  });

  it('deleteVolume DELETEs the volume by id', async () => {
    const { fetcher, calls } = recordingFetcher(() => new Response(null, { status: 200 }));
    const client = createFlyClient(TOKEN, APP, fetcher);
    await client.deleteVolume('vol_1');
    expect(calls[0]!.url).toBe(`https://api.machines.dev/v1/apps/${APP}/volumes/vol_1`);
    expect(calls[0]!.method).toBe('DELETE');
  });
});

describe('fly-client error mapping', () => {
  it('maps a 5xx to PROVIDER_UNAVAILABLE (503)', async () => {
    const fetcher: Fetcher = async () => new Response('fly is down', { status: 503 });
    const client = createFlyClient(TOKEN, APP, fetcher);
    await expect(client.getMachine('m_1')).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      httpStatus: 503,
    });
  });

  it('maps a 4xx to PROVIDER_ERROR (502)', async () => {
    const fetcher: Fetcher = async () => new Response('bad request detail', { status: 422 });
    const client = createFlyClient(TOKEN, APP, fetcher);
    await expect(client.createVolume({ name: 'x', region: 'iad', size_gb: 1 })).rejects.toMatchObject(
      {
        code: 'PROVIDER_ERROR',
        httpStatus: 502,
      },
    );
  });

  it('maps a fetch rejection (network failure) to PROVIDER_UNAVAILABLE (503)', async () => {
    const fetcher: Fetcher = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = createFlyClient(TOKEN, APP, fetcher);
    await expect(client.listMachines()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      httpStatus: 503,
    });
  });

  it('never leaks the Fly response body into safeMessage, only into the cause', async () => {
    const secretBody = 'INTERNAL-FLY-DIAGNOSTIC-LEAK-TOKEN';
    const fetcher: Fetcher = async () => new Response(secretBody, { status: 400 });
    const client = createFlyClient(TOKEN, APP, fetcher);

    const err = (await client.getMachine('m_1').catch((e) => e)) as OutpostError;
    expect(err).toBeInstanceOf(OutpostError);
    expect(err.safeMessage).toBe('sandbox provider request failed');
    expect(err.safeMessage).not.toContain(secretBody);
    expect(err.message).not.toContain(secretBody);
    // The body IS present in the cause for server-side logging.
    expect(JSON.stringify(err.cause)).toContain(secretBody);
  });
});
