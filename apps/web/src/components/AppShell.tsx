import { useEffect, useState } from 'react';
import { Terminal } from '../screens/Terminal';
import { SandboxCreate } from '../screens/SandboxCreate';

interface AppShellProps {
  login?: string;
}

interface SandboxItem {
  id: string;
  name: string;
  status: string;
}

type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'terminal'; sandboxId: string; name: string };

export function AppShell({ login }: AppShellProps) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [sandboxes, setSandboxes] = useState<SandboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (view.kind !== 'list') return;
    setLoading(true);
    setError(null);
    fetch('/api/sandboxes', { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<SandboxItem[]>;
      })
      .then((data) => {
        setSandboxes(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [view]);

  if (view.kind === 'terminal') {
    return (
      <Terminal
        sandboxId={view.sandboxId}
        name={view.name}
        onBack={() => setView({ kind: 'list' })}
      />
    );
  }

  if (view.kind === 'create') {
    return (
      <SandboxCreate
        onCreated={() => setView({ kind: 'list' })}
        onBack={() => setView({ kind: 'list' })}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-basalt">
      {/* Top bar */}
      <header className="flex h-14 flex-none items-center border-b border-ash/20 bg-console px-6">
        <span className="select-none font-display text-sm font-semibold uppercase tracking-[0.25em] text-bonewhite">
          OUTPOST
        </span>
        <div className="ml-auto">
          {login && <span className="font-mono text-xs text-ash">{login}</span>}
        </div>
      </header>

      {/* Sandbox list */}
      <main className="flex flex-1 flex-col p-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-bonewhite">
            Sandboxes
          </h1>
          <button
            type="button"
            onClick={() => setView({ kind: 'create' })}
            className="rounded bg-beacon px-3 py-1.5 font-mono text-xs font-medium text-basalt transition-opacity hover:opacity-90"
          >
            New sandbox
          </button>
        </div>

        {loading && (
          <p className="font-mono text-xs text-ash">loading…</p>
        )}

        {error && (
          <p className="font-mono text-xs text-rust">Error: {error}</p>
        )}

        {!loading && !error && sandboxes.length === 0 && (
          <p className="font-mono text-xs text-ash">No sandboxes.</p>
        )}

        {!loading && !error && sandboxes.length > 0 && (
          <ul className="flex flex-col gap-2">
            {sandboxes.map((sb) => (
              <li
                key={sb.id}
                className="flex items-center justify-between rounded border border-ash/20 bg-console px-4 py-3"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="font-mono text-sm text-bonewhite">{sb.name}</span>
                  <span
                    className={[
                      'font-mono text-xs',
                      sb.status === 'running' ? 'text-moss' : 'text-ash',
                    ].join(' ')}
                  >
                    {sb.status}
                  </span>
                </div>
                {sb.status === 'running' && (
                  <button
                    type="button"
                    onClick={() =>
                      setView({ kind: 'terminal', sandboxId: sb.id, name: sb.name })
                    }
                    className="rounded bg-beacon px-3 py-1.5 font-mono text-xs font-medium text-basalt transition-opacity hover:opacity-90"
                  >
                    Connect
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
