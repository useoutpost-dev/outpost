export interface UsageBarProps {
  percent: number | null;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}

/**
 * Horizontal progress bar showing estimated subscription usage.
 * The word "estimated" is always visible — required by spec regardless of state.
 */
export function UsageBar({ percent, inputTokens, outputTokens, estCostUsd }: UsageBarProps) {
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  const label = percent === null ? 'n/a (estimated)' : `~${percent}% (estimated)`;

  return (
    <div className="flex flex-col gap-2">
      {/* Track */}
      <div className="h-2 w-full overflow-hidden rounded bg-console">
        <div
          className="h-full rounded bg-beacon transition-all"
          style={{ width: `${clamped}%` }}
        />
      </div>

      {/* Percent label — "estimated" always visible */}
      <span className="font-mono text-xs text-ash">{label}</span>

      {/* Token summary + cost */}
      <div className="flex items-center gap-4">
        <span className="font-mono text-xs text-ash">
          in {inputTokens.toLocaleString()} / out {outputTokens.toLocaleString()}
        </span>
        <span className="font-mono text-xs text-bonewhite">
          est. API value ${estCostUsd.toFixed(4)}
        </span>
      </div>
    </div>
  );
}
