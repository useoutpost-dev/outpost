import { useEffect, useState } from 'react';
import { UsageBar } from '../components/UsageBar';

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

interface PerSandboxRow {
  sandboxId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estCostUsd: number;
}

interface UsageEstimate {
  percent: number | null;
  confidence: string;
  method: string;
}

interface UsageResponse {
  totals: UsageTotals;
  perSandbox: PerSandboxRow[];
  estimate: UsageEstimate;
}

export interface UsageProps {
  onBack: () => void;
}

export function Usage({ onBack }: UsageProps) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch('/api/usage', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<UsageResponse>;
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-basalt">
      {/* Top bar */}
      <header className="flex h-14 flex-none items-center border-b border-ash/20 bg-console px-6">
        <button
          type="button"
          onClick={onBack}
          className="font-mono text-xs text-ash hover:text-bonewhite"
        >
          ← Back
        </button>
        <span className="ml-4 font-display text-sm font-semibold uppercase tracking-[0.25em] text-bonewhite">
          Usage
        </span>
      </header>

      <main className="flex flex-1 flex-col gap-6 p-6">
        {loading && <p className="font-mono text-xs text-ash">loading…</p>}

        {error && <p className="font-mono text-xs text-rust">Error: {error}</p>}

        {!loading && !error && data && (
          <>
            {/* Usage bar */}
            <UsageBar
              percent={data.estimate.percent}
              inputTokens={data.totals.inputTokens}
              outputTokens={data.totals.outputTokens}
              estCostUsd={data.totals.estCostUsd}
            />

            {/* Per-sandbox table */}
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-ash/20">
                    <th className="py-2 pr-4 text-left font-mono text-xs text-ash">Sandbox</th>
                    <th className="py-2 pr-4 text-right font-mono text-xs text-ash">Input</th>
                    <th className="py-2 pr-4 text-right font-mono text-xs text-ash">Output</th>
                    <th className="py-2 pr-4 text-right font-mono text-xs text-ash">Cache read</th>
                    <th className="py-2 pr-4 text-right font-mono text-xs text-ash">Cache write</th>
                    <th className="py-2 text-right font-mono text-xs text-ash">est. API value</th>
                  </tr>
                </thead>
                <tbody>
                  {data.perSandbox.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-4 font-mono text-xs text-ash">
                        No usage data in the last 30 days.
                      </td>
                    </tr>
                  )}
                  {data.perSandbox.map((row) => (
                    <tr key={row.sandboxId} className="border-b border-ash/10">
                      <td className="py-2 pr-4 font-mono text-xs text-bonewhite">{row.sandboxId}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs text-ash">{row.inputTokens.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs text-ash">{row.outputTokens.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs text-ash">{row.cacheReadTokens.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right font-mono text-xs text-ash">{row.cacheWriteTokens.toLocaleString()}</td>
                      <td className="py-2 text-right font-mono text-xs text-bonewhite">${row.estCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
