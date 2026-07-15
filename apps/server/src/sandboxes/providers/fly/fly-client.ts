import { OutpostError } from '@outpost/shared-api';

/**
 * Injectable fetcher so tests can stub the Fly Machines network (no real network in CI).
 * Mirrors the Phase 1 GitHub OAuth client pattern (apps/server/src/auth/github.ts).
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const BASE_URL = 'https://api.machines.dev/v1';

/**
 * Generic, body-free message returned to clients. Fly response bodies must NEVER
 * surface here — they go into the OutpostError cause for server-side logging only.
 */
const SAFE_MESSAGE = 'sandbox provider request failed';

/** Only the machine fields the provider actually consumes. */
export interface FlyMachineMount {
  volume: string;
  path: string;
}

export interface FlyMachineConfig {
  image?: string;
  env?: Record<string, string>;
  guest?: { cpu_kind: string; cpus: number; memory_mb: number };
  mounts?: FlyMachineMount[];
}

export interface FlyMachine {
  id: string;
  name?: string;
  state: string;
  private_ip?: string;
  config?: FlyMachineConfig;
}

/** Only the volume fields the provider actually consumes. */
export interface FlyVolume {
  id: string;
  name?: string;
  region?: string;
}

export interface CreateVolumeInput {
  name: string;
  region: string;
  size_gb: number;
}

export interface CreateMachineInput {
  name: string;
  region: string;
  config: FlyMachineConfig;
}

/**
 * Wraps a fetch failure or non-2xx response in an OutpostError, keeping the Fly
 * body out of safeMessage. Network failure / 5xx -> PROVIDER_UNAVAILABLE (503);
 * any other non-2xx -> PROVIDER_ERROR (502).
 */
function unavailable(cause: unknown): OutpostError {
  return new OutpostError('PROVIDER_UNAVAILABLE', 503, SAFE_MESSAGE, { cause });
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Thin, typed wrapper over the Fly Machines API. Every method maps I/O errors to
 * OutpostError; no Fly response text ever appears in safeMessage.
 */
export interface FlyClient {
  createVolume(input: CreateVolumeInput): Promise<FlyVolume>;
  deleteVolume(volumeId: string): Promise<void>;
  createMachine(input: CreateMachineInput): Promise<FlyMachine>;
  getMachine(machineId: string): Promise<FlyMachine>;
  listMachines(): Promise<FlyMachine[]>;
  stopMachine(machineId: string): Promise<void>;
  destroyMachine(machineId: string): Promise<void>;
}

export function createFlyClient(
  apiToken: string,
  app: string,
  fetcher: Fetcher = fetch,
): FlyClient {
  /**
   * Single request primitive. Distinguishes network failures / 5xx
   * (PROVIDER_UNAVAILABLE) from other non-2xx (PROVIDER_ERROR). Returns the raw
   * Response so callers decide whether to parse JSON.
   */
  async function request(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetcher(`${BASE_URL}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
      });
    } catch (cause) {
      throw unavailable({ path, kind: 'network', cause });
    }

    if (res.ok) return res;

    const bodyText = await readBodyText(res);
    const cause = { path, status: res.status, body: bodyText };
    if (res.status >= 500) {
      throw unavailable(cause);
    }
    throw new OutpostError('PROVIDER_ERROR', 502, SAFE_MESSAGE, { cause });
  }

  async function parseJson<T>(res: Response, path: string): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (cause) {
      // A 2xx with an unparseable body is an upstream fault, not the caller's.
      throw unavailable({ path, kind: 'parse', cause });
    }
  }

  return {
    async createVolume(input) {
      const res = await request(`/apps/${app}/volumes`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return parseJson<FlyVolume>(res, 'createVolume');
    },

    async deleteVolume(volumeId) {
      await request(`/apps/${app}/volumes/${encodeURIComponent(volumeId)}`, { method: 'DELETE' });
    },

    async createMachine(input) {
      const res = await request(`/apps/${app}/machines`, {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return parseJson<FlyMachine>(res, 'createMachine');
    },

    async getMachine(machineId) {
      const res = await request(`/apps/${app}/machines/${encodeURIComponent(machineId)}`, {
        method: 'GET',
      });
      return parseJson<FlyMachine>(res, 'getMachine');
    },

    async listMachines() {
      const res = await request(`/apps/${app}/machines`, { method: 'GET' });
      return parseJson<FlyMachine[]>(res, 'listMachines');
    },

    async stopMachine(machineId) {
      await request(`/apps/${app}/machines/${encodeURIComponent(machineId)}/stop`, {
        method: 'POST',
      });
    },

    async destroyMachine(machineId) {
      await request(`/apps/${app}/machines/${encodeURIComponent(machineId)}?force=true`, {
        method: 'DELETE',
      });
    },
  };
}
