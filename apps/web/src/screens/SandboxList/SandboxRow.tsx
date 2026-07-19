import { useState } from 'react';
import { PortsPanel } from './PortsPanel';

export interface SandboxItem {
  id: string;
  name: string;
  status: string;
  accountId: string | null;
  updatedAt: string | number;
}

interface SandboxRowProps {
  sandbox: SandboxItem;
  index: number;
  onOpenTerminal: () => void;
  onStop: () => void;
  onDestroy: () => void;
}

function relativeTime(updatedAt: string | number): string {
  const ms = typeof updatedAt === 'string' ? new Date(updatedAt).getTime() : updatedAt;
  if (isNaN(ms)) return '—';
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

type StatusVariant = 'running' | 'creating' | 'stopping' | 'stopped' | 'error';

function statusMeta(status: string): {
  label: string;
  chipCls: string;
  dotCls: string;
  dotStyle: 'solid' | 'pulse' | 'hollow';
} {
  switch (status as StatusVariant) {
    case 'running':
      return {
        label: 'RUNNING',
        chipCls: 'bg-moss/10 border-moss/32 text-moss',
        dotCls: 'bg-moss',
        dotStyle: 'solid',
      };
    case 'creating':
    case 'stopping':
      return {
        label: status === 'creating' ? 'CREATING' : 'STOPPING',
        chipCls: 'bg-ash/10 border-ash/28 text-ash',
        dotCls: 'bg-ash animate-pulse motion-reduce:animate-none',
        dotStyle: 'pulse',
      };
    case 'stopped':
      return {
        label: 'STOPPED',
        chipCls: 'bg-transparent border-ash/20 text-ash/70',
        dotCls: '',
        dotStyle: 'hollow',
      };
    case 'error':
      return {
        label: 'ERROR',
        chipCls: 'bg-rust/10 border-rust/34 text-rust',
        dotCls: 'bg-rust',
        dotStyle: 'solid',
      };
    default:
      return {
        label: status.toUpperCase(),
        chipCls: 'bg-transparent border-ash/20 text-ash',
        dotCls: 'bg-ash',
        dotStyle: 'solid',
      };
  }
}

export function SandboxRow({ sandbox, index, onOpenTerminal, onStop, onDestroy }: SandboxRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const running = sandbox.status === 'running';
  const { label, chipCls, dotCls, dotStyle } = statusMeta(sandbox.status);

  const animDelay = `${index * 35}ms`;

  return (
    <div
      className="border-b border-ash/10 last:border-b-0"
      style={{ animationDelay: animDelay }}
    >
      {/* Row summary */}
      <div
        className="grid cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-bonewhite/[0.02] motion-reduce:transition-none"
        style={{ gridTemplateColumns: '20px minmax(180px,1.4fr) 128px 1fr 120px auto' }}
        onClick={() => { setExpanded((v) => !v); setConfirming(false); }}
      >
        {/* Caret */}
        <span
          className="inline-block font-mono text-[15px] text-ash/60 transition-transform duration-200 motion-reduce:transition-none"
          style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
          aria-hidden
        >
          ›
        </span>

        {/* Name + id */}
        <div className="min-w-0">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap font-body text-sm font-medium text-bonewhite">
            {sandbox.name}
          </div>
          <div className="mt-0.5 font-mono text-[10.5px] text-ash/60">{sandbox.id}</div>
        </div>

        {/* Status chip */}
        <div>
          <span
            className={[
              'inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 font-mono text-[10.5px] tracking-[0.09em] whitespace-nowrap',
              chipCls,
            ].join(' ')}
          >
            {dotStyle === 'hollow' ? (
              <span
                className="h-1.5 w-1.5 flex-none rounded-full border-[1.5px] border-current"
                aria-hidden
              />
            ) : (
              <span
                className={['h-1.5 w-1.5 flex-none rounded-full', dotCls].join(' ')}
                aria-hidden
              />
            )}
            {label}
          </span>
        </div>

        {/* Account */}
        <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-ash">
          {sandbox.accountId ?? '—'}
        </div>

        {/* Last activity */}
        <div className="font-mono text-xs text-ash">{relativeTime(sandbox.updatedAt)}</div>

        {/* Actions */}
        <div
          className="flex items-center justify-end gap-1.5"
          onClick={(e) => e.stopPropagation()}
        >
          {confirming ? (
            <div className="flex items-center gap-1.5" style={{ animation: 'slideIn 220ms ease-out both' }}>
              <span className="font-mono text-[10.5px] tracking-[0.06em] text-rust">
                Destroy {sandbox.name}?
              </span>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-sm border border-ash/28 bg-transparent px-2.5 py-1.5 font-mono text-[10px] tracking-[0.1em] text-ash hover:text-bonewhite"
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={() => { setConfirming(false); onDestroy(); }}
                className="rounded-sm border border-rust bg-rust px-2.5 py-1.5 font-mono text-[10px] font-medium tracking-[0.1em] text-basalt hover:bg-rust/90"
              >
                DESTROY
              </button>
            </div>
          ) : (
            <>
              <button
                type="button"
                disabled={!running}
                onClick={running ? onOpenTerminal : undefined}
                className={[
                  'rounded-sm border px-2.5 py-1.5 font-mono text-[10px] tracking-[0.1em] transition-colors duration-150 motion-reduce:transition-none',
                  running
                    ? 'border-ash/28 text-ash hover:border-bonewhite/20 hover:bg-bonewhite/5 hover:text-bonewhite cursor-pointer'
                    : 'border-ash/12 text-ash/30 cursor-not-allowed pointer-events-none',
                ].join(' ')}
              >
                TERM
              </button>
              <button
                type="button"
                disabled={!running}
                onClick={running ? onStop : undefined}
                className={[
                  'rounded-sm border px-2.5 py-1.5 font-mono text-[10px] tracking-[0.1em] transition-colors duration-150 motion-reduce:transition-none',
                  running
                    ? 'border-ash/28 text-ash hover:border-bonewhite/20 hover:bg-bonewhite/5 hover:text-bonewhite cursor-pointer'
                    : 'border-ash/12 text-ash/30 cursor-not-allowed pointer-events-none',
                ].join(' ')}
              >
                STOP
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="rounded-sm border border-ash/28 bg-transparent px-2.5 py-1.5 font-mono text-[10px] tracking-[0.1em] text-ash hover:border-rust/50 hover:text-rust transition-colors duration-150 motion-reduce:transition-none"
              >
                DESTROY
              </button>
            </>
          )}
        </div>
      </div>

      {/* Ports panel (expands below) */}
      <PortsPanel
        sandboxId={sandbox.id}
        sandboxName={sandbox.name}
        expanded={expanded}
      />
    </div>
  );
}
