---
type: Concept
title: Recent prompt markdown files
description: Session-observed inventory of recently updated markdown prompt files under packages/coding-agent/src/prompts, with the frontmatter-type caveat preserved.
tags: [prompts, coding-agent, okf, inventory]
timestamp: 2026-07-03T00:00:00Z
---

# Recent prompt markdown files

Observed on 2026-07-03 while answering a request to see the most recently updated markdown prompt files.

## Scope and caveat

No markdown files matched a frontmatter filter for `type: prompt` or `type: prompts`.

This inventory therefore records prompt markdown files under:

`packages/coding-agent/src/prompts/**/*.md`

It should not be interpreted as an OKF-style or capability-style `type: prompt` frontmatter inventory.

## Most recent prompt markdown by directory metadata

The prompt directory snapshot showed these as the freshest prompt markdown files or directories of prompt markdown:

| Recency observed | File | Notes |
|---|---|---|
| ~9h | `packages/coding-agent/src/prompts/agents/mr-reducer.md` | Agentic MapReduce reducer prompt. |
| ~10h | `packages/coding-agent/src/prompts/system/btw-user.md` | Ephemeral `btw` side-question wrapper. |
| ~10h | `packages/coding-agent/src/prompts/agents/tot-reasoner.md` | Tree-of-Thoughts reasoner prompt. |
| ~10h | `packages/coding-agent/src/prompts/agents/mr-worker.md` | Agentic MapReduce worker prompt. |
| ~23h | `packages/coding-agent/src/prompts/system/system-prompt.md` | Main coding-agent system prompt. |
| ~23h | `packages/coding-agent/src/prompts/system/custom-system-prompt.md` | Custom system prompt wrapper. |
| ~1d | `packages/coding-agent/src/prompts/tools/task.md` | Task tool prompt. |
| ~1d | `packages/coding-agent/src/prompts/fusion/sidekick-bootstrap.md` | Fusion sidekick bootstrap prompt. |
| ~1d | `packages/coding-agent/src/prompts/fusion/route-classifier-pool.md` | Fusion classifier pool prompt. |
| ~1d | `packages/coding-agent/src/prompts/fusion/route-classifier.md` | Fusion route classifier prompt. |

## Root-level prompt files also surfaced

A prompt-specific filename lookup also surfaced these root-level prompt markdown files. Directory metadata showed them as older, roughly two weeks old, but they are included because they appeared first in that lookup output:

- `packages/coding-agent/src/prompts/review-custom-request.md`
- `packages/coding-agent/src/prompts/review-headless-request.md`
- `packages/coding-agent/src/prompts/review-request.md`
- `packages/coding-agent/src/prompts/ci-green-request.md`
- `packages/coding-agent/src/prompts/dry-balance-bench.md`
- `packages/coding-agent/src/prompts/bench.md`

## Files opened during the investigation

The following files were read directly to inspect frontmatter and content shape:

- `packages/coding-agent/src/prompts/agents/mr-reducer.md`
- `packages/coding-agent/src/prompts/system/btw-user.md`
- `packages/coding-agent/src/prompts/agents/tot-reasoner.md`
- `packages/coding-agent/src/prompts/agents/mr-worker.md`
