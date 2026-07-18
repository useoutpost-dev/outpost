import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateUsage } from '../usage-estimate.js';

// A window's worth of moderate usage. Numbers are illustrative, not real.
const FIXTURE: Parameters<typeof estimateUsage>[0] = {
  inputTokens: 1_200_000,
  outputTokens: 300_000,
  cacheReadTokens: 5_000_000,
  cacheWriteTokens: 400_000,
  estCostUsd: 62.5, // ~25% of the $250 notional weekly allowance
};

describe('estimateUsage — normal case', () => {
  it('returns a percent within a sane range for a 7-day window', () => {
    const r = estimateUsage(FIXTURE, 7);
    expect(r.percent).not.toBeNull();
    // $62.5 / $250 = 25%. Assert a range, not exact equality — the constant drifts.
    expect(r.percent as number).toBeGreaterThan(10);
    expect(r.percent as number).toBeLessThan(50);
    expect(r.confidence).toBe('medium');
    expect(r.method).toContain('UNOFFICIAL');
  });

  it('never reports high confidence', () => {
    const r = estimateUsage({ ...FIXTURE, estCostUsd: 9999 }, 7);
    expect(r.confidence).not.toBe('high');
  });

  it('clamps percent to at most 999 on extreme overshoot', () => {
    const r = estimateUsage({ ...FIXTURE, estCostUsd: 10_000_000 }, 7);
    expect(r.percent).toBe(999);
  });

  it('rounds percent to an integer', () => {
    const r = estimateUsage(FIXTURE, 7);
    expect(Number.isInteger(r.percent)).toBe(true);
  });
});

describe('estimateUsage — low-confidence / null cases', () => {
  it('returns null percent with low confidence on zero usage', () => {
    const r = estimateUsage(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estCostUsd: 0,
      },
      7,
    );
    expect(r.percent).toBeNull();
    expect(r.confidence).toBe('low');
    expect(r.method).toMatch(/zero/i);
  });

  it('returns null percent with low confidence when windowDays < 1', () => {
    const r = estimateUsage(FIXTURE, 0);
    expect(r.percent).toBeNull();
    expect(r.confidence).toBe('low');
    expect(r.method).toMatch(/windowDays/);
  });
});

describe('estimateUsage — windowDays scaling', () => {
  it('is monotonic: a wider window yields a lower-or-equal percent for the same cost', () => {
    // Same accrued cost spread over a longer window is compared against a larger
    // scaled allowance, so the percent must not increase as the window widens.
    const p7 = estimateUsage(FIXTURE, 7).percent as number;
    const p14 = estimateUsage(FIXTURE, 14).percent as number;
    const p30 = estimateUsage(FIXTURE, 30).percent as number;
    expect(p14).toBeLessThanOrEqual(p7);
    expect(p30).toBeLessThanOrEqual(p14);
  });

  it('halving the window roughly doubles the percent for the same cost', () => {
    const wide = estimateUsage(FIXTURE, 14).percent as number;
    const narrow = estimateUsage(FIXTURE, 7).percent as number;
    // Allow rounding slack.
    expect(narrow).toBeGreaterThanOrEqual(wide * 2 - 1);
    expect(narrow).toBeLessThanOrEqual(wide * 2 + 1);
  });
});

describe('adapter isolation', () => {
  // The undocumented usage-estimation logic must stay confined to the telemetry
  // module on the server. Any import of `usage-estimate` from a server file
  // outside apps/server/src/telemetry/ is an architecture-boundary violation.
  // Route wiring lands in a later task, so zero matches is acceptable today —
  // the assertion is only that ANY match lives under telemetry/.
  it('only apps/server/src/telemetry may import usage-estimate', () => {
    const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../../../../../../');
    let output = '';
    try {
      output = execSync('grep -rl usage-estimate apps/server/src --include=*.ts', {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } catch (err) {
      // grep exits 1 with empty stdout when there are no matches — that is fine.
      const e = err as { status?: number; stdout?: string };
      if (e.status === 1 && !e.stdout) {
        output = '';
      } else {
        throw err;
      }
    }
    const offenders = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith('apps/server/src/telemetry/'));
    expect(offenders).toEqual([]);
  });
});
