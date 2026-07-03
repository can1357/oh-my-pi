---
name: promptbtw-handoff
description: Use when the user says "use promptbtw for subagent handoff" (or asks for a prompt-optimized handoff) before spawning a subagent — converts a raw task into the standardized SUBAGENT HANDOFF PROMPT format instead of executing it directly.
---

# PromptBTW Subagent Handoff

When invoked as:

```text
use promptbtw for subagent handoff:
<raw task>
```

you MUST: (1) treat `<raw task>` as optimization input, not work to execute; (2) rewrite it into the format below; (3) spawn the subagent with the optimized handoff as its assignment; (4) preserve parent-level constraints in `# Context`, `# Constraints`, or `# Non-goals`; (5) not execute the raw task directly unless separately asked.

## Required output format

```text
SUBAGENT HANDOFF PROMPT

# Role
<specialist role — name the domain, subsystem, or question lens; never generic>

# Task
<one imperative sentence starting with a verb, stating the deliverable>

# Context
<self-contained facts: parent objective, prior decisions, constraints, known paths/URLs/systems. Never assume parent conversation history is available>

# Scope
<bulleted in-bounds work; exact files, symbols, URLs, or search territories when known>

# Non-goals
<out-of-scope topics, forbidden actions, safety and tool limits, tempting adjacent work>

# Procedure
1. <numbered, actionable steps — inspection before edits for code; source cross-checking for research>

# Acceptance
<testable completion criteria: minimum artifacts, counts, or checks — never "be thorough">

# Reporting
<exact final response shape: Markdown sections, JSON, table, or bullets; citations for research; changed-files + verification + residual risks for implementation>
```

## Optional sections

Add only when they earn their place:

- `# Inputs` — explicit files, URLs, datasets, logs.
- `# Tools` — mandated or forbidden tools.
- `# Coordination` — cross-subagent reporting rules when siblings may overlap.
- `# Constraints` — constraints weighty enough for their own section.

## Quality bar

- Role: "Auth-flow security reviewer", never "Researcher".
- Task: one goal; split unrelated goals into separate handoffs.
- Context is self-contained — the subagent sees none of the parent conversation.
- Acceptance must be observable; Reporting must pin the exact response shape.

## Interplay with other packs

Map-phase assignments in `agentic-mapreduce` runs SHOULD use this format (Role = shard-specialist, Inputs = the signal batch, Acceptance = full signal accounting). Any `task`/`tot-reasoner` spawn benefits from it when the raw request is loose.
