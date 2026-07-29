---
name: side-agent
description: Coordinate split-view main-agent and sub-agent workflows using a shared file-based command queue. Works with ANY CLI IDE that can read/write files and invoke skills. One instance assumes the main-agent role (coordinator); N other instances take on sub-agent roles (workers). Use when the user wants to run a side sub-agent in parallel to the main agent, dispatch research or exploration tasks to sub-agents, poll for sub-agent results, or manage multi-agent split-view sessions. Trigger on "run side agent", "launch sub-agent", "main-agent mode", "sub-agent mode", "split view workflow", "coordinate sub-agent", or when setting up agent-to-agent task delegation.
---

# Side-Agent

A file-based multi-agent coordination protocol that works with **any CLI IDE** whose agent can read/write files and invoke skills. No extensions, no IPC, no special APIs — just markdown files and atomic directory/file operations on disk. Race-safe on POSIX and Windows.

## Roles

| Role | Count | Responsibility |
|---|---|---|
| **Main agent** | exactly 1 | Decomposes work into tasks, dispatches them to the queue, polls for results, mirrors claims into the queue, publishes results, fences stale claims, aggregates, and reports to the user. |
| **Sub-agent** | 1–N | Polls the queue for unclaimed tasks (read-only), claims one atomically, executes it while renewing a heartbeat, writes a claim-local result + completion marker, then stops touching the claim. Repeats until told to stop. |

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
4. Poll for results: mirror active claims into the queue, publish completed claim-local results, fence stale claims, and aggregate into a final report.

### Sub-agent (worker)

In a separate terminal, same workspace:

```
/side-agent join
```

The agent will:
1. Read `.side-agent/session.md` to confirm a session is active.
2. Enter a poll loop: scan `queue.md` (read-only) for unclaimed tasks, claim one atomically with an immutable claim token, execute it while renewing the heartbeat, write the result + completion marker into the claim directory, then stop touching the claim.
3. Stop when the queue is complete and the main agent has signaled completion in `session.md`.

## How it works

All coordination happens through files in `.side-agent/`:

```
.side-agent/
  session.md              — session metadata, lifecycle signal, main heartbeat (main-owned)
  queue.md                — task queue (main is sole writer of Status and Claimed by)
  claims/                 — atomic per-task claim locks (one dir per ACTIVE claim)
    <task-id>/
      claim.md            — Claimed by, Claim token, Claimed at, Heartbeat, Task
      result.md           — claim-local result (written once by the owning worker)
      complete            — completion marker, created LAST by the worker
      events.md           — claim/worker-local event log (optional)
  claims-revoked/         — quarantine + audit graveyard for fenced/recovered claims
    <task-id>-<token>/    — stale/aborted claim moved here atomically by the main agent
  workers/                — atomic worker-ID registration (one dir per active worker)
    sub-agent-1/
      events.md           — worker-local event log (optional)
  results/                — published results (main-owned)
    <task-id>.md
  log.md                  — main-owned audit trail (only the main agent appends)
```

The protocol is fully specified in [PROTOCOL.md](PROTOCOL.md).

Detailed role instructions:
- **[MAIN-AGENT.md](MAIN-AGENT.md)** — dispatch, poll, mirror, publish, fence, aggregate, completion
- **[SUB-AGENT.md](SUB-AGENT.md)** — poll, claim, execute, heartbeat, report, shutdown

## Writer ownership (the key invariants)

- **The main agent is the sole writer of `queue.md` task fields** (`Status`, `Claimed by`) and the **sole appender to `log.md`**. Workers never edit `queue.md` and never append to `log.md` (concurrent appends would interleave/tear).
- **Workers write results claim-local.** A worker writes `claims/TASK-<id>/result.md` and creates the `complete` marker last. It never writes under `results/`. The main agent copies the completed `result.md` to `results/TASK-<id>.md` (write-once) after verifying ownership.
- **Workers never remove or rename a claim.** Only the main agent fences/removes claims.

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
- **Claimed by:** (empty until the main agent mirrors a claim)
```

## Claim mechanism (atomic + fenced)

Ownership of a task is established by a single **atomic** filesystem operation — creating the task's claim directory such that the create **fails if the directory already exists**. Exactly one caller wins; concurrent attempts fail. The winner then writes an immutable **claim token** into `claim.md`.

To claim a task:

1. Read `queue.md` (read-only). Find the first task that is `Status: pending` **and** whose dependencies are satisfied (each `results/<dep>.md` exists **and** its `Status:` is `done`/`partial` — a `failed`/missing/malformed dependency is not satisfied).
2. **Atomically create** the directory `.side-agent/claims/TASK-<id>/` so the create fails if it exists: POSIX `mkdir .side-agent/claims/TASK-<id>` (no `-p`); Windows PowerShell `New-Item -ItemType Directory -Path .side-agent\claims\TASK-<id> -ErrorAction Stop`. **Never use cmd.exe `mkdir`** — it returns success on an existing dir on Windows, breaking atomicity.
3. **Creation succeeded** → you own the task. Generate a fresh immutable claim token; write `claims/TASK-<id>/claim.md` (Claimed by, Claim token, Claimed at, Heartbeat: now, Task). **Do not edit `queue.md`** — the main agent mirrors your claim. Emit a claim event.
4. **Creation failed because it ALREADY EXISTS** (lost race) → back off: skip to the next pending task; if none, wait 5–15 s jitter and rescan. Do not retry the same create in a tight loop.
5. **Creation failed for another reason** (parent `claims/` missing, permissions, path-too-long) → not a race. Emit the error, stop, and surface it to the main agent. Do not misclassify it as a lost race or you loop forever.

**Atomic claim invariant:** for any task, at most one worker holds the claim at a time, because ownership is granted by one atomic create. Two workers can never both believe they own the same task, so two workers can never execute the same task. (POSIX `mkdir` fails with EEXIST and PowerShell `New-Item -ErrorAction Stop` throws — both atomic; cmd.exe `mkdir` is not atomic and must be avoided.)

## Heartbeat (renewable, atomic)

While executing, the worker renews the `Heartbeat:` field in `claim.md` at least once per minute **and** before/after long steps. Each renewal first re-validates ownership (re-read `claim.md`; if the path is gone or the token is no longer yours → revoked, abort), then rewrites `claim.md` via **atomic temp-write+replace**:
- POSIX: write `claim.md.tmp.<token>` then `mv -f claim.md.tmp.<token> claim.md`
- PowerShell: write `claim.md.tmp.<token>` then `Move-Item -Force claim.md.tmp.<token> claim.md`

## Fencing (revocation via atomic rename)

The main agent revokes a stale claim not by deleting it in place, but by **atomically renaming** the whole `claims/TASK-<id>/` directory into `claims-revoked/TASK-<id>-<token>`:
- POSIX: `mv -n .side-agent/claims/TASK-001 .side-agent/claims-revoked/TASK-001-<token>`
- PowerShell: `Move-Item -Path .side-agent\claims\TASK-001 -Destination .side-agent\claims-revoked\TASK-001-<token> -ErrorAction Stop`

The command exit code alone is not proof (`mv -n` may succeed after skipping). Grant recovery only after verifying source absence, destination presence, and the expected token in the destination `claim.md`; otherwise leave `queue.md` unchanged and rescan.

After a successful rename, the original claim path no longer exists, so the old worker's next re-validation fails (path gone) and any write it attempts fails. A fenced worker therefore cannot create the `complete` marker and cannot have its `result.md` published — revoked attempts are ignored. The unique `<token>` suffix means repeated revocations never collide.

## Completion

**Per task (sub-agent):** re-validate ownership → write `claims/TASK-<id>/result.md` (write-once) → create the `complete` marker **last** → stop touching the claim. The worker does not edit `queue.md` and does not remove the claim.

**Per task (main agent):** on seeing `complete` + `result.md`, verify token/path/current ownership → copy `result.md` to `results/TASK-<id>.md` only if absent (write-once) → set the queue terminal status (`done`/`partial` → `done`; `failed` → `failed`) → archive (move to `claims-revoked/`) or remove the claim. Revoked attempts are ignored.

**Session (main agent):** sets `session.md` `Status: complete` once every task has reached a terminal state (`done` or `failed`) and results are aggregated. Sub-agents see `complete`/`aborted` on their next poll and exit.

## Stale-claim recovery (main agent, fenced)

A worker that crashes mid-task leaves its claim directory behind. On each poll the main agent **scans the contents of `claims/`** (every claim directory present), reconciled against `queue.md` regardless of Status — not only `Status: claimed` rows (this also catches the orphaned-pending case). It is the **only** role that fences/removes claim directories it does not own, which prevents two agents racing to recover the same task:

1. For each `claims/TASK-<id>/` found:
   - If **both** `complete` marker **and** `result.md` exist → publish (see Completion), then retire the claim. Do not fence a completed claim.
   - Else if the claim dir has **no `claim.md`** → **initializing**. Leave it alone for a **30-second grace** window. After grace, atomically rename to `claims-revoked/`. **Only if the rename succeeds:** reset to `pending` (clear `Claimed by:`) if not already terminal; log the reclaim. **If the rename fails:** rescan next poll.
   - Else if `claim.md` exists but its **Heartbeat** is older than the stale threshold (default **5 minutes**) → stalled/crashed. Atomically rename to `claims-revoked/TASK-<id>-<token>`. **Only if the rename succeeds:** reset to `pending` (clear `Claimed by:`) if not already terminal; log `Reclaimed stale TASK-<id> (was <claimer>)`. **If the rename fails:** rescan next poll.
   - Else (fresh, within threshold) → healthy in-flight; leave it alone.

**Only a verified rename grants recovery.** Confirm source absence, destination presence, and the expected token; a command exit code alone is insufficient. Any failed or ambiguous rename means the main agent rescans rather than changing the queue. There is no immediate reclaim of empty claims and no unfenced in-place deletion.

## Guardrails

- **Main agent does not execute tasks.** It decomposes, dispatches, polls, mirrors claims, publishes results, fences stale claims, and aggregates.
- **Main agent is the sole writer of `queue.md` task fields and the sole appender to `log.md`.** Workers read `queue.md` read-only and never append to `log.md`.
- **Sub-agents do not talk to the user.** They write results and events to files only.
- **Sub-agents must not edit files outside their task scope** unless the task explicitly permits it.
- **The claim directory plus its claim token are the source of truth for ownership.** `claims/TASK-<id>/claim.md` (not `queue.md`) decides who owns a task; the token is immutable for the claim's life.
- **Re-validate ownership before any claim.md rewrite and before writing the result.** The worker confirms the path still exists and the token is still its own; if fenced/revoked, it aborts silently and touches nothing.
- **Workers never remove or rename a claim directory.** Only the main agent retires (after publishing) or fences (stale recovery) claims.
- **Worker IDs come from atomic `workers/` dirs**, never from counting `log.md`.
- **Use portable atomic primitives.** Atomic create: POSIX `mkdir` or PowerShell `New-Item -ErrorAction Stop`; never cmd.exe `mkdir`. Atomic rename (fencing): POSIX `mv -n` or PowerShell `Move-Item -ErrorAction Stop`. Atomic temp-write+replace (heartbeat/result): temp file then `mv -f` / `Move-Item -Force`. Classify create failures: already-exists = lost race (back off); anything else = error (stop, surface).
- **Heartbeat is renewable.** The worker renews `claim.md` `Heartbeat:` ≥ once/minute and before/after long steps (atomic temp-write+replace, after re-validation). The main agent fences claims whose heartbeat is older than 5 minutes.
- **Empty claims get a 30-second initialization grace**, not immediate reclaim. After grace the main agent fences via atomic rename; only a successful rename resets the task.
- **Dependencies need a satisfied result.** A dependency is satisfied only when its result exists with `Status:` `done`/`partial`; `failed`/missing/malformed = not satisfied. The main agent validates the dependency graph is a DAG (no cycles/self-loops/dangling) before dispatch.
- **The queue is append-only for tasks.** Status edits are the main agent's in-place mirror of claim state; `partial` results map to queue `done`.
- **Results are write-once at both levels.** A worker writes claim-local `result.md` once; the main agent writes `results/TASK-<id>.md` only when it does not already exist.
- **Session heartbeat.** The main agent updates `Last heartbeat` every poll; a sub-agent exits if the heartbeat is stale (~2–3 min), so a crashed main agent never leaves workers looping forever.
- **Jitter is consistently 5–15 s** when no claimable task is available.
- **Log everything (main-owned).** The main agent appends to `log.md` on every meaningful action; workers emit claim/worker-local event files which the main agent may fold into the log. This is the audit trail.
- **Clean up safely.** Only after in-flight claims have drained, the main agent offers to archive (move to `.side-agent-archive/<timestamp>/` with a Windows-safe, colon-free timestamp like `2026-07-11T22-00-00Z`) or delete `.side-agent/`. `claims-revoked/` is part of the audit trail.
