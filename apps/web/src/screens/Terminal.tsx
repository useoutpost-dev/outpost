/**
 * Terminal screen — xterm.js wired to /api/sandboxes/:id/terminal via WebSocket.
 *
 * Wire protocol (server contract from ws.ts / session-manager.ts):
 *   binary frames  = raw terminal bytes (write to xterm; send user input as binary)
 *   text frames    = JSON control:
 *     {"type":"resize","cols":N,"rows":N}     — sent by us, not received
 *     {"type":"ping"} / {"type":"pong"}        — server pings; we reply pong
 *     {"type":"replay-end"}                    — end of scrollback replay; ignore
 *     {"type":"upstream","state":"reconnecting"|"connected"} — upstream state
 *     {"type":"error","code":"...","message":"..."} — terminal error
 *   close codes:
 *     4404 — sandbox not found (no retry)
 *     4409 — sandbox not running / terminal unavailable (no retry)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { buildTermTheme } from '../lib/term-theme';
import { TermToolbar } from '../components/TermToolbar';
import '@xterm/xterm/css/xterm.css';

export interface TerminalProps {
  sandboxId: string;
  name?: string;
  onBack: () => void;
}

type ConnectionStatus =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'unavailable'; message: string };

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 8_000;
/** Close codes that mean "give up, don't retry". */
const TERMINAL_FATAL_CODES = new Set([4404, 4409]);

export function Terminal({ sandboxId, name, onBack }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(RECONNECT_MIN_MS);
  const attemptRef = useRef(0);
  const destroyedRef = useRef(false);

  const [status, setStatus] = useState<ConnectionStatus>({ kind: 'connecting' });

  /** Send a JSON control frame if the socket is open. */
  const sendControl = useCallback((obj: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }, []);

  /** Send raw terminal bytes from the toolbar or xterm.onData. */
  const sendBytes = useCallback((bytes: Uint8Array) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(bytes.buffer);
    }
  }, []);

  /** Send a resize control frame based on the current fit-addon dimensions. */
  const sendResize = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    sendControl({ type: 'resize', cols: term.cols, rows: term.rows });
  }, [sendControl]);

  const connect = useCallback(() => {
    if (destroyedRef.current) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/sandboxes/${sandboxId}/terminal`;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.addEventListener('open', () => {
      if (destroyedRef.current) { ws.close(); return; }
      reconnectDelayRef.current = RECONNECT_MIN_MS;
      attemptRef.current = 0;
      setStatus({ kind: 'connected' });
      // Send initial resize so server knows our viewport.
      sendResize();
    });

    ws.addEventListener('message', (evt: MessageEvent) => {
      if (destroyedRef.current) return;
      const term = termRef.current;
      if (!term) return;

      if (evt.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(evt.data));
        return;
      }

      // Text = JSON control frame.
      let ctrl: { type?: string; state?: string; message?: string } = {};
      try {
        ctrl = JSON.parse(evt.data as string) as typeof ctrl;
      } catch {
        return; // malformed: ignore
      }

      switch (ctrl.type) {
        case 'ping':
          sendControl({ type: 'pong' });
          break;
        case 'replay-end':
          // End of scrollback replay — nothing to do on the client.
          break;
        case 'upstream':
          if (ctrl.state === 'reconnecting') {
            setStatus((s) =>
              s.kind === 'reconnecting' ? s : { kind: 'reconnecting', attempt: 1 }
            );
          } else if (ctrl.state === 'connected') {
            setStatus({ kind: 'connected' });
          }
          break;
        case 'error':
          // Server sent an error control frame before closing; let the close
          // handler deal with the final status.
          break;
        default:
          break;
      }
    });

    ws.addEventListener('error', () => {
      // 'close' always follows 'error' in the browser; all state is handled there.
    });

    ws.addEventListener('close', (evt: CloseEvent) => {
      wsRef.current = null;
      if (destroyedRef.current) return;

      if (TERMINAL_FATAL_CODES.has(evt.code)) {
        const msg =
          evt.code === 4404
            ? 'Sandbox not found.'
            : 'Terminal unavailable — sandbox may not be running.';
        setStatus({ kind: 'unavailable', message: msg });
        return;
      }

      // Unexpected close — reconnect with exponential backoff.
      attemptRef.current += 1;
      const attempt = attemptRef.current;
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(delay * 2, RECONNECT_MAX_MS);

      setStatus({ kind: 'reconnecting', attempt });
      // Clear terminal so server replay starts fresh.
      termRef.current?.clear();

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    });
  }, [sandboxId, sendControl, sendResize]);

  useEffect(() => {
    if (!containerRef.current) return;
    destroyedRef.current = false;

    const term = new XTerm({
      theme: buildTermTheme(),
      fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // User input → binary frame.
    term.onData((data) => {
      const bytes = new TextEncoder().encode(data);
      sendBytes(bytes);
    });

    connect();

    // ResizeObserver keeps the terminal dimensions in sync.
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* ignore during teardown */ }
      sendResize();
    });
    if (containerRef.current) ro.observe(containerRef.current);

    // Window resize fallback.
    const onWindowResize = () => {
      try { fit.fit(); } catch { /* ignore */ }
      sendResize();
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      destroyedRef.current = true;
      ro.disconnect();
      window.removeEventListener('resize', onWindowResize);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        wsRef.current = null;
        try { ws.close(1000, 'unmount'); } catch { /* ignore */ }
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sandboxId]); // connect/sendBytes/sendResize are stable useCallback refs

  return (
    <div className="flex h-screen flex-col bg-basalt">
      {/* Header bar */}
      <div className="flex h-10 flex-none items-center gap-3 border-b border-ash/20 bg-console px-4">
        <button
          onClick={onBack}
          className="font-mono text-xs text-ash transition-colors hover:text-bonewhite"
        >
          ← back
        </button>
        <span className="font-mono text-xs text-bonewhite">{name ?? sandboxId}</span>
        <span className="ml-auto">
          <StatusBadge status={status} />
        </span>
      </div>

      {/* xterm container */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden p-1" />

      {/* Mobile toolbar */}
      <TermToolbar sendBytes={sendBytes} />
    </div>
  );
}

function StatusBadge({ status }: { status: ConnectionStatus }) {
  switch (status.kind) {
    case 'connecting':
      return <span className="font-mono text-xs text-ash">connecting…</span>;
    case 'connected':
      return <span className="font-mono text-xs text-moss">connected</span>;
    case 'reconnecting':
      return (
        <span className="font-mono text-xs text-beacon">
          reconnecting (attempt {status.attempt})…
        </span>
      );
    case 'unavailable':
      return <span className="font-mono text-xs text-rust">{status.message}</span>;
  }
}
