/**
 * Sticky bottom key row for mobile (also visible on desktop).
 *
 * Keys: Esc, Tab, Ctrl (modifier-latch), ←↑↓→, /
 *
 * Ctrl modifier-latch: pressing Ctrl highlights it; the NEXT key pressed
 * sends the ctrl-modified byte (charCode & 0x1F) then automatically unlatches.
 *
 * All buttons preventDefault on pointerdown so they never steal focus from
 * the xterm terminal.
 *
 * Byte sequences:
 *   Esc   → \x1b
 *   Tab   → \t  (\x09)
 *   ←     → \x1b[D
 *   ↑     → \x1b[A
 *   ↓     → \x1b[B
 *   →     → \x1b[C
 *   /     → /   (0x2F)
 *   Ctrl+<key> → charCode & 0x1F  (e.g. Ctrl+C → 0x03)
 */

import { useState, useCallback } from 'react';

export interface TermToolbarProps {
  /** Inject raw bytes into the terminal's WebSocket. */
  sendBytes: (bytes: Uint8Array) => void;
}

const enc = new TextEncoder();

function bytes(s: string): Uint8Array {
  return enc.encode(s);
}

export function TermToolbar({ sendBytes }: TermToolbarProps) {
  const [ctrlLatched, setCtrlLatched] = useState(false);

  /** Send a byte sequence, applying the Ctrl latch if active. */
  const send = useCallback(
    (seq: string) => {
      if (ctrlLatched) {
        // Apply ctrl to the FIRST character of the sequence.
        const code = seq.charCodeAt(0) & 0x1f;
        sendBytes(new Uint8Array([code]));
        setCtrlLatched(false);
      } else {
        sendBytes(bytes(seq));
      }
    },
    [ctrlLatched, sendBytes]
  );

  const toggleCtrl = useCallback(() => {
    setCtrlLatched((v) => !v);
  }, []);

  /** Prevent focus steal from the terminal on all toolbar buttons. */
  const noFocusSteal = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div className="flex flex-none flex-wrap gap-1 border-t border-ash/20 bg-console px-2 py-1.5">
      <ToolKey label="Esc"  onPointerDown={noFocusSteal} onClick={() => send('\x1b')} />
      <ToolKey label="Tab"  onPointerDown={noFocusSteal} onClick={() => send('\t')} />
      <ToolKey
        label="Ctrl"
        onPointerDown={noFocusSteal}
        onClick={toggleCtrl}
        active={ctrlLatched}
      />
      <ToolKey label="←"   onPointerDown={noFocusSteal} onClick={() => send('\x1b[D')} />
      <ToolKey label="↑"   onPointerDown={noFocusSteal} onClick={() => send('\x1b[A')} />
      <ToolKey label="↓"   onPointerDown={noFocusSteal} onClick={() => send('\x1b[B')} />
      <ToolKey label="→"   onPointerDown={noFocusSteal} onClick={() => send('\x1b[C')} />
      <ToolKey label="/"   onPointerDown={noFocusSteal} onClick={() => send('/')} />
    </div>
  );
}

interface ToolKeyProps {
  label: string;
  onClick: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  active?: boolean;
}

function ToolKey({ label, onClick, onPointerDown, active }: ToolKeyProps) {
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onClick={onClick}
      className={[
        'min-w-[2.5rem] rounded px-2 py-1',
        'font-mono text-xs',
        'border',
        'transition-colors',
        active
          ? 'border-beacon bg-beacon text-basalt'
          : 'border-ash/30 bg-basalt text-bonewhite hover:border-ash/60 hover:text-beacon',
      ].join(' ')}
    >
      {label}
    </button>
  );
}
