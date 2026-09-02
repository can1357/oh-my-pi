---
title: orchestrate
description: Magic keyword that switches the agent to a multi-agent orchestration contract — scope the full task, delegate substantial work in parallel, verify each phase.
coverage: A
---

`orchestrate` is a magic keyword that switches the agent to a multi-agent orchestration contract for the turn: scope the full task, delegate substantial independent work in parallel, verify each phase, and continue until the request is complete. It is the prompt-level equivalent of running in an orchestration-shaped session.

Use it for the kind of work where one model call cannot finish the job — migrations with several loosely coupled subsystems, multi-area refactors, research questions that want adversarial coverage. The visible word stays in the user message; the orchestration contract is hidden.

## Example

```text
orchestrate the migration described in docs/plan.md
```

The word `orchestrate` glows in the editor with a cool teal→violet gradient (hue 150..280), visually distinct from `ultrathink`'s rainbow. The gradient is a visual affordance; it does not change behavior.

## What it adds

The hidden instruction is the same orchestration contract that powers multi-agent runs: scope first, fan out, verify, iterate. The keyword only changes the instruction attached to the prompt — the underlying `task` tool and its fan-out behavior are unchanged. See [Subagents](/oh-my-pi/features/subagents/) for the agent types and `task.*` settings that do the actual work.

If the orchestration contract needs deterministic, repeatable subagent workflows rather than free-form delegation, prefer [`workflowz`](/oh-my-pi/features/magic-workflowz/).

The setting `magicKeywords.orchestrate` (default `true`) gates this keyword:

```bash
omp config set magicKeywords.orchestrate false
```

## Matching

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Orchestrate` does not trigger.
- The keyword must be standalone prose. `orchestrate,` matches; `orchestrated`, `orchestrate.ts`, `foo::orchestrate`, and `orchestrate()` do not.
- Fenced code blocks, inline code spans, and HTML/XML sections are ignored.
- The instruction applies only to the turn containing the keyword.
- `orchestrate` and `workflowz` can both fire in one prompt — each adds its own hidden instruction.

See [Magic Keywords](/oh-my-pi/features/magic-keywords/) for the full matching contract and the per-keyword configuration switches.
