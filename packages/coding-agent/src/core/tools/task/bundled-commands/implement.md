---
description: Full implementation workflow - explore gathers context, planner creates plan, task implements
---

Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "explore" agent to find all code relevant to: $@
2. Then, use the "planner" agent to create an implementation plan for "$@" using the context from the previous step (use {previous} placeholder)
3. Finally, use the "task" agent to implement the plan from the previous step (use {previous} placeholder)

Execute this as a chain, passing output between steps via {previous}.
