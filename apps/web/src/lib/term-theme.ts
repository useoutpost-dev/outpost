/**
 * Single documented mapping point: Field Console tokens → xterm.js ITheme.
 *
 * xterm requires concrete color values in its theme object; it cannot consume
 * CSS variables directly. We read the values from CSS custom properties at
 * runtime via getComputedStyle so the source of truth stays in globals.css /
 * tailwind.config.ts — no hex literals here; a missing variable is omitted so
 * xterm falls back to its own default rather than a stale copy of the palette.
 *
 * Token mapping:
 *   background      ← --color-console   (#1D2018) — terminal surface
 *   foreground      ← --color-bonewhite (#EAE6D9) — normal text
 *   cursor          ← --color-beacon    (#F2A93B) — amber accent, visible on dark
 *   cursorAccent    ← --color-basalt    (#141610) — text inside the cursor cell
 *   selectionBackground ← --color-ash   (#8B9283) — 40% opacity applied by xterm
 *   black           ← --color-basalt    (#141610)
 *   brightBlack     ← --color-ash       (#8B9283)
 *   white           ← --color-bonewhite (#EAE6D9)
 *   brightWhite     ← --color-bonewhite (#EAE6D9)
 *   green           ← --color-moss      (#8CA870)
 *   brightGreen     ← --color-moss      (#8CA870)
 *   red             ← --color-rust      (#C05B4D)
 *   brightRed       ← --color-rust      (#C05B4D)
 *   yellow          ← --color-beacon    (#F2A93B)
 *   brightYellow    ← --color-beacon    (#F2A93B)
 *   (blue/magenta/cyan: no canonical Field Console tokens — map to ash/moss variants)
 */

import type { ITheme } from '@xterm/xterm';

/** Read a CSS custom property from :root; undefined when absent so the theme
 *  key is dropped and xterm uses its built-in default. */
function cssVar(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || undefined;
}

export function buildTermTheme(): ITheme {
  const basalt = cssVar('--color-basalt');
  const console_ = cssVar('--color-console');
  const bonewhite = cssVar('--color-bonewhite');
  const ash = cssVar('--color-ash');
  const beacon = cssVar('--color-beacon');
  const moss = cssVar('--color-moss');
  const rust = cssVar('--color-rust');

  const theme: ITheme = {
    background:          console_,
    foreground:          bonewhite,
    cursor:              beacon,
    cursorAccent:        basalt,
    selectionBackground: ash,
    black:               basalt,
    brightBlack:         ash,
    white:               bonewhite,
    brightWhite:         bonewhite,
    red:                 rust,
    brightRed:           rust,
    green:               moss,
    brightGreen:         moss,
    yellow:              beacon,
    brightYellow:        beacon,
    // blue/magenta/cyan: no dedicated Field Console token — use ash/moss variants
    blue:                ash,
    brightBlue:          ash,
    magenta:             rust,
    brightMagenta:       rust,
    cyan:                moss,
    brightCyan:          moss,
  };
  for (const key of Object.keys(theme) as (keyof ITheme)[]) {
    if (theme[key] === undefined) delete theme[key];
  }
  return theme;
}
