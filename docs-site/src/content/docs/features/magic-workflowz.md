---
title: workflowz
description: Magic keyword that prompts the agent to author a deterministic, multi-subagent workflow through the persistent eval kernel's agent/parallel/pipeline/completion helpers.
coverage: A
---

`workflowz` is a magic keyword that asks the agent to build and run a deterministic multi-subagent workflow using the `task` tool. It is intended for broad research, reviews, migrations, and other work that benefits from parallel, repeatable coverage. Replaces the older free-form delegation pattern with one that produces a script-shaped workflow you can re-run.

Use it when you want repeatable, structured parallel coverage — adversarial code reviews, multi-area migrations, comparative research — rather than a single open-ended delegation. The visible word stays in the user message; the workflow contract is hidden.

## Example

```text
workflowz an adversarial review of the authentication changes
```

The word `workflowz` glows in the editor with a warm amber→green gradient (hue 30..150), visually distinct from `ultrathink`'s rainbow and `orchestrate`'s teal→violet. The gradient is a visual affordance; it does not change behavior.

## What it adds

The hidden instruction tells the agent to author a workflow through the `task` schema — agents composed via the `tasks[]` batch, parallel or pipelined, with the results structured for comparison. The keyword only fires when the active tool set includes `task`; otherwise it is silently skipped.

If you want free-form multi-agent delegation instead of a deterministic workflow, prefer [`orchestrate`](/oh-my-pi/features/magic-orchestrate/). See [Subagents](/oh-my-pi/features/subagents/) for the agent types, batching, and `task.*` settings that the workflow is built on.

The setting `magicKeywords.workflow` (default `true`) gates this keyword:

```bash
omp config set magicKeywords.workflow false
```

## Matching

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Workflowz` does not trigger.
- The keyword must be standalone prose. `workflowz,` matches; `workflowzed`, `Workflowz`, and `workflowz.ts` do not.
- Fenced code blocks, inline code spans, and HTML/XML sections are ignored.
- The instruction applies only to the turn containing the keyword.
- The keyword is skipped (no hidden instruction added) when `task` is not in the active tool set.
- `workflowz` and `orchestrate` can both fire in one prompt — each adds its own hidden instruction.

See [Magic Keywords](/oh-my-pi/features/magic-keywords/) for the full matching contract and the per-keyword configuration switches.
