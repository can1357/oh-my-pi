# Context Intelligence Engine

## Integration audit

The engine is attached to the existing `Agent` lifecycle, not a second context system.

```text
user task
  -> Task Router classification
  -> existing Agent.prompt()
  -> existing loop assembles AgentContext
  -> syncContextBeforeModelCall
  -> Context Intelligence ranking/projection
  -> existing convertToLlm()
  -> existing append-only/provider normalization
  -> model
```

The current agent already exposes `transformContext` and `syncContextBeforeModelCall`, while the loop supports independently removable `addBeforeModelCall` hooks. Context Intelligence uses the latter so the persisted session history and existing compaction/pruning remain authoritative.

The repository's existing append-only manager also detects in-place message rewrites with message versioning. Context Intelligence therefore never mutates persisted messages; it creates a shallow per-call projection and only replaces tool-result content in that projection.

## Candidate model

Candidates are derived from the messages already present in the live context. The engine records:

- source and optional location
- candidate type
- direct relevance
- semantic task relation
- confidence
- freshness
- dependency distance
- estimated token cost
- final priority
- stale/duplicate state

Candidate types include files, tests, diagnostics, tool results, configuration, previous failures, architectural decisions, and generic messages.

## Ranking

Ranking is deterministic and cheap. Strong signals are:

1. exact file/path references from the task
2. symbol references from the task
3. task-term overlap with path/content
4. failures and diagnostics
5. test-related material
6. recent active context
7. dependency proximity
8. lower token cost when value is otherwise similar

No LLM call is used to select context.

## Budgeting

The configured budget applies to managed historical tool-result content. The engine compacts low-value historical tool results into bounded text instead of deleting tool calls/results, so provider-side call/result pairing is preserved.

`PI_CONTEXT_BUDGET` can override the derived budget. Otherwise the budget is derived from the active Task Router complexity and, when available, the model context window.

## Deduplication and staleness

Repeated unchanged reads are compacted to a small placeholder in the model-visible projection. When the same location has changed content, the older candidate is marked stale and the newer candidate remains authoritative.

This is per-call and non-destructive: the original session messages are not rewritten.

## Debugging preservation

Failures are explicitly boosted. When budget pressure requires compaction, failure tool results are compressed rather than discarded and the error text is retained.

## Telemetry

The engine records candidate count, selected candidates, estimated managed tokens before/after, configured budget, duplicate count, stale count, discarded/compacted candidates, top-ranked sources, assembly latency, and whether the managed budget was respected.

The telemetry is exposed through `getContextIntelligence(agent)` and stored on the existing agent state for the lifetime of the latest route.

## Configuration

- `PI_TASK_ROUTER=0` disables Task Router and Context Intelligence runtime integration.
- `PI_CONTEXT_INTELLIGENCE=0` disables only Context Intelligence.
- `PI_CONTEXT_BUDGET=<tokens>` sets an explicit managed tool-result budget.
- `PI_CONTEXT_RECENT_MESSAGES=<count>` changes the protected recent-message window.

These controls are deliberately environment-based in the first implementation so no new settings schema is required before benchmark data establishes useful defaults.
