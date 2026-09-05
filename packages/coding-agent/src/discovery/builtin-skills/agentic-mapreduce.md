---
name: agentic-mapreduce
description: Use for whole-codebase tasks where the result is only trustworthy if the entire codebase was considered — security scans, breaking-change detection, code-quality enforcement, large-scale migration. Orchestrates Plan, Shard, Map, Reduce over deterministic selectors and parallel subagents.
---

# Agentic MapReduce

For whole-codebase tasks, a single search-driven agent fails three ways: budget goes to finding work instead of doing it, context becomes a shared bottleneck, and "I've looked everywhere" is unfalsifiable. Invert it: spend reasoning once on a **deterministic relevance test**, run it over everything, fan out bounded shards to focused workers, reduce their structured outputs.

**Design principle: agents only where reasoning is required** (authoring selectors, investigating shards, reducing). Everything else is deterministic.

## Stage 1 — Plan (agentic, you)

Study the repo and author **selectors**: relevance tests concrete enough to run with no model in the loop.

| Selector form | Tool |
|---|---|
| Syntax patterns (calls, decorators, route decls) | `ast_grep` |
| Lexical / convention patterns | `search` (regex) |
| File-shape patterns (extensions, layouts) | `find` |
| Symbol/type queries | `lsp` (references, implementations) |
| Import/call-graph traversal | `bash` + repo tooling |

Rules:
- Each selector targets one concept the task cares about (e.g. "deserialization sinks", "callers of the deprecated API"). Name it.
- Test each selector against at least one known-positive example before trusting it. Completeness rests entirely on selector recall — a file no selector matches never gets investigated.
- **Persist selectors** (when the session allows writes) to `.ompk/mapreduce/<task-name>.selectors.md` (name, tool, exact pattern, rationale) so re-runs and reviewers can inspect, test, and tune them. In read-only sessions, include the selector table in your final report instead.

## Stage 2 — Shard (deterministic, no model)

1. Run every selector over the repo. Each match is a **signal**: `{file, line, selector, evidence}`.
2. Drop files with zero signals — they never reach the Map stage.
3. Group signals into **bounded batches**: target 10–20 signals or ≤ ~8 files per batch; keep same-file signals in one batch. Write batches to a scratch file (e.g. `.ompk/mapreduce/<task-name>.batches.json`) when writes are allowed; otherwise inline each batch directly in its worker assignment.

The finite batch queue IS the coverage guarantee: the run is complete when the queue is exhausted, not when an agent feels done.

## Stage 3 — Map (agentic, parallel)

One `mr-worker` per batch, all in ONE `task` call (`tasks[]` array, shared `context`). For editing tasks (migrations), use `task` agents with worktree isolation instead of `mr-worker`.

Format each assignment with the `promptbtw-handoff` skill's SUBAGENT HANDOFF PROMPT structure, applying that skill's Fable 5.1 default stack when workers may edit:

```
# Role
<task-specific specialist, e.g. "Auth-boundary shard investigator">
# Task
Investigate every signal in your shard and return structured findings.
# Context
<the task's threat model / migration goal; selector rationale>
# Inputs
<the batch: file, line, selector, evidence — inline or a scratch-file path>
# Non-goals
No edits. No findings outside your shard's signals.
# Acceptance
Every signal accounted for: cleared or confirmed. signals_assigned == signals_cleared + signals_confirmed.
```

Workers run independently; each starts from a fresh, focused context.

## Stage 4 — Reduce (agentic)

Spawn ONE `mr-reducer` with only the outputs of workers that produced findings (zero-finding workers are ignored — but verify their coverage accounting first). The reducer dedupes, triages P0/P1/P2, and composes **cross-shard chains** no worker could see. Pass worker outputs as compressed structured results (a scratch file when writes are allowed, otherwise inlined) — never re-inlined transcripts.

## Optional Stage 5 — Verify

For serious findings, fan out once more: one sandboxed session per finding attempts to reproduce it against a running build → Confirmed / False Positive / Inconclusive.

## Incremental re-runs

When selectors were persisted, `git diff --name-only <last-scanned-commit>` → re-shard only changed files. You pay for the diff, not the repo. (Without persisted selectors, a re-run repeats the Plan stage first.)

## When NOT to use this

Local tasks (fix a bug, add an endpoint) — a single agent with grep and read is cheaper and faster. Use MapReduce only when the verdict requires whole-codebase coverage. If per-shard reasoning is genuinely hard (multi-step chains), give workers the `tree-of-thoughts` discipline (see that skill) — MapReduce outer loop, ToT inner loop.
