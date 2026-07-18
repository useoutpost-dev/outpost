import crypto from 'node:crypto';
import { OutpostError } from '@outpost/shared-api';
import type { SandboxProvider, SandboxStatus, SandboxResources } from '@outpost/shared-api';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import {
  insertSandbox,
  updateSandboxStatus,
  findSandboxById,
  findSandboxByName,
  listSandboxes,
  type SandboxRow,
} from './sandboxes.repo.js';

type SandboxEventKind =
  | 'sandbox.creating'
  | 'sandbox.running'
  | 'sandbox.stopped'
  | 'sandbox.destroyed'
  | 'sandbox.error';

/** Legal transitions: from → allowed next states */
const LEGAL: Record<SandboxStatus, SandboxStatus[]> = {
  creating: ['running', 'error'],
  running: ['stopped', 'destroyed', 'error'],
  stopped: ['destroyed', 'error'],
  error: ['destroyed'],
  destroyed: [],
};

function assertTransition(from: SandboxStatus, to: SandboxStatus): void {
  if (!LEGAL[from].includes(to)) {
    throw new OutpostError('CONFLICT', 409, 'illegal sandbox state transition');
  }
}

function appendSandboxEvent(
  db: Db,
  kind: SandboxEventKind,
  sandboxId: string | null,
  payload: { provider: string; providerRef: string | null },
): void {
  db.insert(events).values({ kind, sandboxId, payload }).run();
}

/**
 * Subset of the credentials service the sandbox service consumes. Kept as a
 * structural type so tests can inject a partial fake and so the sandbox module
 * never imports credential internals directly.
 */
export interface CredentialsPort {
  envForAccount(accountId: string): Promise<Record<string, string>>;
  captureFromSandbox(sandboxRow: {
    accountId: string | null;
    providerRef: string | null;
    status: string;
  }): Promise<boolean>;
}

export interface SandboxServiceDeps {
  db: Db;
  provider: SandboxProvider;
  config: { image: string; collectorEndpoint: string; collectorToken: string };
  /**
   * Called on stop/destroy so the terminal session manager can tear down the
   * upstream WS + scrollback for a sandbox that no longer exists. Optional so
   * tests without a session manager still work.
   */
  onTeardown?: (sandboxId: string) => void;
  /**
   * Credential env assembly + subscription capture. Optional so tests that
   * don't exercise accounts can omit it.
   */
  credentialsService?: CredentialsPort;
}

const DEFAULT_RESOURCES: SandboxResources = { cpus: 2, memoryMb: 2048, diskGb: 10 };

export interface SandboxPublic {
  id: string;
  name: string;
  provider: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function toPublic(row: SandboxRow): SandboxPublic {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateSandboxInput {
  name: string;
  resources?: Partial<SandboxResources>;
  /** Optional Claude account to attach; env is resolved via credentialsService. */
  accountId?: string;
}

export function createSandboxService(deps: SandboxServiceDeps) {
  const { db, provider, config, onTeardown, credentialsService } = deps;

  /** Best-effort subscription capture; swallows everything (never blocks teardown). */
  async function captureCredentials(row: SandboxRow): Promise<void> {
    if (!credentialsService || !row.accountId) return;
    try {
      await credentialsService.captureFromSandbox({
        accountId: row.accountId,
        providerRef: row.providerRef,
        status: row.status,
      });
    } catch {
      // capture is best-effort; failures must not affect stop/destroy.
    }
  }

  async function create(input: CreateSandboxInput): Promise<SandboxPublic> {
    const { name, resources: partialResources, accountId } = input;
    const resources: SandboxResources = { ...DEFAULT_RESOURCES, ...partialResources };

    // Duplicate name check
    const existing = findSandboxByName(db, name);
    if (existing) {
      throw new OutpostError('CONFLICT', 409, 'sandbox name already exists');
    }

    const id = crypto.randomUUID();

    // Resolve credential env BEFORE inserting the row so an unknown accountId
    // fails fast (404) without leaving a dangling 'creating' sandbox. The
    // resolved values are secret material — they go into the machine env only,
    // never into event payloads or logs.
    let credentialEnv: Record<string, string> = {};
    if (accountId) {
      if (!credentialsService) {
        throw new OutpostError('INTERNAL', 500, 'accountId given but credentials service unavailable');
      }
      credentialEnv = await credentialsService.envForAccount(accountId);
    }

    // Per-sandbox 256-bit bearer token for the in-sandbox terminal daemon.
    // Stored in the DB and injected into the machine env only; it must NEVER
    // appear in event payloads or logs.
    const terminalToken = crypto.randomBytes(32).toString('hex');

    // Insert row + event as 'creating'
    insertSandbox(db, {
      id,
      name,
      provider: 'fly',
      status: 'creating',
      terminalToken,
      accountId: accountId ?? null,
    });
    appendSandboxEvent(db, 'sandbox.creating', id, { provider: 'fly', providerRef: null });

    // Compose OTEL env — provider-agnostic
    const resourceAttrs = accountId
      ? `sandbox.id=${id},account.id=${accountId}`
      : `sandbox.id=${id}`;
    const env: Record<string, string> = {
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_ENDPOINT: config.collectorEndpoint,
      // Force HTTP/JSON so the collector stays dependency-free (no grpc/protobuf).
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      // Collector bearer token as a machine env header — same known-limitations
      // category as OUTPOST_MASTER_KEY. Sourced from config, never process.env.
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${config.collectorToken}`,
      OTEL_RESOURCE_ATTRIBUTES: resourceAttrs,
      // OTEL_LOG_USER_PROMPTS is intentionally never set
      // Terminal daemon bearer token — consumed by the in-sandbox daemon only.
      OUTPOST_TERMINAL_TOKEN: terminalToken,
      // Credential env (ANTHROPIC_API_KEY or the encoded credential blob). Never
      // logged and never placed in event payloads.
      ...credentialEnv,
    };

    try {
      const sandbox = await provider.create({
        name,
        image: config.image,
        env,
        resources,
        volumes: [],
      });

      // Transition to running
      assertTransition('creating', 'running');
      updateSandboxStatus(db, id, 'running', {
        providerRef: sandbox.id,
        volumeRef: sandbox.volumeRef ?? null,
      });
      appendSandboxEvent(db, 'sandbox.running', id, { provider: 'fly', providerRef: sandbox.id });
    } catch (err) {
      // If err is already an OutpostError from a transition guard (won't happen in create),
      // still transition to error. For provider errors, also transition and rethrow.
      updateSandboxStatus(db, id, 'error');
      appendSandboxEvent(db, 'sandbox.error', id, { provider: 'fly', providerRef: null });
      throw err;
    }

    const row = findSandboxById(db, id)!;
    return toPublic(row);
  }

  async function stop(id: string): Promise<SandboxPublic> {
    const row = findSandboxById(db, id);
    if (!row) throw new OutpostError('NOT_FOUND', 404, 'sandbox not found');

    assertTransition(row.status as SandboxStatus, 'stopped');

    // A running row always has a providerRef; a null here means DB corruption,
    // so fail with a typed error instead of a bare runtime throw.
    if (!row.providerRef) {
      throw new OutpostError('INTERNAL', 500, 'sandbox has no provider reference');
    }

    // Best-effort: persist any fresh subscription login before the machine goes
    // away. Never blocks or fails the stop.
    await captureCredentials(row);

    try {
      await provider.stop(row.providerRef);
    } catch (err) {
      updateSandboxStatus(db, id, 'error');
      appendSandboxEvent(db, 'sandbox.error', id, {
        provider: 'fly',
        providerRef: row.providerRef ?? null,
      });
      throw err;
    }

    updateSandboxStatus(db, id, 'stopped');
    appendSandboxEvent(db, 'sandbox.stopped', id, {
      provider: 'fly',
      providerRef: row.providerRef ?? null,
    });

    // Terminal upstream is gone once the machine stops; tear the session down.
    onTeardown?.(id);

    return toPublic(findSandboxById(db, id)!);
  }

  async function destroy(id: string): Promise<SandboxPublic> {
    const row = findSandboxById(db, id);
    if (!row) throw new OutpostError('NOT_FOUND', 404, 'sandbox not found');

    assertTransition(row.status as SandboxStatus, 'destroyed');

    // Best-effort capture before the machine is destroyed (only meaningful when
    // still running with a subscription account).
    await captureCredentials(row);

    if (row.providerRef) {
      try {
        await provider.destroy(row.providerRef);
      } catch (err) {
        updateSandboxStatus(db, id, 'error');
        appendSandboxEvent(db, 'sandbox.error', id, {
          provider: 'fly',
          providerRef: row.providerRef,
        });
        throw err;
      }
    }

    updateSandboxStatus(db, id, 'destroyed');
    appendSandboxEvent(db, 'sandbox.destroyed', id, {
      provider: 'fly',
      providerRef: row.providerRef ?? null,
    });

    // Terminal upstream is gone once the machine is destroyed; tear it down.
    onTeardown?.(id);

    return toPublic(findSandboxById(db, id)!);
  }

  function get(id: string): SandboxPublic {
    const row = findSandboxById(db, id);
    if (!row) throw new OutpostError('NOT_FOUND', 404, 'sandbox not found');
    return toPublic(row);
  }

  function list(): SandboxPublic[] {
    return listSandboxes(db).map(toPublic);
  }

  return { create, stop, destroy, get, list };
}

export type SandboxService = ReturnType<typeof createSandboxService>;
