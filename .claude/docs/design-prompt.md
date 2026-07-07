# Claude Design prompt — Outpost (Field Console)

Copy-paste the block below into Claude Design. Source of truth for tokens:
`.claude/skills/field-console-design/SKILL.md` — if they ever disagree, the skill wins.

```
You are designing "Outpost" — a self-hosted browser console for running Claude Code in
isolated cloud sandboxes. One user, their own infrastructure, their own Claude account.

PERSONALITY — "Field Console": expedition field equipment. Olive-graphite housing, bone
paper, one amber indicator lamp. Calm, dense, engineered. Every pixel earns its place.
This must NOT look like a generic dev tool: no blue-slate dark mode, no Inter, no
shadcn defaults, no glassmorphism, no gradients.

──────────────────────────────────────────────────────────────────────────────
COLOR PALETTE (exact values — these are the product's Tailwind tokens)
──────────────────────────────────────────────────────────────────────────────
basalt    #141610  app background. Olive-black, warm — never blue.
console   #1D2018  panels, cards, terminal chrome, table rows, top bar.
bonewhite #EAE6D9  primary text. Warm paper — never pure white (#FFF is banned).
ash       #8B9283  secondary text, borders (use at 20% for hairlines), muted icons.
beacon    #F2A93B  THE accent. Scarce by law: exactly one amber element per screen —
                   the primary action, or the terminal cursor. Usage bars are the
                   only exception and may always be beacon.
moss      #8CA870  status only: running/success chips. Never decorative.
rust      #C05B4D  status only: errors and destroy confirmations. Never decorative.

Surfaces are flat: separation comes from the basalt/console step and 1px ash/20%
hairlines — no drop shadows, no elevation stack. Hierarchy comes from type and space.

──────────────────────────────────────────────────────────────────────────────
TYPOGRAPHY (all self-hostable — no paid fonts, no CDNs)
──────────────────────────────────────────────────────────────────────────────
Clash Grotesk (Fontshare) — display voice. Wordmark + screen titles only.
  Wordmark "OUTPOST": 16px, semibold, +8% letterspacing, bonewhite.
  Screen titles: 22px/28px, medium. Use it confidently, then get out of the way.
Switzer (Fontshare) — everything UI. Pairs with Clash Grotesk (same foundry).
  Body 14px/20px regular · labels 13px/16px medium · captions 12px/16px, ash.
Plex Mono (IBM) — the machine's voice. Terminal content, ALL numerals (usage %,
  timestamps, ports, sandbox IDs), status codes, key hints. Tabular figures in
  columns. 13px in tables, 14px in the terminal.
Rule of thumb: if a human wrote it → Switzer; if the system emitted it → Plex Mono;
if it names the product or a screen → Clash Grotesk.

──────────────────────────────────────────────────────────────────────────────
LAYOUT SYSTEM
──────────────────────────────────────────────────────────────────────────────
4px base grid. Compact console density: table rows 40px, inputs 36px, buttons 32px.
Radius: 6px cards/inputs, 4px chips/buttons. Max content width 1200px except the
terminal (full-bleed). Focus ring: 1px beacon outline, offset 2px — visible always.

APP SHELL — design ONCE, identical on every authenticated screen incl. Terminal:
56px top bar on console, 1px ash/20% bottom border.
  Left: OUTPOST wordmark.
  Nav: Sandboxes · Usage · Settings — ash default, bonewhite when active (no beacon
  in the nav — beacon belongs to each screen's single primary action).
  Right: usage mini-readout in Plex Mono ("34% est.") + GitHub avatar (24px, round).
Only Login and the onboarding overlay live outside the shell.

COMPONENT NOTES
Buttons: primary = beacon fill, basalt text (the ONE per screen); secondary = console
  fill, 1px ash/20% border, bonewhite text; destructive = rust outline, rust text,
  fills rust with bonewhite text only inside a confirm step.
Status chips: 4px radius, tinted at ~15% fill with solid-color text + dot —
  moss "running", ash "stopped", rust "error". Plex Mono, 12px.
Tables: sentence-case headers in 12px ash Switzer; hairline row dividers; numerals
  right-aligned Plex Mono; hover = row shifts to console.
Inputs: console fill, 1px ash/20% border, beacon border on focus, bonewhite text.
Toasts: the inversion in the system — bonewhite card, basalt text, 6px radius,
  bottom-right; rust left-edge bar when it's an error. (Light card on dark app.)
Empty states: one Switzer sentence + one action. No illustrations, no mascots.

──────────────────────────────────────────────────────────────────────────────
SCREENS
──────────────────────────────────────────────────────────────────────────────
1. LOGIN (no shell) — centered console card on basalt: wordmark, one line of Switzer
   ("Your sandboxes. Your keys. Your infra."), one beacon button "Continue with
   GitHub". Nothing else on the page.
2. SANDBOX LIST (home) — table rows: name (Switzer medium) · status chip · account
   label (ash) · last activity (Plex Mono, relative). Row actions on hover: open
   terminal, stop, destroy (destroy → inline rust confirm, never a browser alert).
   Beacon "New sandbox" top-right = the screen's one accent. Right rail 320px:
   activity feed — mono timestamps, ash text, newest first, quietly scrolling.
3. SANDBOX CREATE (panel over the list) — name field + account picker as three
   radio-cards: existing account · new subscription account · new API key. Selected
   card: beacon border. One step, one "Create" button (inherits the beacon).
4. TERMINAL — shell stays; xterm fills the rest on console. 32px status strip:
   sandbox name, connection dot (moss live / ash reconnecting), close. Reconnect =
   thin ash banner sliding under the strip — never a modal over the terminal.
   Beacon block cursor is this screen's accent. Mobile: sticky key row above the
   soft keyboard — Esc · Tab · Ctrl · ↑ ↓ ← → · "/" as 32px console keys.
5. USAGE — hero: horizontal usage bar, beacon fill on a console track, 8px tall,
   Plex Mono "34%" + the word "estimated" in ash 12px directly beside it (this label
   is a legal requirement, not decoration). Below: totals table — tokens in/out,
   per-model rows, cost column headed "est. API value" (never "cost" or "bill").
   No charts. Numbers are the design.
6. SETTINGS — single column, three quiet groups: Accounts (label + kind chip),
   "Replay onboarding" action, read-only allowlist. The screen where nothing
   competes for attention.
7. ONBOARDING OVERLAY (first login) — 4 spotlight steps over the real UI: dim the
   app to 40%, cut an amber-ringed spotlight around the target region, 1–2 Switzer
   sentences beside it, "Skip" always visible in ash.
   Steps: ① what Outpost is → ② sandbox list + create → ③ terminal + "sessions
   survive disconnects" → ④ account picker + usage bar. Step dots in Plex Mono.

MOTION (Framer Motion): 200–400ms, ease-out, opacity + ≤8px translate. No bounces,
no scale pops. Onboarding may sweep the spotlight between regions; everything honors
prefers-reduced-motion (instant swaps, no sweep, no dimming animation).

DATA IN MOCKUPS: use realistic sandbox names (e.g. "atsresumie-dev", "oshc-portal"),
believable token counts and timestamps — clearly fake IDs, no real keys.

DO NOT DESIGN: logos/brand marks, marketing or landing pages, pricing, light theme,
multi-user/team UI, charts or analytics dashboards (paid tier, out of scope),
illustration systems. Never write "Claude Outpost" — the product is "Outpost",
descriptively "Outpost — for Claude Code".
```
