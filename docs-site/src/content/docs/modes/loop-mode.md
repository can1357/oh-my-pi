---
title: Loop Mode
description: Re-submit the next prompt (or a fixed prompt) after every yield until a count, duration, or Esc cancels it.
coverage: A
---

Loop mode re-submits your prompt automatically after every agent yield. It is the simplest of the persistent modes — no plan to approve, no objective to drive toward, just the same prompt replaying across turns until you stop it. Useful for iterative review passes ("check for any new lint warnings"), scheduled sweeps ("refresh the dependency graph every few minutes"), or bounded refactor passes ("run the migration ten more times").

Loop mode is independent of plan, vibe, and goal mode. It can run on top of any of them as long as the mode it sits on top of permits re-entry.

## Entering and exiting

Toggle with `/loop`:

```text
/loop                                      # on — waiting for your next prompt to start repeating
/loop rerun the failing migration once     # on — a fixed prompt re-submitted after every yield
/loop 10                                    # on — limit to 10 iterations then auto-exit
/loop 30m                                   # on — limit to 30 wall-clock minutes then auto-exit
/loop 10 rerun the migration                # on — fixed prompt + count limit
/loop                                       # off
```

Esc cancels the current iteration; the loop stays on until you `/loop` again or the limit fires. The status line shows `Loop: on (repeating prompt)`, `Loop: on (waiting for next prompt)`, or `Loop: paused` depending on state.

## Limits

Two optional limits can be combined. Both default to "no limit" (loop runs forever until you toggle off or Esc):

- **Count** — integer iterations (`/loop 10`). The loop auto-disables after that many iterations.
- **Duration** — wall-clock duration with `s`/`m`/`h` suffixes (`/loop 30m`, `/loop 2h`). The loop auto-disables after that much real time has passed.

Count and duration are independent — passing both means whichever hits first wins.

## State

| Status | Meaning |
| --- | --- |
| `Loop: off` | Not in loop mode. |
| `Loop: on (waiting for next prompt)` | Loop is on but no prompt has been submitted yet — the next prompt you send becomes the repeating one. |
| `Loop: on (repeating prompt)` | A fixed prompt is repeating after every yield. |
| `Loop: on (<count>/<max>)` | Count limit is active; `N/max` iterations have run. |
| `Loop: on (ends in <time>)` | Duration limit is active. |
| `Loop: paused` | Paused (Esc during an iteration). `/loop` to resume. |

## See also

- [Plan Mode](/oh-my-pi/modes/plan-mode/) — single pre-execution review
- [Goal Mode](/oh-my-pi/modes/goal-mode/) — persistent autonomous objective
- [Vibe Mode](/oh-my-pi/features/vibe-mode/) — director / persistent worker sessions
- [Slash Commands](/oh-my-pi/reference/slash-commands/) — every built-in `/command` and its arguments
