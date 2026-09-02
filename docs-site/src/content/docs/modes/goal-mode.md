---
title: Goal Mode
description: A persistent autonomous objective that the agent works toward across turns; pause, resume, budget, or drop it from goal mode subcommands.
coverage: A
---

Goal mode turns the session into a persistent autonomous objective. The agent receives hidden prompts each turn that nudge it toward a declared goal, tracks its own progress against the goal, and runs until the goal is met, paused, or dropped. Unlike plan mode (a single pre-execution review), goal mode is ongoing across many turns; unlike loop mode (re-submit the same prompt), goal mode drives a single objective forward.

Goal mode is mutually exclusive with plan mode and vibe mode — exit those first.

## Enabling and disabling

Toggle with `/goal`:

```text
/goal refactor the auth module to use the new claims API
/goal                       # re-run to view status; status flips to "off" only via subcommand
/goal show                  # show current goal details
/goal pause                 # pause the running goal
/goal resume                # resume a paused goal
/goal drop                  # drop the goal entirely
/goal budget 200000         # cap the goal at 200,000 tokens
/goal budget off            # remove the cap
```

`/goal` without arguments toggles display of goal state in the status line; the goal itself is on until you `drop` it or exit the mode. `goal.enabled` in settings must be true (default).

`/guided-goal` is a guided alternative — it has the agent interview you in chat first (rough objective, constraints, acceptance criteria), then sets up the goal mode entry from those answers.

## Subcommands

| Subcommand | Effect |
| --- | --- |
| `set <objective>` | Replace the current goal with a new objective. |
| `show` | Print the current goal, status, token usage, and budget. |
| `pause` | Stop driving toward the goal; the agent's next turn runs without goal-mode steering. |
| `resume` | Resume driving toward a paused goal. |
| `drop` | Tear down the goal entirely. |
| `budget <N\|off>` | Cap the goal's token spend at `N`; `off` removes the cap. |

## What changes while goal mode is on

- A hidden system prompt is injected each turn that re-states the active goal, recent progress, and any budget pressure.
- The agent's toolset is unchanged — goal mode does not reduce capabilities the way plan mode does.
- Token usage is accumulated against the goal's budget. When the budget is exhausted, a `goal-budget-limit` prompt takes over for the remainder; the goal is not auto-dropped unless you drop it.

## Status display

The status line surfaces goal state as `Goal: <status> (<short detail>)`. Status values:

- `active` — driving toward the goal.
- `paused` — paused via `pause`; resume with `resume`.
- `complete` — agent reported the goal is met; `drop` to clear.
- `blocked` — agent reported a blocker it cannot resolve; review and `drop` or `set` a new objective.

## See also

- [Plan Mode](/oh-my-pi/modes/plan-mode/) — single pre-execution review
- [Vibe Mode](/oh-my-pi/features/vibe-mode/) — director / persistent worker sessions
- [Loop Mode](/oh-my-pi/modes/loop-mode/) — re-submit the next prompt after every yield
- [Slash Commands](/oh-my-pi/reference/slash-commands/) — every built-in `/command` and its arguments
