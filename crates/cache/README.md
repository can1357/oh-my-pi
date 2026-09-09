# omp-cache

`omp-cache` owns rebuildable local caches for converted documents, direct GitHub responses, MCP definitions, AutoQA diagnostics, and the persistent secret-placeholder key.

Session authority is intentionally absent. Durable conversation state lives in `.oms` journals (`omp-journal`) and materializes through `omp-session`; caches may be discarded and rebuilt without changing session truth.
