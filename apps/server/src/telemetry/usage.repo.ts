import { gte } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { usage, type UsageInsert } from '../db/schema.js';

/**
 * Batch-insert normalized usage rows. No-op on an empty array so callers never
 * need to guard. A single multi-row insert — per-event writes are forbidden.
 */
export function insertUsageRows(db: Db, rows: UsageInsert[]): void {
  if (rows.length === 0) return;
  db.insert(usage).values(rows).run();
}

export interface UsageTotalsResult {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

/**
 * Aggregate usage totals across all sandboxes. Optionally filtered to rows
 * with ts >= since (rolling window).
 */
export function usageTotals(
  db: Db,
  opts?: { since?: Date },
): UsageTotalsResult {
  const whereClause = opts?.since ? gte(usage.ts, opts.since) : undefined;

  const rows = whereClause
    ? db
        .select({
          inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`,
          cacheReadTokens: sql<number>`coalesce(sum(${usage.cacheReadTokens}), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(${usage.cacheWriteTokens}), 0)`,
          estCostUsd: sql<number>`coalesce(sum(${usage.estCostUsd}), 0)`,
        })
        .from(usage)
        .where(whereClause)
        .all()
    : db
        .select({
          inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`,
          cacheReadTokens: sql<number>`coalesce(sum(${usage.cacheReadTokens}), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(${usage.cacheWriteTokens}), 0)`,
          estCostUsd: sql<number>`coalesce(sum(${usage.estCostUsd}), 0)`,
        })
        .from(usage)
        .all();

  const row = rows[0];
  return {
    inputTokens: Number(row?.inputTokens ?? 0),
    outputTokens: Number(row?.outputTokens ?? 0),
    cacheReadTokens: Number(row?.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(row?.cacheWriteTokens ?? 0),
    estCostUsd: Number(row?.estCostUsd ?? 0),
  };
}

export interface PerSandboxResult {
  sandboxId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

/**
 * Aggregate usage grouped by sandbox_id. Optionally filtered to rows with
 * ts >= since (rolling window). Every row is explicitly scoped to one sandbox.
 */
export function usagePerSandbox(
  db: Db,
  opts?: { since?: Date },
): PerSandboxResult[] {
  const whereClause = opts?.since ? gte(usage.ts, opts.since) : undefined;

  const rows = whereClause
    ? db
        .select({
          sandboxId: usage.sandboxId,
          inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`,
          cacheReadTokens: sql<number>`coalesce(sum(${usage.cacheReadTokens}), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(${usage.cacheWriteTokens}), 0)`,
          estCostUsd: sql<number>`coalesce(sum(${usage.estCostUsd}), 0)`,
        })
        .from(usage)
        .where(whereClause)
        .groupBy(usage.sandboxId)
        .all()
    : db
        .select({
          sandboxId: usage.sandboxId,
          inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`,
          cacheReadTokens: sql<number>`coalesce(sum(${usage.cacheReadTokens}), 0)`,
          cacheWriteTokens: sql<number>`coalesce(sum(${usage.cacheWriteTokens}), 0)`,
          estCostUsd: sql<number>`coalesce(sum(${usage.estCostUsd}), 0)`,
        })
        .from(usage)
        .groupBy(usage.sandboxId)
        .all();

  return rows.map((r) => ({
    sandboxId: r.sandboxId,
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    cacheReadTokens: Number(r.cacheReadTokens),
    cacheWriteTokens: Number(r.cacheWriteTokens),
    estCostUsd: Number(r.estCostUsd),
  }));
}
