import { describe, expect, it } from 'vitest';
import { OutpostError, type SandboxSpec } from '@outpost/shared-api';
import { createFlyProvider, type PollConfig } from '../sandboxes/providers/fly/fly-provider.js';
import { type Fetcher } from '../sandboxes/providers/fly/fly-client.js';

const APP = 'outpost-sandboxes';
const FAST_POLL: PollConfig = { startMs: 1, maxIntervalMs: 2, totalMs: 50 };

function baseConfig(poll: PollConfig = FAST_POLL) {
  return { apiToken: 'tok', app: APP, region: 'iad', poll };
}

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    name: 'my-box',
    image: 'registry/img:1',
    env: { FOO: 'bar', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4317' },
    resources: { cpus: 2, memoryMb: 2048, diskGb: 20 },
    volumes: [],
    ...overrides,
  };
}

interface Recorded {
  url: string;
  method: string;
  body?: unknown;
}

type Handler = (rec: Recorded) => Response;

/**
 * Scripted fetcher: each matcher is (predicate, handler). First match wins.
 * Records every call for assertion.
 */
function scriptedFetcher(routes: Array<[(rec: Recorded) => boolean, Handler]>): {
  fetcher: Fetcher;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetcher: Fetcher = async (url, init) => {
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(rec);
    for (const [pred, handler] of routes) {
      if (pred(rec)) return handler(rec);
    }
    throw new Error(`no route for ${rec.method} ${rec.url}`);
  };
  return { fetcher, calls };
}

const json = (obj: unknown, status = 200): Response =>
  new Response(JSON.stringify(obj), { status });

const isCreateVolume = (r: Recorded) => r.method === 'POST' && r.url.endsWith('/volumes');
const isDeleteVolume = (r: Recorded) => r.method === 'DELETE' && r.url.includes('/volumes/');
const isCreateMachine = (r: Recorded) => r.method === 'POST' && r.url.endsWith('/machines');
const isGetMachine = (r: Recorded) =>
  r.method === 'GET' && /\/machines\/[^/?]+$/.test(r.url);
const isDestroyMachine = (r: Recorded) => r.method === 'DELETE' && r.url.includes('/machines/');

describe('fly-provider create — happy path', () => {
  it('provisions volume, creates machine, polls to started, returns mapped sandbox', async () => {
    let polls = 0;
    const { fetcher, calls } = scriptedFetcher([
      [isCreateVolume, () => json({ id: 'vol_9', region: 'iad' })],
      [isCreateMachine, () => json({ id: 'm_9', name: 'my-box', state: 'created' })],
      [
        isGetMachine,
        () => {
          polls += 1;
          const state = polls < 2 ? 'starting' : 'started';
          return json({
            id: 'm_9',
            name: 'my-box',
            state,
            private_ip: 'fdaa::3',
            config: { mounts: [{ volume: 'vol_9', path: '/workspace' }] },
          });
        },
      ],
    ]);

    const provider = createFlyProvider(baseConfig(), fetcher);
    const sandbox = await provider.create(spec());

    expect(sandbox.id).toBe('m_9');
    expect(sandbox.volumeRef).toBe('vol_9');
    expect(sandbox.status).toBe('running');
    expect(sandbox.privateIp).toBe('fdaa::3');

    // Volume created in the same region as config; env passed verbatim; mount at /workspace.
    const volCall = calls.find(isCreateVolume)!;
    expect(volCall.body).toMatchObject({ region: 'iad', size_gb: 20 });
    const machCall = calls.find(isCreateMachine)!;
    expect(machCall.body).toMatchObject({
      name: 'my-box',
      region: 'iad',
      config: {
        image: 'registry/img:1',
        env: { FOO: 'bar', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4317' },
        guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 },
        mounts: [{ volume: 'vol_9', path: '/workspace' }],
      },
    });
    // volume name derived from spec name, [a-z0-9_] only
    expect((volCall.body as { name: string }).name).toMatch(/^ws_[a-z0-9_]+$/);
  });

  it('rejects a spec that carries volumes with BAD_REQUEST and provisions nothing', async () => {
    const { fetcher, calls } = scriptedFetcher([]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    await expect(
      provider.create(spec({ volumes: [{ volumeId: 'v', path: '/x' }] })),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', httpStatus: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe('fly-provider create — failure cleanup', () => {
  it('cleans up the volume and rethrows the original error when machine create fails', async () => {
    const { fetcher, calls } = scriptedFetcher([
      [isCreateVolume, () => json({ id: 'vol_c', region: 'iad' })],
      [isCreateMachine, () => new Response('machine quota exceeded', { status: 422 })],
      [isDeleteVolume, () => new Response(null, { status: 200 })],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);

    const err = (await provider.create(spec()).catch((e) => e)) as OutpostError;
    // Original error (from machine create) surfaces, not a cleanup error.
    expect(err.code).toBe('PROVIDER_ERROR');
    // Volume was deleted; no machine destroy attempted (none created).
    expect(calls.some(isDeleteVolume)).toBe(true);
    expect(calls.some(isDestroyMachine)).toBe(false);
  });

  it('destroys the machine then deletes the volume when polling times out', async () => {
    const { fetcher, calls } = scriptedFetcher([
      [isCreateVolume, () => json({ id: 'vol_t', region: 'iad' })],
      [isCreateMachine, () => json({ id: 'm_t', state: 'created' })],
      [isGetMachine, () => json({ id: 'm_t', state: 'starting' })], // never started
      [isDestroyMachine, () => new Response(null, { status: 200 })],
      [isDeleteVolume, () => new Response(null, { status: 200 })],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);

    const err = (await provider.create(spec()).catch((e) => e)) as OutpostError;
    expect(err.code).toBe('TIMEOUT');
    expect(err.httpStatus).toBe(504);

    const destroyIdx = calls.findIndex(isDestroyMachine);
    const deleteIdx = calls.findIndex(isDeleteVolume);
    expect(destroyIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(destroyIdx); // machine destroyed before volume
  });

  it('surfaces the original timeout even if cleanup itself fails', async () => {
    const { fetcher } = scriptedFetcher([
      [isCreateVolume, () => json({ id: 'vol_t', region: 'iad' })],
      [isCreateMachine, () => json({ id: 'm_t', state: 'created' })],
      [isGetMachine, () => json({ id: 'm_t', state: 'starting' })],
      [isDestroyMachine, () => new Response('cannot destroy', { status: 500 })],
      [isDeleteVolume, () => new Response('cannot delete', { status: 500 })],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    const err = (await provider.create(spec()).catch((e) => e)) as OutpostError;
    expect(err.code).toBe('TIMEOUT'); // cleanup failure did not mask it
  });
});

describe('fly-provider destroy', () => {
  it('destroys the machine then deletes its mounted volumes', async () => {
    let destroyed = false;
    const { fetcher, calls } = scriptedFetcher([
      [
        isGetMachine,
        () =>
          json({
            id: 'm_1',
            state: destroyed ? 'destroyed' : 'started',
            config: { mounts: [{ volume: 'vol_1', path: '/workspace' }] },
          }),
      ],
      [
        isDestroyMachine,
        () => {
          destroyed = true;
          return new Response(null, { status: 200 });
        },
      ],
      [isDeleteVolume, () => new Response(null, { status: 200 })],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    await provider.destroy('m_1');

    const destroyIdx = calls.findIndex(isDestroyMachine);
    const deleteIdx = calls.findIndex(isDeleteVolume);
    expect(destroyIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(destroyIdx);
    expect(calls.find(isDeleteVolume)!.url).toContain('/volumes/vol_1');
  });

  it('waits out async machine destruction before deleting the volume', async () => {
    // Fly destroys machines asynchronously; the volume stays attached while the
    // machine reports 'destroying'. The volume delete must come only after the
    // machine is gone (404) or 'destroyed'.
    let destroyCalled = false;
    let pollsAfterDestroy = 0;
    const { fetcher, calls } = scriptedFetcher([
      [
        isGetMachine,
        () => {
          if (!destroyCalled) {
            return json({
              id: 'm_r',
              state: 'started',
              config: { mounts: [{ volume: 'vol_r', path: '/workspace' }] },
            });
          }
          pollsAfterDestroy += 1;
          if (pollsAfterDestroy < 3) return json({ id: 'm_r', state: 'destroying' });
          return new Response('not found', { status: 404 });
        },
      ],
      [
        isDestroyMachine,
        () => {
          destroyCalled = true;
          return new Response(null, { status: 200 });
        },
      ],
      [isDeleteVolume, () => new Response(null, { status: 200 })],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    await provider.destroy('m_r');

    // The volume delete happened, and only after the machine reported gone.
    expect(pollsAfterDestroy).toBe(3);
    const deleteIdx = calls.findIndex(isDeleteVolume);
    const lastGetIdx = calls.map(isGetMachine).lastIndexOf(true);
    expect(deleteIdx).toBeGreaterThan(lastGetIdx);
  });

  it('fails with TIMEOUT and leaves the volume when the machine never detaches', async () => {
    let destroyCalled = false;
    const { fetcher, calls } = scriptedFetcher([
      [
        isGetMachine,
        () =>
          json({
            id: 'm_s',
            state: destroyCalled ? 'destroying' : 'started', // never completes
            config: { mounts: [{ volume: 'vol_s', path: '/workspace' }] },
          }),
      ],
      [
        isDestroyMachine,
        () => {
          destroyCalled = true;
          return new Response(null, { status: 200 });
        },
      ],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    const err = (await provider.destroy('m_s').catch((e) => e)) as OutpostError;
    expect(err.code).toBe('TIMEOUT');
    // No volume delete was attempted against a still-attached volume.
    expect(calls.some(isDeleteVolume)).toBe(false);
  });

  it('treats a 404 machine as a successful destroy (already gone)', async () => {
    const { fetcher, calls } = scriptedFetcher([
      [isGetMachine, () => new Response('not found', { status: 404 })],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    await expect(provider.destroy('gone')).resolves.toBeUndefined();
    expect(calls.some(isDestroyMachine)).toBe(false);
    expect(calls.some(isDeleteVolume)).toBe(false);
  });
});

describe('fly-provider get / list state mapping', () => {
  const cases: Array<[string, string]> = [
    ['created', 'creating'],
    ['starting', 'creating'],
    ['started', 'running'],
    ['stopping', 'stopped'],
    ['stopped', 'stopped'],
    ['suspended', 'stopped'],
    ['destroying', 'destroyed'],
    ['destroyed', 'destroyed'],
    ['failed', 'error'],
    ['some_unknown_state', 'error'],
  ];

  for (const [flyState, expected] of cases) {
    it(`maps Fly state '${flyState}' to '${expected}'`, async () => {
      const { fetcher } = scriptedFetcher([
        [isGetMachine, () => json({ id: 'm_1', state: flyState })],
      ]);
      const provider = createFlyProvider(baseConfig(), fetcher);
      const sb = await provider.get('m_1');
      expect(sb?.status).toBe(expected);
    });
  }

  it('get returns null on a Fly 404', async () => {
    const { fetcher } = scriptedFetcher([
      [isGetMachine, () => new Response('not found', { status: 404 })],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    await expect(provider.get('nope')).resolves.toBeNull();
  });

  it('list returns all machines in the app', async () => {
    const { fetcher } = scriptedFetcher([
      [
        (r) => r.method === 'GET' && r.url.endsWith('/machines'),
        () =>
          json([
            { id: 'm_1', state: 'started' },
            { id: 'm_2', state: 'stopped' },
          ]),
      ],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    const list = await provider.list();
    expect(list.map((s) => s.id)).toEqual(['m_1', 'm_2']);
    expect(list.map((s) => s.status)).toEqual(['running', 'stopped']);
  });
});

describe('fly-provider stop and unimplemented methods', () => {
  it('stop posts to the machine stop endpoint', async () => {
    const { fetcher, calls } = scriptedFetcher([
      [(r) => r.method === 'POST' && r.url.endsWith('/stop'), () => new Response(null, { status: 200 })],
    ]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    await provider.stop('m_1');
    expect(calls[0]!.url).toContain('/machines/m_1/stop');
  });

  it('exec, mount and ports throw INTERNAL 501 (Phase 3)', async () => {
    const { fetcher } = scriptedFetcher([]);
    const provider = createFlyProvider(baseConfig(), fetcher);
    await expect(provider.exec('m_1', ['ls'])).rejects.toMatchObject({
      code: 'INTERNAL',
      httpStatus: 501,
    });
    await expect(provider.mount('m_1', { volumeId: 'v', path: '/x' })).rejects.toMatchObject({
      code: 'INTERNAL',
      httpStatus: 501,
    });
    await expect(provider.ports('m_1')).rejects.toMatchObject({
      code: 'INTERNAL',
      httpStatus: 501,
    });
  });
});
