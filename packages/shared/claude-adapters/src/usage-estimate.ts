// Adapter — SOLE owner of Claude subscription usage-limit ESTIMATION.
// There is NO official API for a subscription's remaining weekly allowance, so
// everything here is a heuristic reconstruction. It WILL drift as Anthropic
// changes tiers, limits, and pricing. When it breaks, only this file (and its
// test) should need updating — never the collector, repo, route, or UI.
//
// The output is intentionally cautious: it never reports 'high' confidence and
// returns `percent: null` whenever the inputs make an estimate meaningless.
// A null + honest reason always beats a confident guess.

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Notional API-equivalent dollar value already accrued in the window. */
  estCostUsd: number;
}

export interface UsageEstimate {
  /** Estimated percent of the weekly allowance consumed, clamped [0, 999], or null. */
  percent: number | null;
  confidence: 'low' | 'medium' | 'high';
  /** Human-readable description of how the number was (or wasn't) produced. */
  method: string;
}

// DRIFT-PRONE CONSTANT — has no official source.
// Public reporting (community threads, Anthropic blog posts) puts the weekly
// usage ceiling of a heavy/Max-tier Claude subscription very roughly in the
// low-hundreds-of-dollars of API-equivalent value. We encode a single notional
// number here as the denominator for a "% of weekly allowance" estimate.
// This is a rough midpoint, NOT a documented limit — it will change whenever
// Anthropic revises tier limits or pricing. Revisit on every Claude Code update.
const NOTIONAL_WEEKLY_ALLOWANCE_USD = 250;

// The allowance above is expressed per 7-day window; we scale it linearly by
// the actual window length so a 30-day total isn't compared against a 7-day cap.
const ALLOWANCE_WINDOW_DAYS = 7;

const PERCENT_MIN = 0;
const PERCENT_MAX = 999; // Allow >100% so overshoot is visible, but bound it.

/**
 * Estimate what fraction of a notional weekly subscription allowance the given
 * usage represents. Pure function — no I/O, no clock, no randomness.
 *
 * @param totals   Aggregated usage for the window. Only `estCostUsd` drives the
 *                 estimate today; token fields are accepted for forward
 *                 compatibility and so callers pass one coherent shape.
 * @param windowDays  Length of the aggregation window in days (e.g. 7, 30).
 */
export function estimateUsage(totals: UsageTotals, windowDays: number): UsageEstimate {
  // Guard: a window shorter than a day (or non-finite) can't be scaled sanely.
  if (!Number.isFinite(windowDays) || windowDays < 1) {
    return {
      percent: null,
      confidence: 'low',
      method: `no estimate: windowDays (${windowDays}) is below the 1-day minimum`,
    };
  }

  // Guard: no accrued value means nothing to estimate against. Zero usage is a
  // legitimate state, but a percent of an allowance is meaningless here.
  if (!Number.isFinite(totals.estCostUsd) || totals.estCostUsd <= 0) {
    return {
      percent: null,
      confidence: 'low',
      method: 'no estimate: estCostUsd is zero — no notional API value accrued yet',
    };
  }

  // Scale the 7-day notional allowance to the actual window length.
  const scaledAllowanceUsd =
    NOTIONAL_WEEKLY_ALLOWANCE_USD * (windowDays / ALLOWANCE_WINDOW_DAYS);

  const rawPercent = (totals.estCostUsd / scaledAllowanceUsd) * 100;
  const percent = Math.min(PERCENT_MAX, Math.max(PERCENT_MIN, Math.round(rawPercent)));

  return {
    percent,
    // Never 'high': there is no official limit to anchor to. 'medium' is the
    // ceiling for a normally-computed estimate.
    confidence: 'medium',
    method:
      `notional weekly allowance $${NOTIONAL_WEEKLY_ALLOWANCE_USD} scaled to ` +
      `${windowDays}d ($${scaledAllowanceUsd.toFixed(2)}); est. API value ` +
      `$${totals.estCostUsd.toFixed(2)} — UNOFFICIAL, will drift`,
  };
}
