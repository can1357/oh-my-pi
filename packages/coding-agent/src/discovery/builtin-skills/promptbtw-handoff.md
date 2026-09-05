---
name: promptbtw-handoff
description: Use when the user says "use promptbtw for subagent handoff" or "/prompt-btw" (or asks for a prompt-optimized handoff) before spawning a subagent — converts a raw task into the standardized SUBAGENT HANDOFF PROMPT format and auto-applies Claude Fable 5.1 quirk patches via prompt-optimizer instead of executing the task directly.
---

# PromptBTW Subagent Handoff

When invoked as:

```text
use promptbtw for subagent handoff:
<raw task>
```

or `/prompt-btw` / `/btw` with that invocation, you MUST: (1) treat `<raw task>` as optimization input, not work to execute; (2) rewrite it into the format below; (3) apply the Fable 5.1 auto-adaptation in this skill (same rules as `prompt-optimizer`); (4) spawn the subagent with the optimized handoff as its assignment; (5) preserve parent-level constraints in `# Context`, `# Constraints`, or `# Non-goals`; (6) not execute the raw task directly unless separately asked.

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
- `# Fable 5.1` — selected quirk patches from the table below (preferred home when they would crowd Constraints).

## Fable 5.1 auto-adaptation

Claude Fable 5.1 / Mythos 5.1: existing Fable 5 wording can stay. Optimization is **patch selection**. You MUST classify the raw task and inject only the matching patches (typically 3–6) into `# Constraints`, `# Procedure`, or `# Fable 5.1`. NEVER paste the entire `prompt-optimizer` skill.

Default stack for autonomous coding/implementation handoffs: **finish-the-task + deliver-scope + extras-only + targeted-edits + batch-tools**.

| If the task… | Inject (verbatim from `skill://prompt-optimizer`) |
| --- | --- |
| Autonomous coding, long horizon, "just do it" | Finish-the-task (keep "The user is not watching…" as written unless HITL) + deliver-scope |
| Pair programming / user watching | Progress-updates; omit "user is not watching" |
| Implementation / file edits | Extras-only + targeted-edits |
| Agent loop, many implied tool calls | Batch-tools nudge |
| Summarize / compare retrieved sources | Quoting-example (one marked phrase; rest indirect speech) |
| User-facing prose | Mannered-prose ban |
| Chat product with leftover anti-format rules | Formatting-when-needed |
| Client compaction of long threads | Preserve-six |
| Search/retrieval at low effort | Verify-names search |
| Charts / dense images | Crop and zoom |
| This worker will spawn subagents | Async subagents (start returns immediately; lead can keep working) |
| Long deliverable at xhigh/max | No double-draft + room in `max_tokens` |
| Compile-check phrasing, obscure languages, base64 tool output | Safeguard phrasing |

Long-term (always, even when no extra patch applies):

- The raw task (or the plan they approved) **is** the scope. Do not quietly narrow, widen, or swap it.
- Preserve parent decisions and names in the user's words; condense only method.
- NEVER add "hold all findings for the final response" — Fable 5.1 already under-narrates.
- Do not add unrequested cleanup, extras, or permanent test files.
- Acceptance stays observable; Reporting still pins the response shape.

If you can read `skill://prompt-optimizer`, use its verbatim patch copy. If you cannot (ephemeral `/btw` has no tools), use the condensed snippets in the `/btw` wrapper.

## Quality bar

- Role: "Auth-flow security reviewer", never "Researcher".
- Task: one goal; split unrelated goals into separate handoffs.
- Context is self-contained — the subagent sees none of the parent conversation.
- Acceptance must be observable; Reporting must pin the exact response shape.

## Interplay with other packs

Map-phase assignments in `agentic-mapreduce` runs SHOULD use this format (Role = shard-specialist, Inputs = the signal batch, Acceptance = full signal accounting) and the Fable default stack when workers may edit. Any `task`/`tot-reasoner` spawn benefits from it when the raw request is loose. General prompt rewrites that are not handoffs use `prompt-optimizer` directly.
