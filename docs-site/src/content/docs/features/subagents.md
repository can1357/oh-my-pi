---
title: Subagents
description: Fan work out to parallel subagents with isolated worktrees and typed results.
coverage: B
---

omp can delegate work to subagents: child agent sessions spawned through the `task` tool, each with its own prompt, tool set, and model. Subagents run as background jobs in parallel, report structured results back, and stay around afterwards so you (or the main agent) can message them follow-ups. This page covers the agent types available, how fan-out and isolation behave, and the `task.*` settings you can tune.

## How spawning works

The main agent spawns subagents with the `task` tool, either one per call or as a `tasks[]` batch (the `task.batch` setting, default on). A batch call carries a required `context` string — shared background rendered into every spawned subagent's system prompt — plus one item per subagent:

```json
{
  "context": "Shared background for every spawn in this call.",
  "tasks": [
    { "name": "AuthFlow", "agent": "scout", "task": "Trace the login flow ..." },
    { "name": "FixTests", "task": "Update the failing tests in ...", "isolated": true }
  ]
}
```

Each item takes its own `agent` (type), `effort` (`"lo" | "med" | "hi"`), `outputSchema` + `schemaMode` (`"permissive"` default, or `"strict"`) for typed results, and `isolated` flag — so one call can mix agent types and output contracts. Provided names must be unique within the call; omitted names get a generated AdjectiveNoun id.

Execution mode depends on `async.enabled`:

- With `async.enabled=true`, non-blocking spawns register as background jobs and the tool returns immediately with one job id per spawn. Results are delivered back into the main conversation as each agent finishes.
- With `async.enabled=false`, or when the item's agent type declares `blocking: true` (the bundled `scout` is one), the spawn runs inline and its result comes back in the call itself. A single batch can mix both modes.

A session-scoped semaphore sized from `task.maxConcurrency` (default `32`) bounds how many subagents run concurrently across all parallel calls.

## Bundled agent types

Six agent types ship with omp:

| Agent | Purpose |
| --- | --- |
| `scout` | Read-only investigation: codebase research, pattern searches, compressed handoff notes. Blocking — runs inline. |
| `task` | General-purpose worker with full capabilities; the default when no `agent` is given. |
| `reviewer` | Code review specialist for quality/security analysis. |
| `designer` | UI/UX specialist for design implementation and visual refinement. |
| `librarian` | Researches external libraries/APIs by reading source; returns source-verified answers. |
| `sonic` | Low-reasoning agent for strictly mechanical updates or data collection. |

If no `agent` is specified, the spawn uses the session's default agent (usually `task`).

## Custom agents and discovery

You can define your own agents as Markdown files with frontmatter. Discovery merges four sources, in order:

1. Project `.omp/agents/` (nearest to the working directory)
2. User `~/.omp/agent/agents/`
3. Claude plugin `agents/` directories (project-scope plugins first), when the `claude-plugins` provider is enabled
4. Bundled agents

Deduplication is first-wins by exact `name`: a project agent overrides a user agent with the same name, and any custom agent overrides a bundled one. Matching is case-sensitive. Agent directories from other harnesses (`.claude/agents`, `.codex/agents`, `.gemini/agents`) are intentionally skipped. A file that fails to parse is skipped with a warning — one bad agent file never aborts discovery.

A custom agent file needs `name`, `description`, and a system prompt. Optional frontmatter includes `tools` (CSV or array; `yield` is added automatically), `spawns` (which agents it may itself spawn: `*`, a list, or empty), `model`, `thinkingLevel`, `output` (structured-output schema), `blocking`, `read-summarize: false` (force verbatim `read` output), and `prewalk` (start on the resolved model, hand off to a cheaper model at the first edit).

Example `.omp/agents/db-expert.md`:

```md
---
name: db-expert
description: Answers schema and migration questions against the live database docs.
tools: read, grep, bash
spawns: ""
---

You are a PostgreSQL specialist. Answer only from `db/` and `docs/schema/`.
```

Model selection at runtime resolves as: `task.agentModelOverrides[name]` → the agent's own `model` frontmatter → the parent session model. Output schema precedence is: per-call `outputSchema` → agent frontmatter `output` → the parent session schema.

## Isolated runs and worktrees

An item with `isolated: true` runs in an isolated workspace — a copy-on-write clone, overlay, or worktree of your repo — and returns its changes instead of touching your working tree directly. Isolation requires a git repository.

The backend is chosen by `task.isolation.mode`; `auto` lets the native layer pick the best available option (CoW filesystems first, then overlayfs/ProjFS, then a git worktree or recursive copy). Modes: `none` (default), `auto`, `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy`. If the requested backend is unavailable, omp falls back through the candidate list and reports the fallback.

Results come back via `task.isolation.merge`:

- `patch` (default) — the workspace diff is captured as a patch and applied to your tree.
- `branch` — work is committed to an `omp/task/<id>` branch and cherry-picked into the parent.

Isolated agents are torn down when they finish: their transcript stays readable via `history://<id>`, but they cannot be revived for follow-up messages.

## Following up: hub messaging

Finished subagents are not discarded. A completed agent goes `idle` with its session intact; after `task.agentIdleTtlMs` (default `420_000` ms — 7 minutes; `<= 0` disables) it is `parked`, keeping only its session file. The `hub` tool is the follow-up channel:

- `hub` `send` to an agent id delivers a message; messaging a parked agent revives it — this is the only resume primitive.
- `hub` `list` shows the peer roster; `hub` `inbox` drains queued messages; `hub` `wait` blocks for the next message or job completion; `hub` `jobs` / `cancel` inspect and kill background jobs.
- `agent://<id>` reads a subagent's full output artifact; `history://<id>` renders its transcript. Nested children are dot-qualified (`agent://<id>/<child>`), and `agent://<id>/<path>` / `?q=<query>` extract fields from JSON output.

Messaging is plain prose; per-agent mailboxes hold up to 100 messages (oldest dropped beyond that). The default wait window for messages is `irc.timeoutMs` (default `120_000` ms).

## Settings

All of these live under the `task.*` group in settings:

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `task.batch` | boolean | `true` | Batch shape: one call spawns a `tasks[]` array with shared `context`. |
| `task.maxConcurrency` | number | `32` | Session-wide cap on concurrently running subagents. |
| `task.maxRecursionDepth` | number | `2` | How deep subagents may spawn their own subagents; the `task` tool is removed at the limit. |
| `task.maxRuntimeMs` | number | `0` | Wall-clock limit per spawn (`0` = no limit). |
| `task.softRequestBudget` | number | `200` | Soft request budget applied to every spawn. |
| `task.agentIdleTtlMs` | number | `420_000` | Idle time before a finished subagent is parked; `<= 0` keeps it live until exit. |
| `task.disabledAgents` | array | `[]` | Agent names that cannot be spawned. |
| `task.agentModelOverrides` | record | `{}` | Agent name → model override, beating frontmatter and the session model. |
| `task.prewalk` | boolean | `false` | Arm model hand-off (prewalk) for the generic `task` agent. |
| `task.agentPrewalk` | record | `{}` | Per-agent prewalk overrides (`"on"` / `"off"` / pattern); also toggleable from `/agents` with `P`. |
| `task.isolation.mode` | enum | `none` | Isolation backend for `isolated` spawns (see values above). |
| `task.isolation.merge` | enum | `patch` | How isolated results return: `patch` or `branch`. |

## Sharp edges

- **Unknown or disabled agent** — the spawn fails immediately with `Unknown agent "...". Available: ...`; no subprocess runs. Agents listed in `task.disabledAgents` fail the same way with enabled alternatives listed.
- **Discovery timing** — the agent list is discovered when the session's tools initialize and re-discovered at each spawn, so agents added mid-session become available, but the create-time description may lag.
- **No history inheritance** — child sessions start blank: they get the workspace, skills, the shared `local://` root, and any approved plan, but not the parent conversation. Put everything a subagent needs in its `task` text (or `context` for batches).
- **Spawn policy** — a session's `spawns` policy (`"*"`, `""`, or a CSV allowlist) and the recursion-depth gate can make a discoverable agent unspawnable; denials are immediate errors.
- **Plan mode** — while the parent is in plan mode, spawned agents run read-only (`read`, `search`, `find`, `lsp`, `web_search`) with child spawns cleared.
