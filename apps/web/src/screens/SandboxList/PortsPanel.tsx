import { useEffect, useRef, useState } from 'react';
import type { PortInfo, PortsListResponse, PreviewGrantResponse } from '@outpost/shared-api';

interface PortsPanelProps {
  sandboxId: string;
  /** Sandbox display name — available for future URL construction or aria-labels */
  sandboxName: string;
  expanded: boolean;
}

interface PortRowState {
  port: PortInfo;
  exposing: boolean;
}

export function PortsPanel({ sandboxId, expanded }: PortsPanelProps) {
  const [rows, setRows] = useState<PortRowState[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addInput, setAddInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addPending, setAddPending] = useState(false);
  const [openingPort, setOpeningPort] = useState<number | null>(null);
  const prevExpanded = useRef(false);

  useEffect(() => {
    if (!expanded) {
      prevExpanded.current = false;
      return;
    }
    // fetch on every expand
    prevExpanded.current = true;
    setLoading(true);
    setError(null);
    fetch(`/api/sandboxes/${sandboxId}/ports`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<PortsListResponse>;
      })
      .then((data) => {
        setRows(data.ports.map((p) => ({ port: p, exposing: false })));
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [expanded, sandboxId]);

  function refetch() {
    fetch(`/api/sandboxes/${sandboxId}/ports`, { credentials: 'include' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<PortsListResponse>;
      })
      .then((data) => {
        setRows(data.ports.map((p) => ({ port: p, exposing: false })));
      })
      .catch(() => {
        // silently ignore refetch errors; stale data is acceptable
      });
  }

  function handleToggle(portNum: number, currentPublic: boolean) {
    if (currentPublic) {
      // public → private: immediate PATCH, no confirm
      fetch(`/api/sandboxes/${sandboxId}/ports/${portNum}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: false }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          refetch();
        })
        .catch(() => {
          // silently ignore; user will retry
        });
    } else {
      // private → public: show confirm banner
      setRows((prev) =>
        prev.map((r) => (r.port.port === portNum ? { ...r, exposing: true } : r)),
      );
    }
  }

  function handleCancelExpose(portNum: number) {
    setRows((prev) =>
      prev.map((r) => (r.port.port === portNum ? { ...r, exposing: false } : r)),
    );
  }

  function handleConfirmExpose(portNum: number) {
    fetch(`/api/sandboxes/${sandboxId}/ports/${portNum}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: true }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        refetch();
      })
      .catch(() => {
        setRows((prev) =>
          prev.map((r) => (r.port.port === portNum ? { ...r, exposing: false } : r)),
        );
      });
  }

  function handleDeletePort(portNum: number) {
    fetch(`/api/sandboxes/${sandboxId}/ports/${portNum}`, {
      method: 'DELETE',
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        refetch();
      })
      .catch(() => {
        // silently ignore; user will retry
      });
  }

  function handlePreviewClick(e: React.MouseEvent<HTMLAnchorElement>, port: PortInfo) {
    if (port.public) return;
    e.preventDefault();
    setOpeningPort(port.port);
    setError(null);

    // Open synchronously so browsers do not treat the eventual navigation as a
    // popup. Sever the opener before the preview app receives control.
    const targetName = `outpost-preview-${sandboxId}-${port.port}-${Date.now()}`;
    const previewWindow = window.open('about:blank', targetName);
    if (previewWindow) previewWindow.opener = null;

    fetch(`/api/sandboxes/${sandboxId}/ports/${port.port}/grant`, {
      method: 'POST',
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<PreviewGrantResponse>;
      })
      .then(({ url, grant }) => {
        const form = document.createElement('form');
        form.method = 'POST';
        form.action = url;
        form.target = previewWindow ? targetName : '_self';
        form.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'grant';
        input.value = grant;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        form.remove();
      })
      .catch((err: unknown) => {
        previewWindow?.close();
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setOpeningPort(null));
  }

  function handleAddPort(e: React.FormEvent) {
    e.preventDefault();
    const num = parseInt(addInput, 10);
    if (isNaN(num) || num < 1 || num > 65535) {
      setAddError('port must be 1–65535');
      return;
    }
    setAddPending(true);
    setAddError(null);
    fetch(`/api/sandboxes/${sandboxId}/ports`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: num }),
    })
      .then((res) => {
        if (res.status === 409) return res.json().then((d: { error: string }) => { throw { status: 409, error: d.error }; });
        if (res.status === 422) return res.json().then((d: { error: string }) => { throw { status: 422, error: d.error }; });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setAddInput('');
        setAddError(null);
        refetch();
      })
      .catch((err: unknown) => {
        if (err && typeof err === 'object' && 'error' in err) {
          setAddError((err as { error: string }).error);
        } else {
          setAddError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        setAddPending(false);
      });
  }

  if (!expanded) return null;

  return (
    <div className="border-t border-ash/10 bg-basalt px-4 py-3 pl-8 transition-all duration-200 motion-reduce:transition-none">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.14em] text-ash/60">
        PORTS · {rows.length}
      </div>

      {loading && <p className="font-mono text-xs text-ash">loading…</p>}
      {error && <p className="font-mono text-xs text-rust">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="font-mono text-xs text-ash/60">No ports registered.</p>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="flex flex-col">
          {rows.map(({ port, exposing }) => (
            <div key={port.port}>
              <div className="grid grid-cols-[66px_1fr_auto] items-center gap-4 border-b border-ash/10 py-2">
                <span className="font-mono text-[13px] text-bonewhite">:{port.port}</span>
                <div className="min-w-0">
                  {port.url ? (
                    <a
                      href={port.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-busy={openingPort === port.port}
                      onClick={(e) => handlePreviewClick(e, port)}
                      className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-moss hover:text-bonewhite"
                    >
                      {openingPort === port.port ? 'authorizing preview…' : port.url}
                    </a>
                  ) : (
                    <span className="font-mono text-xs text-ash/60">
                      preview domain not configured
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* PUBLIC/PRIVATE chip */}
                  <span
                    className={[
                      'font-mono text-[9px] tracking-[0.12em] px-1.5 py-0.5 rounded-sm border',
                      port.public
                        ? 'text-moss bg-moss/10 border-moss/35'
                        : 'text-ash/70 bg-ash/10 border-ash/20',
                    ].join(' ')}
                  >
                    {port.public ? 'PUBLIC' : 'PRIVATE'}
                  </span>

                  {/* Toggle */}
                  <button
                    type="button"
                    aria-label={port.public ? 'Make private' : 'Make public'}
                    onClick={() => handleToggle(port.port, port.public)}
                    className={[
                      'relative h-5 w-[38px] flex-none rounded-sm border transition-colors duration-200 motion-reduce:transition-none',
                      port.public
                        ? 'border-rust/50 bg-rust/20'
                        : 'border-ash/30 bg-ash/14',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'absolute top-0.5 h-[14px] w-[15px] rounded-sm transition-all duration-200 motion-reduce:transition-none',
                        port.public ? 'left-[19px] bg-rust' : 'left-0.5 bg-ash',
                      ].join(' ')}
                    />
                  </button>

                  {/* Delete */}
                  <button
                    type="button"
                    aria-label={`Remove port ${port.port}`}
                    onClick={() => handleDeletePort(port.port)}
                    className="font-mono text-xs text-ash/50 hover:text-rust"
                  >
                    ×
                  </button>
                </div>
              </div>

              {/* Expose confirm banner */}
              {exposing && (
                <div className="my-2 flex items-center justify-between gap-4 rounded border border-rust/30 bg-rust/10 px-3 py-2.5 transition-all duration-200 motion-reduce:transition-none">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="flex h-3.5 w-3.5 flex-none items-center justify-center rounded-sm border border-rust/50 bg-rust/25 font-mono text-[10px] text-rust">
                      !
                    </span>
                    <span className="font-body text-[12.5px] text-bonewhite">
                      Expose{' '}
                      <span className="font-mono text-rust">:{port.port}</span> to the public
                      internet? Anyone with the link can reach this sandbox.
                    </span>
                  </div>
                  <div className="flex flex-none gap-2">
                    <button
                      type="button"
                      onClick={() => handleCancelExpose(port.port)}
                      className="rounded-sm border border-ash/28 bg-transparent px-2.5 py-1.5 font-mono text-[10px] tracking-[0.1em] text-ash hover:text-bonewhite"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmExpose(port.port)}
                      className="rounded-sm border border-rust bg-rust px-3 py-1.5 font-mono text-[10px] font-medium tracking-[0.1em] text-basalt hover:bg-rust/90"
                    >
                      EXPOSE PORT
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ADD PORT */}
      <form onSubmit={handleAddPort} className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={addInput}
          onChange={(e) => { setAddInput(e.target.value); setAddError(null); }}
          placeholder="3000"
          className="w-20 rounded-sm border border-ash/20 bg-transparent px-2 py-1 font-mono text-xs text-bonewhite placeholder-ash/40 focus:border-ash/50 focus:outline-none"
          aria-label="Port number"
        />
        <button
          type="submit"
          disabled={addPending}
          className="rounded-sm border border-ash/28 bg-transparent px-2.5 py-1 font-mono text-[10px] tracking-[0.1em] text-ash hover:text-bonewhite disabled:cursor-not-allowed disabled:opacity-40"
        >
          ADD
        </button>
        {addError && (
          <span className="font-mono text-[10px] text-rust">{addError}</span>
        )}
      </form>

    </div>
  );
}
