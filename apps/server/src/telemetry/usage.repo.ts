import type { Db } from '../db/client.js';
import { usage, type UsageInsert } from '../db/schema.js';

/**
 * Batch-insert normalized usage rows. No-op on an empty array so callers never
 * need to guard. A single multi-row insert — per-event writes are forbidden.
 * Task 4 extends this file with the scoped aggregate queries.
 */
export function insertUsageRows(db: Db, rows: UsageInsert[]): void {
  if (rows.length === 0) return;
  db.insert(usage).values(rows).run();
}
