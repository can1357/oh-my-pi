# Persistent Project Memory

Task 07 adds a small durable knowledge layer on top of OMP's existing memory/persistence system. It is not a transcript archive and it does not replace `SessionMemory`, the local rollout-memory SQLite store, or other configured memory backends.

## Storage

Project memory is stored under the existing per-project memory root returned by `getMemoryRoot(agentDir, cwd)` as `project-memory.json`. The file is versioned, human-readable JSON and is bounded to 128 entries by default, with a 32-entry per-category limit and a 1600-character content cap. Writes use a same-directory temporary file followed by rename so a partial write does not become the active document.

## Categories and scopes

Categories are intentionally small:

- `ARCHITECTURE`
- `CONVENTION`
- `DECISION`
- `ENVIRONMENT`
- `KNOWN_FAILURE`
- `WORKFLOW`
- `TOOLING`

Candidates may be `PROJECT`, `WORKSPACE`, `SUBSYSTEM`, or `SESSION`. Session scope is always rejected for persistent storage.

## Trust

Memory trust is explicit: `UNVERIFIED`, `OBSERVED`, `VERIFIED`, `CONFIRMED`. Normal model-facing retrieval only uses `VERIFIED` and `CONFIRMED` memory. Repeated identical `OBSERVED` evidence promotes the item to `VERIFIED`.

## Filtering

The deterministic filter rejects empty, temporary/session-local, speculative, obvious, non-durable, or sensitive content. Secret patterns include common API-key/token/private-key and bearer-header shapes. Stored memory is content-only; raw transcripts, credentials, and raw provider payloads are never persisted.

## Deduplication and contradictions

Facts are normalized into canonical keys. Common project-fact families such as test framework, database, tooling preferences, and explicit never-edit instructions also receive contradiction keys. An equal fact increments evidence instead of creating another row. A newer `VERIFIED` or `CONFIRMED` fact invalidates older conflicting rows in the same contradiction family.

Invalid rows remain inspectable for history but are never returned by normal retrieval.

## Repository state

Each item carries a repository fingerprint derived from the absolute project root and current verified Git `HEAD`. Architecture/convention/decision items can age across commits, while environment/tooling/workflow memory becomes stale when the repository fingerprint changes. Current Repository Intelligence facts are authoritative and are re-applied as verified facts by the runtime.

## Retrieval

Retrieval is lexical and indexed by normalized metadata/content; there is no vector database and no maintenance LLM call. The runtime performs at most one disk load per task and caches the selected memory message for subsequent model calls in that task.

The amount of memory is capped by `PI_PROJECT_MEMORY_BUDGET_TOKENS` and further constrained by Task 06's current model-aware strategy budget. Simple tasks skip memory retrieval by default unless `PI_PROJECT_MEMORY_ALWAYS=1`.

The model-facing format is intentionally compact:

```text
[Project Memory]
ARCHITECTURE:
- API uses service-layer pattern. [verified]
TOOLING:
- Tests use Vitest. [verified]
```

The message is inserted through the existing `Agent.addBeforeModelCall()` context path and is not persisted into the session transcript.

## Learning points

The runtime considers only a few durable sources after a meaningful task:

- explicit user project instructions → `CONFIRMED` convention
- current Repository Intelligence tooling facts → `VERIFIED` tooling
- verified multi-step verification workflows → `OBSERVED` workflow; repeated evidence promotes them
- recurring verification failures → `OBSERVED` known failure; repeated evidence promotes them

A single transient observation is not automatically promoted to durable truth.

## Task integration

**Task 01 — Router:** memory does not arbitrarily increase complexity. It is retained as supporting evidence only.

**Task 02 — Context Intelligence:** the selected memory is injected before the existing context-ranking hook, so memory is treated as another candidate source and uses the existing context/token budget logic.

**Task 03 — Verification/Recovery:** verified failure state and completed verification plans are candidate sources. Deterministic verification remains authoritative.

**Task 04 — Repository Intelligence:** current repository facts win. Tooling facts discovered from the repository are re-applied as verified memory and conflicting stale tooling facts are invalidated.

**Task 06 — Model Strategy:** the memory budget is bounded by the model-aware strategy budget rather than using model-specific memory behavior.

## Debugging / inspection

Use the exported `ProjectMemoryStore.inspect()` and `list()` APIs with `projectMemoryFilePath(getAgentDir(), cwd)` to inspect the exact persisted knowledge and freshness state. Runtime counters are exposed through `getProjectMemoryTelemetry(agent)` / `getMemoryTelemetry(agent)`.

## Failure tolerance

Missing, corrupt, or unavailable memory never blocks an agent task. The runtime marks `degraded` telemetry and continues through the normal session/repository/context/tool path. A corrupt JSON file is treated as empty on read; the next successful write replaces it with a valid document.

## Controls

```text
PI_PROJECT_MEMORY=0
PI_PROJECT_MEMORY_ALWAYS=1
PI_PROJECT_MEMORY_BUDGET_TOKENS=1200
PI_PROJECT_MEMORY_RETRIEVAL_LIMIT=5
PI_PROJECT_MEMORY_MAX_ITEMS=128
PI_PROJECT_MEMORY_MAX_CATEGORY_ITEMS=32
PI_PROJECT_MEMORY_MAX_CONTENT_CHARS=1600
```

## Benchmark

`project-memory.bench.ts` measures storage and lookup latency against a bounded synthetic knowledge base. It intentionally reports raw timings rather than claiming product-level savings. A future experiment can compare the same task corpus with the runtime disabled/enabled and measure rediscovery/tool calls and context tokens.
