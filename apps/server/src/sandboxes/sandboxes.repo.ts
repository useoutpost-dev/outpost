import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sandboxes, type SandboxRow, type NewSandboxRow } from '../db/schema.js';
import type { SandboxStatus } from '@outpost/shared-api';

export type { SandboxRow };

export function insertSandbox(db: Db, values: NewSandboxRow): SandboxRow {
  db.insert(sandboxes).values(values).run();
  const row = db.select().from(sandboxes).where(eq(sandboxes.id, values.id)).get();
  if (!row) throw new Error('insertSandbox: row not found after insert');
  return row;
}

export function updateSandboxStatus(
  db: Db,
  id: string,
  status: SandboxStatus,
  extra?: { providerRef?: string | null; volumeRef?: string | null },
): void {
  db.update(sandboxes)
    .set({
      status,
      updatedAt: new Date(),
      ...(extra?.providerRef !== undefined ? { providerRef: extra.providerRef } : {}),
      ...(extra?.volumeRef !== undefined ? { volumeRef: extra.volumeRef } : {}),
    })
    .where(eq(sandboxes.id, id))
    .run();
}

export function findSandboxById(db: Db, id: string): SandboxRow | undefined {
  return db.select().from(sandboxes).where(eq(sandboxes.id, id)).get();
}

export function findSandboxByName(db: Db, name: string): SandboxRow | undefined {
  return db.select().from(sandboxes).where(eq(sandboxes.name, name)).get();
}

export function listSandboxes(db: Db): SandboxRow[] {
  return db.select().from(sandboxes).all();
}
