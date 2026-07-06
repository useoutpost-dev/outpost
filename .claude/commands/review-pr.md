---
description: Review the current diff before merge.
---

Review `git diff main` (use `file-scout` for context on touched modules).

Check against the CLAUDE.md quality bar + architecture boundaries (open-core seam,
credentials module, adapters). Output: BLOCK/WARN/NOTE findings with file:line, then a
merge verdict in one line. Delegate fixes to `refactorer`.
