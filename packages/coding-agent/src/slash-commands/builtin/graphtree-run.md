[FRACTAL GRAPHTREE MULTI-AGENT WORKFLOW]
Objective: {{objective}}
Hard Bounds: maxRecursionDepth={{maxRecursionDepth}}, maxConcurrency={{maxConcurrency}}, maxRuntimeMs={{maxRuntimeMs}}, isolationMode={{isolationMode}}
Sentinels: maxRecursionDepth=-1 means unlimited recursion; maxRuntimeMs=0 means no runtime deadline.

Execute a Fractal tree-structured workflow:
1. Plan: Decompose the objective into discrete, parallel task nodes (Plan -> Shard -> Map -> Reduce).
2. Bounds & Recursion: Dynamically recurse only within the configured bounds (Max Recursion Depth: {{maxRecursionDepth}}, Max Concurrency: {{maxConcurrency}}, Max Runtime Ms: {{maxRuntimeMs}}). Apply the sentinel semantics above.
3. Worktrees & Isolation: Configured isolation mode is "{{isolationMode}}". `/graphtree init <name>` creates an explicit isolated worktree; use task isolation for editing lanes only when the configured mode is not "none".
4. Execute: Spawn parallel subagent tasks (using agentic-mapreduce, task, or side-agent primitives).
5. Reduce: Validate outcomes, clean up sub-nodes with `/graphtree prune <name>`, and integrate results into main.
