---
name: field-console-design
description: Field Console visual identity — tokens, typography, motion rules. Read before any UI work or Codex Design handoff.
---

# Field Console

Palette story: field equipment — olive-graphite housing, bone paper, one amber
indicator lamp. Deliberately NOT blue-slate dev-tool dark.

## Tokens (Tailwind theme names)
- `basalt`  #141610 — app background (olive-black)
- `console` #1D2018 — panels, cards, terminal chrome
- `bonewhite` #EAE6D9 — primary text (warm paper, never pure white)
- `ash`     #8B9283 — secondary text, borders (desaturated sage-grey)
- `beacon`  #F2A93B — accent: primary CTA, usage bars, cursor
- `moss`    #8CA870 — status: running / success only
- `rust`    #C05B4D — status: errors / destructive actions only

moss and rust are status colors, never decoration. Chips and confirm-destroy only.

## Typography (all self-hosted, no CDN)
- Display/headings: Clash Grotesk (Fontshare)
- Body/UI: Switzer (Fontshare — pairs with Clash Grotesk, holds at 12px density)
- Terminal + telemetry numbers: IBM Plex Mono (full box-drawing coverage; true italic)

## App shell (identical on every authenticated screen, incl. Terminal)
56px top bar on `console`, 1px `ash`/20% bottom border. Left: OUTPOST wordmark
(Clash Grotesk, tracked out). Nav: Sandboxes / Usage / Settings — `ash` default,
`bonewhite` active (NO beacon on nav; beacon belongs to the screen's one primary
action). Right: usage mini-readout (Plex Mono) + GitHub avatar. Login and the
onboarding overlay are the only shell-less surfaces.

## Rules
- Never hardcode hex in components. Tokens only.
- Beacon is scarce: one amber focus per screen. Usage bars are the exception.
- Navbar/shell is ONE shared component — screens render inside it, never rebuild it.
- Terminal is the hero — chrome stays minimal around it.
- Motion: Framer Motion. 200–400ms, ease-out, opacity+translate. Onboarding may be
  richer (staged reveals, spotlight on layout regions) but must be skippable and
  respect `prefers-reduced-motion`.
- Density: this is a console, not a marketing site. Compact spacing, mono numerals.

## Onboarding flow (first login)
4 steps, spotlight style: (1) what Outpost is, (2) sandbox list + create button,
(3) the terminal + reconnect behavior, (4) account picker + usage bar. Each step =
dimmed UI + amber spotlight + 1–2 short sentences. Skippable, replayable from Settings.
