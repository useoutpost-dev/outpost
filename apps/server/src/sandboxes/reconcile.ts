import type { SandboxProvider } from '@outpost/shared-api';
import type { Db } from '../db/client.js';
import { events } from '../db/schema.js';
import { listSandboxes } from './sandboxes.repo.js';

export interface ReconcileResult {
  destroyed: number;
  failed: number;
}

/**
 * Sweep provider machines and destroy any that have no matching row in the DB.
 * Per-orphan errors are caught so one failure does not abort the sweep.
 * Provider-agnostic — no Fly imports.
 */
export async function reconcileOrphans({
  db,
  provider,
}: {
  db: Db;
  provider: SandboxProvider;
}): Promise<ReconcileResult> {
  const [machines, rows] = await Promise.all([provider.list(), listSandboxes(db)]);

  const knownProviderRefs = new Set(rows.map((r) => r.providerRef).filter(Boolean));

  let destroyed = 0;
  let failed = 0;

  for (const machine of machines) {
    if (knownProviderRefs.has(machine.id)) continue;

    try {
      await provider.destroy(machine.id);
      db.insert(events)
        .values({
          kind: 'sandbox.orphan_destroyed',
          sandboxId: null,
          payload: { providerRef: machine.id },
        })
        .run();
      destroyed++;
    } catch {
      failed++;
    }
  }

  return { destroyed, failed };
}
