import { desc, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { events, type EventRow } from './schema.js';

/**
 * Paginated event list ordered newest-first (ts DESC, id DESC for stable tie-breaking).
 */
export function listEvents(
  db: Db,
  opts: { limit: number; offset: number },
): EventRow[] {
  return db
    .select()
    .from(events)
    .orderBy(desc(events.ts), desc(events.id))
    .limit(opts.limit)
    .offset(opts.offset)
    .all();
}

/** Total count of events in the table. */
export function countEvents(db: Db): number {
  const rows = db
    .select({ count: sql<number>`count(*)` })
    .from(events)
    .all();
  return Number(rows[0]?.count ?? 0);
}
