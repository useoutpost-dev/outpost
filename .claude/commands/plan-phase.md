---
description: Plan a phase. Main thread decides, plan-writer (Sonnet) writes the document.
argument-hint: <phase-number>
---

Plan Phase $ARGUMENTS.

1. Read `.claude/docs/phases/README.md` and the phase stub for Phase $ARGUMENTS.
2. Use `file-scout` to gather current codebase state relevant to this phase.
3. YOU (main thread) decide: exact scope, file paths, task order, agent/model per task, risks.
4. Hand your decisions to `plan-writer` to write `.claude/docs/phases/phase-$ARGUMENTS.md`.
   Do NOT write the plan yourself.
5. Return only: "Plan ready: <path>" + the Done-when list. Wait for human approval.
