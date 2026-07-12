---
name: side-agent
description: Coordinate split-view main-agent and sub-agent workflows using a shared file-based command queue. Works with ANY CLI IDE that can read/write files and invoke skills. One instance assumes the main-agent role (coordinator); N other instances take on sub-agent roles (workers). Use when the user wants to run a side sub-agent in parallel to the main agent, dispatch research or exploration tasks to sub-agents, poll for sub-agent results, or manage multi-agent split-view sessions. Trigger on "run side agent", "launch sub-agent", "main-agent mode", "sub-agent mode", "split view workflow", "coordinate sub-agent", or when setting up agent-to-agent task delegation.
---

# Side-Agent

A file-based multi-agent coordination protocol that works with **any CLI IDE** whose agent can read/write files and invoke skills. No extensions, no IPC, no special APIs — just markdown files on disk.

## Roles

| Role | Count | Responsibility |
|---|---|---|
| **Main agent** | exactly 1 | Decomposes work into tasks, dispatches them to the queue, polls for results, aggregates, and reports to the user. |
| **Sub-agent** | 1–N | Polls the queue for unclaimed tasks, claims one, executes it, writes the result, repeats until told to stop. |

The current agent determines its role at invocation time:

- **`/side-agent`** (no args, or args describing work) → **main agent**. The current agent becomes the coordinator. It creates the coordination directory, decomposes the work, and instructs the user to launch sub-agent instances.
- **`/side-agent join`** → **sub-agent**. The current agent enters the worker loop, polling for tasks from an existing queue.

## Quick start

### Main agent (coordinator)

```
/side-agent research the auth module, review the API surface, and write a migration plan
```

The agent will:
1. Create `.side-agent/` in the workspace root (see [PROTOCOL.md](PROTOCOL.md)).
2. Decompose the work into independent tasks and write them to `queue.md`.
3. Tell the user exactly how many sub-agent instances to launch and give them the command to run in each.
4. Poll for results and aggregate them into a final report.

### Sub-agent (worker)

In a separate terminal, same workspace:

```
/side-agent join
```

The agent will:
1. Read `.side-agent/session.md` to confirm a session is active.
2. Enter a poll loop: scan `queue.md` for unclaimed tasks, claim one atomically, execute it, write the result to `results/<task-id>.md`, repeat.
3. Stop when the queue is empty and the main agent has signaled completion in `session.md`.

## How it works

All coordination happens through files in `.side-agent/`:

```
.side-agent/
  session.md        — session metadata, lifecycle signal, and main-agent heartbeat
  queue.md          — task queue (main writes tasks; statuses edited in place)
  claims/           — atomic per-task claim locks (one dir per claimed task)
    <task-id>/
      claim.md      — claimer ID and ISO-8601 claim timestamp
  workers/          — atomic worker-ID registration (one dir per active worker)
    sub-agent-1/
  results/          — one markdown file per completed task
    <task-id>.md
  log.md            — append-only activity log (both roles write)
```

The protocol is fully specified in [PROTOCOL.md](PROTOCOL.md).

Detailed role instructions:
- **[MAIN-AGENT.md](MAIN-AGENT.md)** — dispatch, poll, aggregate, completion
- **[SUB-AGENT.md](SUB-AGENT.md)** — poll, claim, execute, report, shutdown

## IDE agnosticism

This skill relies only on:
- Reading and writing files (every CLI IDE agent can do this).
- Appending to files (write with append mode, or read-modify-write).
- Creating and removing directories (for the `.side-agent/` tree and the atomic claim locks).
- Invoking skills via slash commands (the skill discovery mechanism).

No extension API, no IPC, no WebSocket, no CLI-specific features. If your IDE's agent can read/write files, create a directory, and follow instructions in a skill, it can participate. The atomic claim depends on directory creation being exclusive — `mkdir` (POSIX) and directory creation (Windows) both fail when the directory already exists, which is what makes the claim race-free.

Tested patterns for common CLI IDEs:
- **oh-my-pi (omp)** — `/side-agent` and `/side-agent join` as slash commands.
- **Claude Code** — `/side-agent` and `/side-agent join` via custom slash commands or by pasting the skill instructions.
- **Cursor / Windsurf / other AI IDEs** — paste the relevant role instructions (main or sub) into the chat; the agent follows the file protocol.
- **Any terminal-based agent** — `cat .omp/skills/side-agent/SKILL.md` to read the protocol, then follow it.

## Task format

Each task in `queue.md` follows this format:

```markdown
### TASK-<id>
- **Description:** <what to do>
- **Scope:** <files, packages, or areas to touch>
- **Deliverable:** <what the result should contain>
- **Constraints:** <any restrictions — read-only, no edits, time-box, etc.>
- **Depends on:** <none, or TASK-XXX whose result this task needs>
- **Status:** pending
- **Claimed by:** (empty until a sub-agent claims it)
```

## Claim mechanism (atomic)

Ownership of a task is established by a single **atomic** filesystem operation — creating the task's claim directory such that the create **fails if the directory already exists**. Exactly one caller wins; concurrent attempts fail. `queue.md` only mirrors the result for human readability — the claim directory is the source of truth.

To claim a task:

1. Read `queue.md`. Find the first task that is `Status: pending` **and** whose dependencies are satisfied (each `results/<dep>.md` exists **and** its `Status:` is `done`/`partial` — a `failed`/missing/malformed dependency is not satisfied).
2. **Atomically create** the directory `.side-agent/claims/TASK-<id>/` so the create fails if it exists: POSIX `mkdir .side-agent/claims/TASK-<id>` (no `-p`); Windows PowerShell `New-Item -ItemType Directory -Path .side-agent\claims\TASK-<id> -ErrorAction Stop`. **Never use cmd.exe `mkdir`** — it returns success on an existing dir on Windows, breaking atomicity.
3. **Creation succeeded** → you own the task. Write `claims/TASK-<id>/claim.md` (your ID + ISO-8601 timestamp), mirror `queue.md` (`pending` → `claimed`, fill `Claimed by:`), log the claim.
4. **Creation failed because it ALREADY EXISTS** (lost race) → back off: skip to the next pending task; if none, wait 5–15 s jitter and rescan. Do not retry the same create in a tight loop.
5. **Creation failed for another reason** (parent `claims/` missing, permissions, path-too-long) → not a race. Log the error, stop, and surface it to the main agent. Do not misclassify it as a lost race or you loop forever.

Before writing the result or releasing the claim, the worker **re-validates** that `claims/TASK-<id>/claim.md` still bears its own ID (see PROTOCOL.md) — a reclaimed task must not clobber the new owner.

**Atomic claim invariant:** for any task, at most one worker holds the claim at a time, because ownership is granted by one atomic create. Two workers can never both believe they own the same task, so two workers can never execute the same task. (POSIX `mkdir` fails with EEXIST and PowerShell `New-Item -ErrorAction Stop` throws — both atomic; cmd.exe `mkdir` is not atomic and must be avoided.)

## Completion

**Per task (sub-agent):** re-validate ownership → write `results/TASK-<id>.md` (write-once) → set `queue.md` `Status: claimed` → `done` (for `done` **or** `partial`) or `failed` → re-validate ownership again → remove your own claim dir. The double re-validation brackets the result write so a reclaimed task can never clobber the new owner's data or lock.

**Session (main agent):** sets `session.md` `Status: complete` once every task has reached a terminal state (`done` or `failed`) and results are aggregated. Sub-agents see `complete`/`aborted` on their next poll and exit.

## Stale-claim recovery (main agent)

A worker that crashes mid-task leaves its claim directory behind with no result. On each poll the main agent **scans the contents of `claims/`** (every claim directory present), reconciled against `queue.md` regardless of Status — not only `Status: claimed` rows (this also catches the orphaned-pending case). It is the **only** role that removes claim directories it does not own, which prevents two agents racing to recover the same task:

1. For each `claims/TASK-<id>/` found:
   - If `results/TASK-<id>.md` exists → the task is done/failed. Ensure `queue.md` matches (do **not** reset a terminal task), and remove the claim dir.
   - Else if the claim dir has no `claim.md` → stale immediately. Remove the claim dir; reset to `pending` only if not already terminal; clear `Claimed by:`; log the reclaim.
   - Else if `claim.md` exists and its timestamp is older than the stale threshold (default **5 minutes**) → stalled/crashed. Remove the claim dir; reset to `pending` only if not already terminal; clear `Claimed by:`; log `Reclaimed stale TASK-<id> (was <claimer>)`.
   - Else (fresh, within threshold) → healthy in-flight; leave it alone.

## Guardrails

- **Main agent does not execute tasks.** It decomposes, dispatches, polls, recovers stale claims, and aggregates.
- **Sub-agents do not talk to the user.** They write results to files only.
- **Sub-agents must not edit files outside their task scope** unless the task explicitly permits it.
- **The claim directory is the source of truth for ownership.** `claims/TASK-<id>/` (not `queue.md`) decides who owns a task.
- **Re-validate ownership before any write or release.** Before writing the result and again before removing the claim dir, the worker confirms `claims/TASK-<id>/claim.md` still names it; if revoked, it aborts silently and touches nothing.
- **Only the owner removes its own claim directory** (on `done`/`failed`); otherwise only the main agent removes claim directories, during stale recovery. A worker never removes a claim it does not own.
- **Worker IDs come from atomic `workers/` dirs**, never from counting `log.md`.
- **Use a portable atomic create.** POSIX `mkdir` or PowerShell `New-Item -ErrorAction Stop`; never cmd.exe `mkdir` (it does not fail on exists). Classify create failures: already-exists = lost race (back off); anything else = error (stop, surface).
- **Dependencies need a satisfied result.** A dependency is satisfied only when its result exists with `Status:` `done`/`partial`; `failed`/missing/malformed = not satisfied. The main agent validates the dependency graph is a DAG (no cycles/self-loops/dangling) before dispatch.
- **The queue is append-only for tasks.** Status edits (`pending` → `claimed` → `done`/`failed`) are the only in-place modifications allowed; `partial` results map to queue `done`.
- **Results are write-once.** A sub-agent checks `results/<task-id>.md` does not already exist before writing, and never modifies it after.
- **Heartbeat.** The main agent updates `Last heartbeat` every poll; a sub-agent exits if the heartbeat is stale (~2–3 min), so a crashed main agent never leaves workers looping forever.
- **Jitter is consistently 5–15 s** when no claimable task is available.
- **Log everything.** Both roles append to `log.md` on every meaningful action. This is the audit trail.
- **Clean up safely.** Only after in-flight claims have drained, the main agent offers to archive (move to `.side-agent-archive/<timestamp>/` with a Windows-safe, colon-free timestamp like `2026-07-11T22-00-00Z`) or delete `.side-agent/`.
