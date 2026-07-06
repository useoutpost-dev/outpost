---
description: Full security + compliance audit of current diff or a named module.
argument-hint: [module-path]
---

Run `security-auditor` on $ARGUMENTS (default: `git diff main`).
If any BLOCK finding: delegate the fix (refactorer for small, implementer for structural),
then re-run the audit. Merge is forbidden until CLEAR.
