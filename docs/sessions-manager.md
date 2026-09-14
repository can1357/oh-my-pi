# /sessions

> A query and control surface for session history: list, open, archive, pause, kill, and inspect sessions, plus per-session workspace-checkpoint counts. Keyboard-driven fullscreen overlay in the TUI; a top-20 text table in text/ACP mode.

This manager is read-mostly across processes. Only the session currently running in **this** process is "live" — its agent/pause/model state is knowable here. Every other session is a persisted file on disk, so non-live metrics are best-effort and control is limited to persisted-file actions (archive, delete). See [workspace-checkpoints.md](./workspace-checkpoints.md) for the checkpoint/rollback feature the details pane links into.

## Source

- Query/control layer: `packages/coding-agent/src/session/session-control.ts` — `enumerateSessions`, `setArchived`, `isArchived`, `clearSessionMetricsCache`, `SessionRow`.
- Base listing: `packages/coding-agent/src/session/session-listing.ts` — `SessionInfo`, `SessionStatus`.
- TUI overlay: `packages/coding-agent/src/modes/components/sessions-manager.ts` (`SessionsManagerComponent`).
- Command spec: `packages/coding-agent/src/slash-commands/builtin-workspace.ts` (`/sessions`).
- Rename subcommand: `packages/coding-agent/src/slash-commands/builtin-session.ts` (`/session rename`).
- Metrics source: `packages/stats/src/db.ts` — `getSessionSummaries` (see [stats reuse](#stats-db-reuse)).

## What it does

`enumerateSessions` merges the persisted session listing (`listAllSessions`/`listSessions`) with in-process truth and best-effort metrics:

- **persisted truth** — `SessionInfo` from disk: `path`, `id`, `cwd`, `title?`, `created`, `modified`, `messageCount`, `size`, `status?`.
- **in-process truth** (current session only) — live agent counts and pause state from the process-global `AgentRegistry`/`agentPauseGate`; model and profile from the running `AgentSession`/`settings.getActiveProfile()`.
- **best-effort metrics** — cost/token totals from the omp-stats DB and git branch/dirty state at `info.cwd`. These are cached in-module keyed by `path@mtime`; `clearSessionMetricsCache` forces a refresh (e.g. on the `R` key).

## States

A session row carries several orthogonal state signals. They are not mutually exclusive flags — `archived` and `isCurrent` can both be false for an ordinary other-process session that still has a lifecycle `status`.

| Signal | Meaning | Source |
| --- | --- | --- |
| `isCurrent` | The session this process is running. | `sessionManager.getSessionFile()` compared against `info.path`. |
| `liveState` | `streaming` / `idle` / `paused` for the **current** session. Derived from `agentPauseGate.paused` (`paused`) and whether any registry agent is `running` (`streaming`) else `idle`. Undefined for all other sessions. | `agentPauseGate` + `AgentRegistry.global()`. |
| `archived` | An archive sentinel sidecar (`<sessionFile>.archived`) exists. | `isArchived`. |
| `status` | Coarse lifecycle status of the last persisted message: `complete` / `interrupted` / `aborted` / `error` / `pending` / `unknown`. Present for any session; `undefined` for synthesized stubs. | `SessionInfo.status`. |
| `agentCounts` | `running`/`idle`/`parked` subagent tallies for the current session (this process only). | `AgentRegistry.global()`. |

`parked` appears here as a subagent count, not a session-level status: a session is "live" (streaming/idle) whenever this process has agents, and `parked` agents are part of `agentCounts.parked`.

## Archive, kill, delete semantics

These are three distinct operations. Killing never deletes history, and deleting is never silent.

- **Archive** (`A`): writes or removes the sidecar sentinel `<sessionFile>.archived`. The sentinel is an empty marker file — the JSONL is never mutated — so archiving is cross-process safe and fully reversible (re-pressing `A` un-archives and restores everything). Archive state is used only by the `current`/`active`/`archived` filters; it does not change the session's on-disk data.
- **Kill** (`K`, current session only): tombstone-releases this process's own running subagents (`AgentRegistry`/`AgentLifecycleManager.release(id, expected, { tombstone: true })`, excluding the main agent). It does **not** delete or interrupt the parent session's history; it only releases spawned subagents. Disabled for non-current sessions (shown as unavailable).
- **Delete** (`K` on a non-current session): removes the persisted session via `sessionManager.dropSession`, gated behind a **two-step confirmation** (first `K` arms, second `K`/`y`/`enter` executes; `n`/`Esc` cancels). Delete is a separate action from kill and is always explicitly confirmed twice — history is never silently dropped.

## Actions (TUI)

| Key | Action |
| --- | --- |
| `j` / `↓`, `k` / `↑` | Move selection. |
| `enter` | Open/resume the selected session (current session: just closes the overlay). |
| `A` | Toggle archive sentinel (reversible). |
| `P` | Pause/resume — current session only (engages/releases `agentPauseGate`); unavailable for others. |
| `K` | Kill current subagents (current) **or** delete session (other; confirmed twice). |
| `D` | Toggle the details pane. |
| `C` | Open the session's checkpoint list — details pane only, read-only. |
| `F` | Cycle filter: `current` → `active` → `paused` → `archived` → `all`. |
| `S` | Cycle sort: `recent` → `created` → `cost` → `agents`. |
| `R` | Refresh (drops the metrics cache and re-enumerates). |
| `Esc` | Close details/confirm; app-interrupt closes the manager. |

In text/ACP mode `/sessions` prints a top-20 table (`*` marks current, lifecycle `status` shown for non-current rows, cost shown when known) and consumes the command.

## Filters and sorts

| Filter | Selects |
| --- | --- |
| `current` | `isCurrent === true`. |
| `active` | `!archived` (everything not archived). |
| `paused` | `liveState === "paused"` (current process only). |
| `archived` | archive sentinel present. |
| `all` | every session (default). |

| Sort | Order |
| --- | --- |
| `recent` | `modified` descending (default). |
| `created` | `created` descending. |
| `cost` | `cost` descending (`undefined` sorts last). |
| `agents` | total agent count (`running+idle+parked`) descending. |

## Rename

`/session rename <name>` calls `sessionManager.setSessionName(name, "user")`, which updates the session **title** (display name) only. The durable session `id` (and thus the session file path) is unchanged — names are never identity. The `/sessions` overlay shows the title-derived display name but keys every action by durable `id`/`path`, never the display name.

## Metrics shown vs. unavailable

No metric is fabricated. Anything not knowable is rendered as `—`.

| Metric | Availability |
| --- | --- |
| `liveState`, `agentCounts` | Current session only (in-process registry/gate). Other sessions: `—`. |
| `model`, `profile` | Current session only (`AgentSession.model`, `settings.getActiveProfile()`). Other sessions: `—`. |
| `cost`, `tokensIn`, `tokensOut` | Best-effort from the omp-stats DB (`getSessionSummaries`), any session. `—` when no rows exist or the DB read times out. |
| `branch`, `dirty` (staged/unstaged/untracked) | Resolved from git at `info.cwd` when cheaply resolvable; `—` outside a repo or on error. |
| Checkpoint count / latest label | Loaded live from the checkpoint service in the **details** pane (`WorkspaceCheckpointService.list`); `—` until loaded or when unsupported. |
| RAM / CPU per session | Not available cross-process — never shown. |

### Cross-process control is out of scope

Only the current session is live in this process. You cannot pause, archive-with-effect, or kill subagents of a session owned by another process through this manager; archive and delete operate on persisted files the other process is not actively driving. `liveState`/`agentCounts`/`model`/`profile` are therefore populated for the current session alone, by design.

## Stats DB reuse

The manager does **not** maintain its own usage store. Per-session cost and token totals come from the shared omp-stats SQLite database via the new `getSessionSummaries()` query in `packages/stats` (`db.ts` + `aggregator.ts`), which groups `messages` by `session_file` (`requests`, `inputTokens`, `outputTokens`, `cacheRead`, `cacheWrite`, `cost`). The coding-agent already depends on `@oh-my-pi/omp-stats`; this query is the same backend the dashboard uses, reused rather than duplicated.

## Details pane

`D` opens a compact view of the selected session: identity (id/path/title), model/profile, agent counts, usage (cost/tokens when known), git runtime (branch/dirty when known), and recovery (checkpoint count + latest label, loaded from the checkpoint service). Pressing `C` there opens a read-only `CheckpointListComponent` scoped to that session — see [workspace-checkpoints.md](./workspace-checkpoints.md).
