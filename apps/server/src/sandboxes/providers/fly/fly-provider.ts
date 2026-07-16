import {
  OutpostError,
  type ExecResult,
  type PortMapping,
  type Sandbox,
  type SandboxProvider,
  type SandboxSpec,
  type SandboxStatus,
  type TerminalEndpoint,
} from '@outpost/shared-api';
import {
  createFlyClient,
  type Fetcher,
  type FlyClient,
  type FlyMachine,
} from './fly-client.js';

export interface FlyProviderConfig {
  apiToken: string;
  app: string;
  region: string;
  /**
   * Poll backoff tuning. Optional so tests can drive tiny timings instead of
   * sleeping ~90s. Defaults are production values.
   */
  poll?: PollConfig;
}

export interface PollConfig {
  /** First inter-poll delay in ms. */
  startMs: number;
  /** Per-interval cap in ms (delay grows ×2 up to this). */
  maxIntervalMs: number;
  /** Total wall-clock cap in ms before giving up with TIMEOUT. */
  totalMs: number;
}

const DEFAULT_POLL: PollConfig = { startMs: 500, maxIntervalMs: 5_000, totalMs: 90_000 };

const WORKSPACE_PATH = '/workspace';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fly volume names allow only [a-z0-9_]; derive one from the sandbox name. */
function volumeNameFor(specName: string): string {
  return `ws_${specName.replace(/-/g, '_').replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
}

/**
 * Map a Fly machine state to the provider-agnostic SandboxStatus.
 * Unknown states fail closed to 'error'.
 */
function mapState(state: string): SandboxStatus {
  switch (state) {
    case 'created':
    case 'starting':
      return 'creating';
    case 'started':
      return 'running';
    case 'stopping':
    case 'stopped':
    case 'suspended':
      return 'stopped';
    case 'destroying':
    case 'destroyed':
      return 'destroyed';
    case 'failed':
      return 'error';
    default:
      return 'error';
  }
}

function toSandbox(machine: FlyMachine, volumeRef?: string): Sandbox {
  const mounts = machine.config?.mounts ?? [];
  const resolvedVolume = volumeRef ?? mounts.find((m) => m.path === WORKSPACE_PATH)?.volume;
  return {
    id: machine.id,
    name: machine.name ?? machine.id,
    status: mapState(machine.state),
    createdAt: new Date().toISOString(),
    ...(machine.private_ip ? { privateIp: machine.private_ip } : {}),
    ...(resolvedVolume ? { volumeRef: resolvedVolume } : {}),
  };
}

/**
 * True when an OutpostError originated from a Fly 404. The status is carried in
 * the error cause by fly-client, never in safeMessage.
 */
function isFlyNotFound(err: unknown): boolean {
  if (!(err instanceof OutpostError)) return false;
  const cause = (err as { cause?: unknown }).cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { status?: unknown }).status === 404
  );
}

export function createFlyProvider(config: FlyProviderConfig, fetcher?: Fetcher): SandboxProvider {
  const client: FlyClient = createFlyClient(config.apiToken, config.app, fetcher);
  const poll = config.poll ?? DEFAULT_POLL;

  /** Poll getMachine with exponential backoff until 'started' or the total cap. */
  async function waitForStarted(machineId: string): Promise<FlyMachine> {
    const deadline = Date.now() + poll.totalMs;
    let interval = poll.startMs;
    for (;;) {
      const machine = await client.getMachine(machineId);
      if (machine.state === 'started') return machine;
      if (machine.state === 'failed') {
        throw new OutpostError('PROVIDER_ERROR', 502, 'sandbox failed to start', {
          cause: { machineId, state: machine.state },
        });
      }
      if (Date.now() + interval >= deadline) {
        throw new OutpostError('TIMEOUT', 504, 'sandbox did not start in time', {
          cause: { machineId, lastState: machine.state },
        });
      }
      await sleep(interval);
      interval = Math.min(interval * 2, poll.maxIntervalMs);
    }
  }

  /**
   * Poll until the machine is gone (Fly 404) or reports 'destroyed'. Machine
   * destruction is async; a volume cannot be deleted while it is still attached
   * to a destroying machine, so volume deletion must wait for this.
   */
  async function waitForGone(machineId: string): Promise<void> {
    const deadline = Date.now() + poll.totalMs;
    let interval = poll.startMs;
    for (;;) {
      let machine: FlyMachine;
      try {
        machine = await client.getMachine(machineId);
      } catch (err) {
        if (isFlyNotFound(err)) return;
        throw err;
      }
      if (machine.state === 'destroyed') return;
      if (Date.now() + interval >= deadline) {
        throw new OutpostError('TIMEOUT', 504, 'sandbox did not shut down in time', {
          cause: { machineId, lastState: machine.state },
        });
      }
      await sleep(interval);
      interval = Math.min(interval * 2, poll.maxIntervalMs);
    }
  }

  async function create(spec: SandboxSpec): Promise<Sandbox> {
    if (spec.volumes.length > 0) {
      throw new OutpostError(
        'BAD_REQUEST',
        400,
        'sandbox volumes are provider-managed and must be empty',
        { cause: { volumeCount: spec.volumes.length } },
      );
    }

    // Volume and machine MUST share the region or the machine start silently fails.
    const volume = await client.createVolume({
      name: volumeNameFor(spec.name),
      region: config.region,
      size_gb: spec.resources.diskGb,
    });

    // Track the machine id (if create succeeds) so any later failure can clean it
    // up. On ANY failure past this point: destroy the machine (if any), then
    // delete the volume, then rethrow the ORIGINAL error unmasked.
    let machineId: string | undefined;
    try {
      const machine = await client.createMachine({
        name: spec.name,
        region: config.region,
        config: {
          image: spec.image,
          env: spec.env, // passed through verbatim — no keys added or removed
          guest: {
            cpu_kind: 'shared',
            cpus: spec.resources.cpus,
            memory_mb: spec.resources.memoryMb,
          },
          mounts: [{ volume: volume.id, path: WORKSPACE_PATH }],
        },
      });
      machineId = machine.id;

      const started = await waitForStarted(machine.id);
      return toSandbox(started, volume.id);
    } catch (err) {
      await cleanup(machineId, volume.id);
      throw err;
    }
  }

  /**
   * Best-effort cleanup after a create failure: destroy the machine (if one was
   * created), then delete the volume. Cleanup failures are swallowed so the
   * ORIGINAL error surfaces unmasked.
   */
  async function cleanup(machineId: string | undefined, volumeId: string): Promise<void> {
    if (machineId) {
      try {
        await client.destroyMachine(machineId);
        // Volume delete fails while the machine still holds it; wait for detach.
        await waitForGone(machineId);
      } catch {
        // swallow: must not mask the original create/poll error
      }
    }
    try {
      await client.deleteVolume(volumeId);
    } catch {
      // swallow: must not mask the original create/poll error
    }
  }

  async function stop(id: string): Promise<void> {
    await client.stopMachine(id);
  }

  /**
   * Destroy by machine id alone (no DB) so orphan reconciliation can reuse it.
   * Collects volume ids from the machine's mount config, force-destroys the
   * machine, then deletes those volumes. A 404 machine is treated as success.
   */
  async function destroy(id: string): Promise<void> {
    let machine: FlyMachine;
    try {
      machine = await client.getMachine(id);
    } catch (err) {
      if (isFlyNotFound(err)) return; // already gone
      throw err;
    }

    const volumeIds = (machine.config?.mounts ?? []).map((m) => m.volume).filter(Boolean);

    try {
      await client.destroyMachine(id);
    } catch (err) {
      if (!isFlyNotFound(err)) throw err;
    }

    // Machine destruction is async on Fly; volumes stay attached until it
    // completes, so deleting them immediately would fail.
    await waitForGone(id);

    for (const volumeId of volumeIds) {
      await client.deleteVolume(volumeId);
    }
  }

  async function get(id: string): Promise<Sandbox | null> {
    try {
      const machine = await client.getMachine(id);
      return toSandbox(machine);
    } catch (err) {
      if (isFlyNotFound(err)) return null;
      throw err;
    }
  }

  async function list(): Promise<Sandbox[]> {
    const machines = await client.listMachines();
    return machines.map((m) => toSandbox(m));
  }

  function notImplemented(): never {
    throw new OutpostError('INTERNAL', 501, 'not implemented');
  }

  return {
    create,
    stop,
    destroy,
    get,
    list,
    async exec(): Promise<ExecResult> {
      return notImplemented();
    },
    async terminalEndpoint(id: string): Promise<TerminalEndpoint> {
      // `id` is the Fly machine id (the providerRef used by stop/destroy).
      // Confirm the machine exists before handing back a dial URL so a stale ref
      // surfaces as a typed error instead of an opaque WS connect failure.
      let machine: FlyMachine;
      try {
        machine = await client.getMachine(id);
      } catch (err) {
        if (isFlyNotFound(err)) {
          throw new OutpostError('NOT_FOUND', 404, 'sandbox machine not found', {
            cause: { machineId: id },
          });
        }
        throw err;
      }
      // Fly 6PN private DNS: <machine-id>.vm.<app>.internal, daemon on port 8022.
      return { url: `ws://${machine.id}.vm.${config.app}.internal:8022` };
    },
    async mount(): Promise<void> {
      return notImplemented();
    },
    async ports(): Promise<PortMapping[]> {
      return notImplemented();
    },
  };
}
