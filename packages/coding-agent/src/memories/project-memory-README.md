# Project memory inspection

Project memory is stored beside the existing per-project memory artifacts as `project-memory.json`.

For development/debugging, use `ProjectMemoryStore.list()` for raw structured items, `ProjectMemoryStore.inspect(currentFingerprint)` for freshness state, and `ProjectMemoryStore.query(task, currentFingerprint)` to inspect what a future task would receive. Runtime counters are exposed by `getProjectMemoryTelemetry(agent)`.

The normal model context only renders trusted retrieved facts. Session-local work, raw transcripts, secrets, and invalidated facts are not returned by normal retrieval.
