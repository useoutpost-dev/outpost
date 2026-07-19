import { useEffect, useRef, useState } from 'react';
import type { EventRecord, EventsListResponse } from '@outpost/shared-api';

const PAGE_SIZE = 20;

function formatTs(tsMs: number): string {
  const d = new Date(tsMs);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}:${ss}`;
}

type DotVariant = 'moss' | 'rust' | 'ash';

function eventDot(kind: string): DotVariant {
  if (kind === 'sandbox.running' || kind === 'auth.login') return 'moss';
  if (kind === 'sandbox.destroyed' || kind === 'sandbox.error') return 'rust';
  return 'ash';
}

function dotClass(variant: DotVariant): string {
  switch (variant) {
    case 'moss': return 'bg-moss';
    case 'rust': return 'bg-rust';
    default: return 'bg-ash';
  }
}

function typeTextClass(variant: DotVariant): string {
  switch (variant) {
    case 'moss': return 'text-moss';
    case 'rust': return 'text-rust';
    default: return 'text-ash';
  }
}

function eventText(record: EventRecord): string {
  try {
    const payload = record.payload as Record<string, unknown> | null | undefined;
    const sid = record.sandboxId ?? '';
    switch (record.kind) {
      case 'sandbox.creating': return `${sid} creating`;
      case 'sandbox.running': return `${sid} started`;
      case 'sandbox.stopped': return `${sid} stopped`;
      case 'sandbox.destroyed': return `${sid} destroyed`;
      case 'sandbox.error': return `${sid} error` + (payload?.message ? `: ${String(payload.message)}` : '');
      case 'auth.login': return `signed in` + (payload?.login ? ` · ${String(payload.login)}` : '');
      case 'auth.logout': return `signed out` + (payload?.login ? ` · ${String(payload.login)}` : '');
      case 'port.exposed': return `${sid} port ${String(payload?.port ?? '')} exposed`;
      case 'port.hidden': return `${sid} port ${String(payload?.port ?? '')} hidden`;
      default: return record.kind + (sid ? ` · ${sid}` : '');
    }
  } catch {
    return record.kind;
  }
}

function kindLabel(kind: string): string {
  return kind.split('.').pop()?.toUpperCase() ?? kind.toUpperCase();
}

export function ActivityFeed() {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fetchEvents(off: number, showLoading = false) {
    if (showLoading) setLoading(true);
    fetch(`/api/events?limit=${PAGE_SIZE}&offset=${off}`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<EventsListResponse>;
      })
      .then((data) => {
        setEvents(data.events);
        setTotal(data.total);
        setLoading(false);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }

  // initial load
  useEffect(() => {
    fetchEvents(0, true);
  }, []);

  // poll every 10s only when on first page
  useEffect(() => {
    if (offset !== 0) {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    intervalRef.current = setInterval(() => fetchEvents(0), 10000);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [offset]);

  function goPage(newOffset: number) {
    setOffset(newOffset);
    fetchEvents(newOffset, true);
  }

  const start = offset + 1;
  const end = Math.min(offset + PAGE_SIZE, total);
  const pageLabel = total > 0 ? `SHOWING ${start}–${end} OF ${total}` : 'NO EVENTS';
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;

  return (
    <div>
      <div className="mb-4">
        <h1 className="m-0 font-display text-[23px] font-semibold tracking-tight text-bonewhite">
          Activity
        </h1>
        <p className="mt-1.5 font-mono text-[11.5px] tracking-[0.06em] text-ash">
          Sandbox lifecycle &amp; auth events · newest first
        </p>
      </div>

      <div className="overflow-hidden rounded border border-ash/20 bg-console">
        {loading && (
          <p className="px-4 py-4 font-mono text-xs text-ash">loading…</p>
        )}
        {error && (
          <p className="px-4 py-4 font-mono text-xs text-rust">Error: {error}</p>
        )}
        {!loading && !error && events.length === 0 && (
          <p className="px-4 py-4 font-mono text-xs text-ash/60">No events recorded yet.</p>
        )}
        {!loading && !error && events.length > 0 && (
          <div>
            {events.map((ev, i) => {
              const dot = eventDot(ev.kind);
              return (
                <div
                  key={ev.id}
                  className="grid items-center gap-3 border-b border-ash/7 px-4 py-2.5 last:border-b-0"
                  style={{ gridTemplateColumns: '118px 12px 88px 1fr', animationDelay: `${i * 28}ms` }}
                >
                  <span className="font-mono text-xs text-ash/60">{formatTs(ev.ts)}</span>
                  <span
                    className={['h-1.5 w-1.5 flex-none rounded-full', dotClass(dot)].join(' ')}
                    aria-hidden
                  />
                  <span
                    className={['font-mono text-[10.5px] tracking-[0.1em]', typeTextClass(dot)].join(' ')}
                  >
                    {kindLabel(ev.kind)}
                  </span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap font-body text-[13px] text-bonewhite/86">
                    {eventText(ev)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        <div className="flex items-center justify-between border-t border-ash/14 px-4 py-3">
          <span className="font-mono text-[11px] tracking-[0.06em] text-ash/60">
            {pageLabel}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!hasPrev}
              onClick={hasPrev ? () => goPage(offset - PAGE_SIZE) : undefined}
              className={[
                'rounded-sm border px-3 py-1.5 font-mono text-[10px] tracking-[0.1em] transition-colors duration-150 motion-reduce:transition-none',
                hasPrev
                  ? 'border-ash/28 text-ash hover:text-bonewhite cursor-pointer'
                  : 'border-ash/12 text-ash/30 cursor-not-allowed pointer-events-none',
              ].join(' ')}
            >
              PREV
            </button>
            <button
              type="button"
              disabled={!hasNext}
              onClick={hasNext ? () => goPage(offset + PAGE_SIZE) : undefined}
              className={[
                'rounded-sm border px-3 py-1.5 font-mono text-[10px] tracking-[0.1em] transition-colors duration-150 motion-reduce:transition-none',
                hasNext
                  ? 'border-ash/28 text-ash hover:text-bonewhite cursor-pointer'
                  : 'border-ash/12 text-ash/30 cursor-not-allowed pointer-events-none',
              ].join(' ')}
            >
              NEXT
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
