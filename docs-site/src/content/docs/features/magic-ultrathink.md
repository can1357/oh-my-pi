---
title: ultrathink
description: Magic keyword that nudges the model into careful, multi-step reasoning for one turn and pins the highest automatic thinking effort the model supports.
coverage: A
---

`ultrathink` is a magic keyword that adds a hidden instruction to the turn it appears in, asking the agent to reason carefully through a multi-step task. When automatic thinking is active, the keyword also selects the highest reasoning effort the current model supports for that turn.

Use it when a single prompt is load-bearing — design questions, ambiguous bug investigations, plans with downstream effects. The visible word stays in the user message; the instruction is hidden.

## Example

```text
ultrathink about the failure modes before changing this API
```

The word `ultrathink` glows in the editor with a full-spectrum rainbow gradient as you type it, and the same gradient is preserved on the sent message. The gradient is a visual affordance; it does not change behavior.

## What it adds

The hidden instruction nudges the agent toward careful, multi-step reasoning for that turn. If the active model supports automatic thinking and the runtime exposes a reasoning-effort control, the keyword also pins the highest effort supported by the model — equivalent to picking it from the model-cycling chord for one prompt.

The setting `magicKeywords.ultrathink` (default `true`) gates both behaviors. To turn `ultrathink` off while leaving `orchestrate` and `workflowz` on:

```bash
omp config set magicKeywords.ultrathink false
```

## Matching

Matching is deliberate so source code and paths do not accidentally change agent behavior:

- Use the exact lowercase spelling. `Ultrathink` does not trigger.
- The keyword must be standalone prose. `ultrathink,` matches; `ultrathinking`, `ultrathink.ts`, and `ultrathink()` do not.
- Fenced code blocks, inline code spans, and HTML/XML sections are ignored.
- The instruction applies only to the turn containing the keyword.

See [Magic Keywords](/oh-my-pi/features/magic-keywords/) for the full matching contract and the per-keyword configuration switches.
