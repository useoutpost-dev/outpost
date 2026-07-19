import { useState } from 'react';
import { Terminal } from '../screens/Terminal';
import { SandboxCreate } from '../screens/SandboxCreate';
import { Usage } from '../screens/Usage';
import { SandboxList } from '../screens/SandboxList/SandboxList';

interface AppShellProps {
  login?: string;
}

type View =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'terminal'; sandboxId: string; name: string }
  | { kind: 'usage' }
  | { kind: 'activity' };

export function AppShell({ login }: AppShellProps) {
  const [view, setView] = useState<View>({ kind: 'list' });

  if (view.kind === 'usage') {
    return <Usage onBack={() => setView({ kind: 'list' })} />;
  }

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

  // list and activity views share the same shell frame; tab switching is inside SandboxList
  return (
    <div className="flex min-h-screen flex-col bg-basalt">
      {/* Top bar */}
      <header className="flex h-14 flex-none items-center border-b border-ash/20 bg-console px-6">
        <span className="select-none font-display text-sm font-semibold uppercase tracking-[0.25em] text-bonewhite">
          OUTPOST
        </span>
        <div className="ml-auto flex items-center gap-4">
          <button
            type="button"
            onClick={() => setView({ kind: 'create' })}
            className="rounded bg-beacon px-3 py-1.5 font-mono text-xs font-medium text-basalt transition-opacity hover:opacity-90"
          >
            New sandbox
          </button>
          <button
            type="button"
            onClick={() => setView({ kind: 'usage' })}
            className="font-mono text-xs text-ash hover:text-bonewhite"
          >
            Usage
          </button>
          {login && <span className="font-mono text-xs text-ash">{login}</span>}
        </div>
      </header>

      {/* Main content — SandboxList owns SANDBOXES/ACTIVITY tab bar */}
      <main className="flex flex-1 flex-col">
        <SandboxList
          onOpenTerminal={(id, name) => setView({ kind: 'terminal', sandboxId: id, name })}
        />
      </main>
    </div>
  );
}
