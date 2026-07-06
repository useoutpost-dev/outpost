---
description: Execute an approved phase plan with routed subagents.
argument-hint: <phase-number>
---

Implement Phase $ARGUMENTS from `.claude/docs/phases/phase-$ARGUMENTS.md`.

1. Confirm the plan exists and is approved. If not, stop.
2. Execute tasks in plan order. Route per CLAUDE.md model table. Max 3 agents in parallel;
   only parallelize tasks the plan marks independent.
3. After each task: `test-runner`. On fail: one retry via the same agent, then fix it yourself.
4. Reject work that violates the CLAUDE.md quality bar. Max 2 respawns per task.
5. If the phase touches auth/credentials/proxy/Docker/telemetry: run `security-auditor` at the end.
6. Final output: checklist of deliverables done/blocked. Nothing else.
