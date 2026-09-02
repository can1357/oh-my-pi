---
title: Vibe Mode
description: Turn the session into a director that spawns persistent fast/good worker sessions and verifies their work.
coverage: A
---

Vibe mode turns the session into a **director** that drives persistent background worker sessions instead of editing code itself. The director's own toolset is stripped down to `read`, an optional parent-owned `todo`, and five worker-control tools; the workers do the grepping, editing, running, and building, and the director verifies their work by reading the files they touch.

## Enabling and disabling

Toggle it with `/vibe`:

```text
/vibe                 # enter vibe mode
/vibe fix the flaky test in packages/tui   # enter and submit a first directive
/vibe                 # run again to exit
```

- Entering installs the vibe tools, reduces the active toolset to `read`, optional parent-owned `todo`, and the vibe tools, and injects the director instructions for the turn.
- An inline prompt (`/vibe <prompt>`) enters the mode and submits that prompt as the first directive.
- Exiting restores the previous toolset and **kills every worker session** — a worker never outlives the mode that directs it.
- Vibe mode is mutually exclusive with plan mode and goal mode; exit those first. The status line shows a `Vibe` indicator while it is on.

## Worker tiers

Every worker is a full coding agent with the normal tool surface. Choose a tier at spawn time:

| Tier   | Backing agent | Model role | Use for |
| --- | --- | --- | --- |
| `fast` | `sonic` | `@smol` (low-latency role) | Mechanical execution, drafts, high-volume work |
| `good` | `task`  | `@task` (the session's strong model) | Design, judgment calls, reviewing `fast` output |

Model resolution follows the same path as a `task` spawn, so `task.agentModelOverrides` and your model-role settings apply. See [Model Roles](/oh-my-pi/models/model-roles/).

## Worker-control tools

| Tool | Purpose |
| --- | --- |
| `vibe_spawn` | Start a worker (`fast` or `good`) with a self-contained brief. Workers start blank — they never see the director's conversation. |
| `vibe_send`  | Send a follow-up turn to a worker: a correction, the next step, or a review request. |
| `vibe_wait`  | Block until a worker settles its next turn. Spawns and sends return immediately; call `vibe_wait` only when you cannot proceed without the result. |
| `vibe_kill`  | Tear down a worker that is stuck or whose workstream is done. |
| `vibe_list`  | List the active worker roster when you lose track of it. |

A spawn or send returns immediately; the worker's turn result lands back in the director's conversation on its own, exactly like an async `task` result. Running one `fast` and one `good` worker on different workstreams concurrently is the normal shape.

## Workflow

1. Split the request into independent workstreams — one worker session per workstream so each builds useful local context.
2. `vibe_spawn` with a self-contained brief: files, constraints, acceptance criteria.
3. Keep directing other workers while turns are in flight; `vibe_wait` only when blocked.
4. When a turn result arrives, `read` the touched files to verify claims before building on them. When the optional parent-owned `todo` tool is available, reconcile verified work through it, then `vibe_send` the next step.
5. Route by difficulty: draft with `fast`, escalate to `good` when `fast` stalls or the problem needs judgment.
6. `vibe_kill` finished or stuck workers; `vibe_list` to recover the roster.

:::caution
You stay responsible for the final outcome — verify with `read`, never take a worker's word for it.
:::
