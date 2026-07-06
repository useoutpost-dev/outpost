---
name: credential-layer
description: How Claude accounts, subscriptions, and API keys are stored and mounted into sandboxes. Read before touching auth modes, sandbox creation, or account picker.
---

# Credential Layer

## Two layers per sandbox
- **Identity layer** — Claude credentials. Mounted INTO the sandbox at create time.
- **Profile layer** — settings.json, CLAUDE.md, MCP config. Per-profile volume.

Never mount the whole `~/.claude` shared. Mount ONLY the credential file into an
otherwise per-sandbox `~/.claude` (session data must stay per-sandbox, or usage
attribution and transcripts bleed between sandboxes).

## Account model
`accounts` table: id, label, kind (subscription | api_key), created_at.
- subscription: points at a named credential volume. Login happens once inside any
  sandbox using that account; the volume persists it.
- api_key: encrypted at rest (libsodium sealed box, key from server env), injected as
  `ANTHROPIC_API_KEY` env var at sandbox create. Never written to sandbox disk.

## Sandbox create flow (account picker)
User picks: existing account | new subscription account (fresh volume, login on first
open) | new API key. Store choice on the sandbox row. Multiple subscription accounts =
multiple credential volumes. Sharing one account across sandboxes = same volume mounted
in each (single source of truth; avoids refresh-token drift).

## Rules
- Only `apps/server/src/credentials/` reads/writes credential material.
- Credential paths and file formats via `claude-adapters/credentials.ts` ONLY.
- Log account labels, never contents. Telemetry must never see keys.
- Known risk: several sandboxes sharing a volume can race on token refresh. Rare.
  First suspect on intermittent auth failures. Test: 5 sandboxes, 1 volume, overnight.
