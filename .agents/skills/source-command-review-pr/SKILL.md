---
name: "source-command-review-pr"
description: "Review the current diff before merge."
---

# source-command-review-pr

Use this skill when the user asks to run the migrated source command `review-pr`.

## Command Template

Review `git diff main` (use `file-scout` for context on touched modules).

Check against the AGENTS.md quality bar + architecture boundaries (open-core seam,
credentials module, adapters). Output: BLOCK/WARN/NOTE findings with file:line, then a
merge verdict in one line. Delegate fixes to `refactorer`.
