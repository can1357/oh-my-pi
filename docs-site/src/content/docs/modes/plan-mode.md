---
title: Plan Mode
description: Toggle a planning phase where the agent proposes a structured plan before any execution; review and approve, reject, or refine before tools run.
coverage: A
---

Plan mode puts a structured planning phase in front of execution. While it is on, the agent reads and inspects the workspace but cannot run modifying tools until the plan is approved. Approval dispatches the plan into a fresh session and carries the plan title forward into the new session's name when the prior session had none.

Plan mode is mutually exclusive with vibe mode and goal mode — exit those first.

## Entering and exiting

Toggle with `/plan`:

```text
/plan                       # enter plan mode
/plan migrate the auth flow # enter and submit the prompt as the first user message
/plan                       # run again to exit
```

- An inline prompt (`/plan <prompt>`) enters the mode and submits that prompt as the first user message under the plan.
- Exiting clears the active plan. While in plan mode, the status line shows a `Plan` indicator.

## What changes while plan mode is on

- The agent's toolset is reduced to read-only tools (and `ask` for clarifications). Modifying tools — `write`, `edit`, `bash`, `task`, etc. — are unavailable until the plan is approved.
- The agent produces a structured plan with a title, ordered steps, files to touch, and acceptance criteria. Plans are rendered in a dedicated review overlay (`plan-review-overlay`) with a clickable table of contents.
- You can ask the agent to refine the plan in-place before approving; the plan persists across user turns inside the same session.

## Review and approval

While a plan is on screen, three paths:

- **Approve** — Dispatches the plan into a fresh session. The new session's name is seeded from the humanized plan title when the prior session had none (`humanizePlanTitle`: `migrate-mcp-loader` → `Migrate mcp loader`). User-named sessions are not overwritten.
- **Reject** — Drops the plan; you can keep iterating or exit the mode.
- **Reopen review** — Use `/plan-review` to re-open the plan review overlay after dismissing it without approving. Only works while plan mode is still on and a plan is still active.

Approval may also compact the existing session before dispatch when the plan's effective context warrants it; explicit cancellation of approval-time compaction keeps the plan reference and lets the next operator turn continue from the preserved context.

## See also

- [Vibe Mode](/oh-my-pi/features/vibe-mode/) — director / persistent worker sessions
- [Goal Mode](/oh-my-pi/modes/goal-mode/) — persistent autonomous objective
- [Loop Mode](/oh-my-pi/modes/loop-mode/) — re-submit the next prompt after every yield
- [Slash Commands](/oh-my-pi/reference/slash-commands/) — every built-in `/command` and its arguments
