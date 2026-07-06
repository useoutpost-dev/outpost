---
name: field-console-design
description: Field Console visual identity — tokens, typography, motion rules. Read before any UI work or Claude Design handoff.
---

# Field Console

## Tokens (Tailwind theme names)
- `basalt`  #14181B — app background
- `console` #1E252A — panels, cards, terminal chrome
- `bonewhite` #E9E5DC — primary text
- `ash`     #8B939B — secondary text, borders
- `beacon`  #F2A93B — accent: active states, usage bars, CTAs, cursor

## Typography
- Display/headings: Clash Grotesk
- Body/UI: Inter
- Terminal + telemetry numbers: JetBrains Mono

## Rules
- Never hardcode hex in components. Tokens only.
- Beacon is scarce: one amber focus per screen. Usage bars are the exception.
- Terminal is the hero — chrome stays minimal around it.
- Motion: Framer Motion. 200–400ms, ease-out, opacity+translate. Onboarding may be
  richer (staged reveals, spotlight on layout regions) but must be skippable and
  respect `prefers-reduced-motion`.
- Density: this is a console, not a marketing site. Compact spacing, mono numerals.

## Onboarding flow (first login)
4 steps, spotlight style: (1) what Outpost is, (2) sandbox list + create button,
(3) the terminal + reconnect behavior, (4) account picker + usage bar. Each step =
dimmed UI + amber spotlight + 1–2 short sentences. Skippable, replayable from Settings.
