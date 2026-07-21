import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, ports, type PortInsert, type PortRow } from '../db/schema.js';

/** All registered ports for a sandbox, newest last (stable insert order). */
export function listPorts(db: Db, sandboxId: string): PortRow[] {
  return db.select().from(ports).where(eq(ports.sandboxId, sandboxId)).all();
}

export function getPort(db: Db, sandboxId: string, port: number): PortRow | undefined {
  return db
    .select()
    .from(ports)
    .where(and(eq(ports.sandboxId, sandboxId), eq(ports.port, port)))
    .get();
}

/**
 * Insert a port row. Throws on a unique-constraint violation
 * (`ports_sandbox_port_uniq`); the route handler catches and maps to 409.
 */
export function createPort(db: Db, insert: PortInsert): PortRow {
  db.insert(ports).values(insert).run();
  const row = getPort(db, insert.sandboxId, insert.port);
  if (!row) throw new Error('createPort: row not found after insert');
  return row;
}

/** Toggle a port's public flag and bump updatedAt. No-op if the row is absent. */
export function setPublic(db: Db, sandboxId: string, port: number, value: boolean): void {
  db.update(ports)
    .set({ public: value, updatedAt: new Date() })
    .where(and(eq(ports.sandboxId, sandboxId), eq(ports.port, port)))
    .run();
}

export function deletePort(db: Db, sandboxId: string, port: number): void {
  db.delete(ports)
    .where(and(eq(ports.sandboxId, sandboxId), eq(ports.port, port)))
    .run();
}

/** Remove all port rows for a sandbox. Called during sandbox destroy so no
 *  orphaned rows accumulate in the `ports` table after teardown. */
export function deletePortsForSandbox(db: Db, sandboxId: string): void {
  db.delete(ports).where(eq(ports.sandboxId, sandboxId)).run();
}

/**
 * Append a port lifecycle event, mirroring appendSandboxEvent in service.ts.
 * Payload carries only the port number — never any credential/target material.
 */
export function appendPortEvent(
  db: Db,
  sandboxId: string,
  port: number,
  kind: 'port.exposed' | 'port.hidden',
): void {
  db.insert(events).values({ kind, sandboxId, payload: { port } }).run();
}
