import type { ReactNode } from 'react';

interface AppShellProps {
  children?: ReactNode;
  login?: string;
}

export function AppShell({ children, login }: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-basalt">
      {/* Top bar: 56px, console bg, 1px ash/20% bottom border */}
      <header className="flex h-14 flex-none items-center border-b border-ash/20 bg-console px-6">
        {/* Left: OUTPOST wordmark — display font, tracked out, bonewhite */}
        <span className="select-none font-display text-sm font-semibold uppercase tracking-[0.25em] text-bonewhite">
          OUTPOST
        </span>

        {/* Right side — login handle when present */}
        <div className="ml-auto">
          {login && (
            <span className="font-mono text-xs text-ash">{login}</span>
          )}
        </div>
      </header>

      {/* Page content */}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
