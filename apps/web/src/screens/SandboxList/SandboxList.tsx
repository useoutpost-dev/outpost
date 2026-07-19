import { useEffect, useRef, useState } from 'react';
import { proModules } from '@outpost/shared-api';
import { SandboxRow } from './SandboxRow';
import type { SandboxItem } from './SandboxRow';
import { ActivityFeed } from '../../components/ActivityFeed/ActivityFeed';

type ActiveTab = 'sandboxes' | 'activity';

interface SandboxListProps {
  onOpenTerminal: (id: string, name: string) => void;
}

export function SandboxList({ onOpenTerminal }: SandboxListProps) {
  const [sandboxes, setSandboxes] = useState<SandboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('sandboxes');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fetchSandboxes() {
    fetch('/api/sandboxes', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<SandboxItem[]>;
      })
      .then((data) => {
        setSandboxes(data);
        setLoading(false);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }

  useEffect(() => {
    fetchSandboxes();
    intervalRef.current = setInterval(fetchSandboxes, 5000);
    return () => {
      if (intervalRef.current !== null) clearInterval(intervalRef.current);
    };
  }, []);

  function handleStop(id: string) {
    fetch(`/api/sandboxes/${id}/stop`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fetchSandboxes();
      })
      .catch(() => {
        // refetch to sync state
        fetchSandboxes();
      });
  }

  function handleDestroy(id: string) {
    fetch(`/api/sandboxes/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        fetchSandboxes();
      })
      .catch(() => {
        fetchSandboxes();
      });
  }

  const runningCount = sandboxes.filter((s) => s.status === 'running').length;
  const countLabel = sandboxes.length
    ? `${runningCount} RUNNING · ${sandboxes.length} TOTAL`
    : '0 TOTAL';

  return (
    <div className="flex flex-1 flex-col p-6 pb-16">
      <div className="mx-auto w-full max-w-[1160px]">
        {/* Tab bar */}
        <div className="mb-6 inline-flex overflow-hidden rounded-sm border border-ash/22">
          <button
            type="button"
            onClick={() => setActiveTab('sandboxes')}
            className={[
              'px-4 py-1.5 font-mono text-[11px] tracking-[0.12em] transition-colors duration-150 motion-reduce:transition-none',
              activeTab === 'sandboxes'
                ? 'bg-bonewhite/7 text-bonewhite'
                : 'bg-transparent text-ash hover:text-bonewhite',
            ].join(' ')}
          >
            SANDBOXES
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('activity')}
            className={[
              'px-4 py-1.5 font-mono text-[11px] tracking-[0.12em] transition-colors duration-150 motion-reduce:transition-none',
              activeTab === 'activity'
                ? 'bg-bonewhite/7 text-bonewhite'
                : 'bg-transparent text-ash hover:text-bonewhite',
            ].join(' ')}
          >
            ACTIVITY
          </button>
        </div>

        {/* Sandboxes tab */}
        {activeTab === 'sandboxes' && (
          <div>
            {/* Header */}
            <div className="mb-4 flex items-end justify-between">
              <div>
                <h1 className="m-0 font-display text-[23px] font-semibold tracking-tight text-bonewhite">
                  Sandboxes
                </h1>
                <p className="mt-1.5 font-mono text-[11.5px] tracking-[0.06em] text-ash">
                  {countLabel}
                </p>
              </div>
            </div>

            {/* Open-core bulk-ops seam (always false in open core) */}
            {proModules.has('manager.bulk-ops') && (
              <div className="mb-4 rounded border border-ash/20 bg-console p-3">
                {/* Bulk ops would render here in Pro */}
              </div>
            )}

            {loading && (
              <p className="font-mono text-xs text-ash">loading…</p>
            )}

            {error && (
              <p className="font-mono text-xs text-rust">Error: {error}</p>
            )}

            {!loading && !error && sandboxes.length === 0 && (
              <div className="rounded border border-dashed border-ash/28 bg-console/50 px-8 py-14 text-center">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ash/60">
                  NO ACTIVE SANDBOXES
                </div>
                <h2 className="mt-3.5 mb-2 font-display text-xl font-semibold text-bonewhite">
                  Nothing running yet
                </h2>
                <p className="mx-auto mb-5 max-w-[340px] font-body text-[13.5px] leading-relaxed text-ash">
                  Spin up an isolated cloud sandbox to run Codex in. It boots clean and
                  tears down when you destroy it.
                </p>
                <div className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[0.06em] text-beacon">
                  Start with <span className="text-bonewhite">New sandbox</span> ↗ up top
                </div>
              </div>
            )}

            {!loading && !error && sandboxes.length > 0 && (
              <div className="overflow-hidden rounded border border-ash/20 bg-console">
                {/* Column headers */}
                <div
                  className="grid items-center gap-3 border-b border-ash/14 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ash/60"
                  style={{ gridTemplateColumns: '20px minmax(180px,1.4fr) 128px 1fr 120px auto' }}
                >
                  <span />
                  <span>NAME</span>
                  <span>STATUS</span>
                  <span>ACCOUNT</span>
                  <span>LAST ACTIVITY</span>
                  <span />
                </div>

                {sandboxes.map((sb, i) => (
                  <SandboxRow
                    key={sb.id}
                    sandbox={sb}
                    index={i}
                    onOpenTerminal={() => onOpenTerminal(sb.id, sb.name)}
                    onStop={() => handleStop(sb.id)}
                    onDestroy={() => handleDestroy(sb.id)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Activity tab */}
        {activeTab === 'activity' && <ActivityFeed />}
      </div>
    </div>
  );
}
