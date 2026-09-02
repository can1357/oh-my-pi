---
title: Multi-Agent Workflows
description: How omp's agent-coordination surfaces — task subagents, hub, vibe workers, the advisor, collab guests, and the swarm extension — combine into multi-agent workflows.
coverage: B
---

A single omp session rarely works alone. The session you drive (the main agent) can fan work out to parallel subagents, coordinate them over the `hub` tool, hand workstreams to persistent vibe workers, have every turn reviewed by the advisor, share the live session with human guests over `/collab`, and run unattended agent pipelines through the swarm extension. This page maps each surface and shows how they combine.

## The cast

| Surface | What it is |
| --- | --- |
| Task subagents | Child agent sessions spawned by the main agent — one per call or a `tasks[]` batch — with optional isolated worktrees and structured output. |
| `hub` | One tool for peer messaging, background-job control, and supervision of long-running processes. |
| Vibe workers | Persistent `fast`/`good` worker sessions directed from a `/vibe` session. |
| Advisor | Optional second model that reviews each primary turn and injects advisory notes. |
| Collab guests | Human viewers or drivers attached to a running session by link. |
| Swarm extension | YAML-declared DAGs of subagents run unattended, in waves. |
| Agent registry | The lifecycle behind all of it: every agent is `running`, `idle`, `parked`, or `aborted`, managed from the Agent Hub. |

### Main agent and subagents

The main agent is the driving session — the one you prompt. It spawns subagents with the `task` tool, either one per call (flat shape) or as a `tasks[]` batch (the `task.batch` setting, default on). A batch call carries a required `context` string — shared background rendered into every spawned subagent's system prompt — plus one item per subagent; each item sets its own `agent` type, `outputSchema`, `schemaMode`, and `isolated` flag. See [Subagents](/oh-my-pi/features/subagents/) for the agent types, discovery, settings, and sharp edges.

A finished subagent does not disappear: it goes `idle` with its session intact, and the only follow-up channel is `hub` messaging (or the Agent Hub) — see [Agent registry lifecycle](#the-agent-registry-lifecycle) below.

### The hub

The `hub` tool is the single agent-coordination surface, in three op families:

| Op family | Ops | Purpose |
| --- | --- | --- |
| Messaging | `send`, `list`, `inbox`, `wait` (with `from`) | Peer-to-peer agent messaging over per-agent mailboxes. |
| Jobs | `jobs`, `wait`, `cancel` | Background-job registry: snapshots, blocking waits, cancellation. |
| Processes | `start`, `ps`, `logs`, `stop`, `restart`, `describe` (plus `send`/`wait` with a `name`) | Supervision of shared long-running processes (dev servers, watchers, REPLs). |

`hub` `send` is fire-and-forget with delivery receipts (`injected` / `woken` / `revived` / `failed`); `await: true` blocks until the recipient replies. `wait` is one blocking primitive that races watched jobs, incoming messages, and the wait window, returning whichever settles first. See [Hub coordination between peers](#hub-coordination-between-peers) for the full picture.

### Vibe workers

Vibe mode turns the session into a director that spawns persistent background worker sessions instead of editing code itself. Workers come in two tiers: `fast` (backed by `sonic`, `@smol` role) for mechanical execution and drafts, and `good` (backed by `task`, `@task` role) for design and judgment. The director drives them with `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, and `vibe_list` — the workers do the grepping, editing, and running, and the director verifies their work by reading the files they touch. Exiting vibe mode kills every worker; a worker never outlives the mode that directs it. Vibe mode is mutually exclusive with plan mode and goal mode. See [Vibe Mode](/oh-my-pi/features/vibe-mode/).

### The advisor

The advisor is an optional second model that watches the session from the side. After each primary turn it reviews the new transcript, inspects the workspace with its own tools, and injects concise advice as `<advisory>` notes with a severity of `nit`, `concern`, or `blocker`. It is a reviewer, not a peer: it cannot approve actions, it is excluded from the `hub` peer roster and broadcast targets, and it cannot be messaged, revived, or killed — the Agent Hub shows it as a read-only `advisor`-kind transcript. See [Advisor](/oh-my-pi/features/advisor/).

### Collab guests

`/collab` shares a running session with other omp instances — or any browser, via the collab-web client — in real time. Guests render the same transcript and can read everything live. The link grants the trust level: a full link (32-byte room key plus 16-byte write token) lets a guest prompt, interrupt with `Esc`, and use the Agent Hub against the host's subagents (live table and progress, chat, kill, revive, transcript viewing); a view-only link (bare key) grants live read access only. Everything that mutates the host session or machine stays host-only. See [Live Collaboration](/oh-my-pi/features/collab/).

### Swarm extension

The swarm extension (`packages/swarm-extension/`) runs agent workflows declared in a single YAML file — pipelines, parallel fan-outs, sequential chains, or any DAG — unattended until completion. Each agent is a full subagent with the normal tool surface; the orchestrator manages lifecycle and ordering, and agents communicate through files in the shared workspace, not by messaging.

```yaml
swarm:
  name: codebase-audit
  workspace: ./workspace
  mode: parallel

  agents:
    security:
      role: security-auditor
      task: |
        Audit src/ for security vulnerabilities.
        Write findings to reports/security.md.
      reports_to:
        - lead

    lead:
      role: engineering-lead
      task: |
        Read all reports in reports/.
        Write a prioritized action plan to output/action_plan.md.
      waits_for:
        - security
```

Top-level fields:

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `name` | yes | — | Pipeline identifier; state lives in `.swarm_<name>/` under the workspace. |
| `workspace` | yes | — | Shared working directory, resolved relative to the YAML file. |
| `mode` | no | `sequential` | `pipeline` (repeat the graph `target_count` times), `parallel` (all agents at once), or `sequential` (one pass in declaration order). |
| `target_count` | no | `1` | Iterations; meaningful only in `pipeline` mode. |
| `model` | no | session default | Default model for agents without a per-agent override. |

Agent fields: `role` (short identifier that becomes the system prompt, required), `task` (full instructions sent as the user prompt, required), `extra_context` (appended to the system prompt), `model` (per-agent override), and the DAG edges `reports_to` / `waits_for`. The orchestrator builds a DAG from those edges and groups agents into waves by topological sort — agents in the same wave run in parallel, waves run in sequence, and cycles are rejected before execution. Model precedence is `agents.<name>.model` → `swarm.model` → session default.

Run it inside the TUI (`/swarm run path/to/swarm.yaml`, `/swarm status <name>`, `/swarm help`) after registering the extension, or standalone with `omp-swarm path/to/swarm.yaml`, which has no timeout and runs until the pipeline finishes. State persists to `.swarm_<name>/` (pipeline state, orchestrator and per-agent logs, session artifacts) while it runs. See `packages/swarm-extension/README.md` for the full YAML reference and pattern library.

### The agent registry lifecycle

Every agent — main session and subagents alike — is registered in a process-global registry keyed by id, with a status:

| Status | Meaning |
| --- | --- |
| `running` | A turn is in flight. |
| `idle` | Live session in memory, awaiting work. Finished subagents land here, not in the trash. |
| `parked` | Session disposed; the agent ref and session file are retained, revivable. |
| `aborted` | Hard-killed — terminal. |

A finished subagent goes `idle`; after `task.agentIdleTtlMs` (default `420_000` ms — 7 minutes; `<= 0` disables) it is `parked` to free memory. Messaging it (`hub` `send`) or reviving it from the Agent Hub brings it back to `idle` — revival is the only resume primitive, and `"Main"` is never parked. Isolated runs end `parked` without a reviver: the workspace is merged and cleaned, so the agent is not revivable, but its transcript stays readable via `history://<id>`.

Kinds: `main` (the driving session), `sub` (task subagents), and `advisor` (a passive review transcript — persisted like a subagent for attribution and observability, but never a peer). The Agent Hub is the interactive surface over the registry: live table and progress, chat, kill, revive, and transcript viewing.

## Choosing a coordination surface

| | Task batch | Vibe workers | Swarm extension | Collab guests |
| --- | --- | --- | --- | --- |
| Purpose | Ad-hoc parallel fan-out from a live session | Persistent workers driven by a director session | Unattended, reproducible DAG pipelines | Human remote viewers/drivers |
| Lifecycle | Background jobs; finished agents `idle` → `parked` after the idle TTL; revived by messaging | Live only while vibe mode is on; exiting kills every worker | Orchestrator starts and stops agents per wave; state persists in `.swarm_<name>/` | Follow the host session; independent of the agent lifecycle |
| Communication | Shared `context` at spawn, structured results, `hub` follow-ups | Director briefs with `vibe_spawn`/`vibe_send`; verification by `read` | Files in the shared workspace (signal, structured-output, and tracking files) | Live transcript plus prompts and interrupts |
| Parallelism | `tasks[]` batch, bounded by `task.maxConcurrency` (default `32`) | One session per workstream, run concurrently | Topologically sorted waves | N/A — humans |
| Best for | Slicing one request into independent units of work | Multi-step workstreams that build context across turns | Iterative and repeatable automation, CI-like pipelines | Live review, oversight, steering help |

The same work often moves between surfaces: a swarm pipeline drafts a report, the main agent picks it up and fans a review batch out with `task`, and a collab guest watches the results stream in.

## Parallel execution semantics

**Task batch parallelism.** A `tasks[]` batch in one call is the primitive for parallel execution inside a session: each item spawns an independent subagent, and the whole batch runs under one session-scoped semaphore sized from `task.maxConcurrency` (default `32`), which also bounds parallel `task` calls against each other. With `async.enabled=true` each spawn registers as a background job and the tool returns immediately; otherwise the call blocks until the batch settles. An item whose agent type declares `blocking: true` runs inline even in a background batch. Results arrive as async-result injections into the parent conversation as each agent finishes.

**Worktree isolation.** An item with `isolated: true` runs in an isolated workspace (a copy-on-write clone, overlay, or worktree — `task.isolation.mode`, default `none`) and returns its changes instead of touching your working tree directly. Results merge back as a patch (`task.isolation.merge: patch`, default) or as commits on an `omp/task/<id>` branch cherry-picked into the parent (`branch`). Isolation requires a git repository.

**Structured output.** Each item can carry an `outputSchema` (JSON Schema) so its result comes back as parsed data instead of free text; `schemaMode` is `permissive` by default or `strict`. Precedence is per-call `outputSchema` → the agent's frontmatter `output` → the parent session schema. Full artifacts stay readable at `agent://<id>` regardless.

## Background jobs

With `async.enabled=true`, every spawn is a background job registered with the session's job manager. The `hub` tool is the control surface:

- `hub` `jobs` — snapshot of running background jobs plus the roster of running subagents with no job entry.
- `hub` `wait` — blocks until a watched job settles or the wait window elapses; results still self-deliver into the conversation either way.
- `hub` `cancel` — kills background jobs by id; an unknown id returns per-id hints pointing at `history://<id>` instead of hanging.

Completed jobs are retained for about five minutes; waiting emits fresh snapshots every 500 ms. A settled result also arrives in the parent conversation as an async-result message with a follow-up hint — `<id> is now idle — message it via hub to follow up` — pointing at `history://<id>` for the transcript.

## Hub coordination between peers

Messaging is plain prose over per-agent mailboxes (capacity 100 messages, oldest dropped beyond that):

- `hub` `send` to an agent id is fire-and-forget with a delivery receipt; `await: true` waits for one reply. Direct sends can revive a parked recipient; broadcasts (`to: "all"`) reach visible live peers without reviving every parked agent.
- `hub` `list` shows the peer roster (idle and parked candidates included); `hub` `inbox` drains queued messages; `hub` `wait` with `from` blocks for the next message from one peer.
- The default reply/wait window is `irc.timeoutMs` (`120_000` ms; `0` disables).

Follow-up messaging is the point of the lifecycle: prefer messaging an existing agent over a fresh spawn — it already holds the relevant context. `history://<id>` shows what an agent has done before you send it anywhere.

## Putting it together: goal mode + task batch + hub + collab

A realistic shape: an autonomous goal, a parallel fan-out, hub-coordinated follow-ups, and a human guest reviewing live.

**1. Declare the goal.** `/goal refactor the checkout flow onto the new payments API` turns the session into a persistent autonomous objective: hidden prompts restate the goal each turn and the agent drives toward it until it is met, paused, or dropped. Unlike vibe mode, goal mode does not reduce the toolset — the agent can still spawn subagents.

**2. Fan out with a task batch.** When the work decomposes, the agent spawns one batch with a shared `context` and per-item contracts:

```json
{
  "context": "Checkout refactor to the new payments API. Spec and conventions in spec.md.",
  "tasks": [
    {
      "name": "ApiLayer",
      "agent": "task",
      "task": "Port api/checkout to the new payments client, keeping the public surface.",
      "isolated": true,
      "outputSchema": { "type": "object", "properties": { "changedFiles": { "type": "array" } } }
    },
    {
      "name": "UiPass",
      "agent": "task",
      "task": "Update the checkout UI to the new client and smoke-test the dev server.",
      "isolated": true
    },
    {
      "name": "ContractCheck",
      "agent": "reviewer",
      "task": "Review the port for contract drift against spec.md.",
      "outputSchema": { "type": "object", "properties": { "findings": { "type": "array" } } }
    }
  ]
}
```

With `async.enabled=true` the tool returns immediately with one job id per spawn; the results land back in the conversation as each agent finishes. The isolated items come back as patches applied to the working tree.

**3. Coordinate with hub.** While the batch runs, the agent uses `hub` `jobs` and `hub` `wait` to track progress without polling. After the batch settles, follow-ups go to the now-`idle` subagents via `hub` `send` — the reviewer's findings feed a correction turn to `ApiLayer`. After the idle TTL they are parked; messaging one revives it.

**4. Bring in a collab guest.** `/collab` prints a full link and a view-only link. The full link goes to a teammate who can watch the streaming session, prompt, interrupt, and use the Agent Hub against the host's subagents — kill a stuck one, revive a parked one, read any transcript. The view-only link goes to a reviewer who only needs to read.

**5. Optional layers.** Enable the advisor (`modelRoles.advisor` plus `advisor.enabled`) and each primary turn gets reviewed by a second model whose `concern` and `blocker` notes steer the session; run the repeatable parts of the pipeline as a swarm YAML when they no longer need the interactive loop. See [Advisor](/oh-my-pi/features/advisor/) and the swarm section above.

:::caution
A `/collab` full link reads **and steers** the session on your machine — share it like a secret.
:::
