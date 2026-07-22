[FRACTAL GRAPHTREE MULTI-AGENT WORKFLOW]
Objective: {{objective}}

Execute a Fractal tree-structured workflow:
1. Plan: Decompose the objective into discrete, parallel task nodes (Plan -> Shard -> Map -> Reduce).
2. Worktrees: Create isolated worktree nodes for independent modules/subtasks if necessary (`/graphtree init <name>`).
3. Execute: Spawn parallel subagent tasks (using agentic-mapreduce or side-agent primitives).
4. Reduce: Validate outcomes, clean up sub-nodes with `/graphtree prune <name>`, and integrate results into main.
