import { describe, it, expect, beforeEach } from 'vitest';
import { makeTestDb } from '../../__tests__/helpers.js';
import type { Db } from '../../db/client.js';
import { usage } from '../../db/schema.js';
import { insertUsageRows, usageTotals, usagePerSandbox } from '../usage.repo.js';
import type { UsageInsert } from '../../db/schema.js';

function makeRow(overrides: Partial<UsageInsert> = {}): UsageInsert {
  return {
    sandboxId: 'sandbox-a',
    accountId: null,
    model: 'claude-3-5-sonnet',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    estCostUsd: 0.01,
    ...overrides,
  };
}

describe('usage.repo', () => {
  let db: Db;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('insertUsageRows then usageTotals sums correctly', () => {
    insertUsageRows(db, [
      makeRow({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, estCostUsd: 0.01 }),
      makeRow({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 8, estCostUsd: 0.02 }),
    ]);

    const totals = usageTotals(db);
    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(130);
    expect(totals.cacheReadTokens).toBe(30);
    expect(totals.cacheWriteTokens).toBe(13);
    expect(totals.estCostUsd).toBeCloseTo(0.03);
  });

  it('usagePerSandbox returns each sandbox once with its own sums', () => {
    insertUsageRows(db, [
      makeRow({ sandboxId: 'sandbox-a', inputTokens: 100, outputTokens: 40, cacheReadTokens: 5, cacheWriteTokens: 2, estCostUsd: 0.01 }),
      makeRow({ sandboxId: 'sandbox-a', inputTokens: 50, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 1, estCostUsd: 0.005 }),
      makeRow({ sandboxId: 'sandbox-b', inputTokens: 200, outputTokens: 80, cacheReadTokens: 10, cacheWriteTokens: 4, estCostUsd: 0.02 }),
    ]);

    const rows = usagePerSandbox(db);
    expect(rows).toHaveLength(2);

    const a = rows.find((r) => r.sandboxId === 'sandbox-a');
    const b = rows.find((r) => r.sandboxId === 'sandbox-b');

    expect(a).toBeDefined();
    expect(a!.inputTokens).toBe(150);
    expect(a!.outputTokens).toBe(60);

    expect(b).toBeDefined();
    expect(b!.inputTokens).toBe(200);
    expect(b!.outputTokens).toBe(80);
  });

  it('since filter excludes an older row', () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    const recent = new Date();
    const since = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

    // Insert directly with explicit ts to control timing
    db.insert(usage).values({
      sandboxId: 'sandbox-old',
      model: 'claude-3',
      inputTokens: 999,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estCostUsd: 0,
      ts: old,
    }).run();

    db.insert(usage).values({
      sandboxId: 'sandbox-new',
      model: 'claude-3',
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estCostUsd: 0,
      ts: recent,
    }).run();

    const totals = usageTotals(db, { since });
    expect(totals.inputTokens).toBe(10);
  });

  it('insertUsageRows with [] is a no-op', () => {
    insertUsageRows(db, []);
    const totals = usageTotals(db);
    expect(totals.inputTokens).toBe(0);
    expect(totals.outputTokens).toBe(0);
    expect(totals.estCostUsd).toBe(0);
  });
});
