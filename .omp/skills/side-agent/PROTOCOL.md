# Side-Agent Coordination Protocol

A file-based protocol for coordinating one main agent with N sub-agents. All communication happens through files in a shared `.side-agent/` directory. No IPC, no sockets, no extensions — just file reads and writes.

## Directory structure

```
<workspace-root>/.side-agent/
  session.md          — session metadata, lifecycle signal, and main-agent heartbeat
  queue.md            — task queue (statuses edited in place)
  claims/             — atomic per-task claim locks (one dir per claimed task)
    TASK-001/
      claim.md        — claimer ID and ISO-8601 claim timestamp
    TASK-002/
      claim.md
  workers/            — atomic worker-ID registration (one dir per active worker)
    sub-agent-1/
    sub-agent-2/
  results/            — one markdown file per completed task
    TASK-001.md
    TASK-002.md
    ...
  log.md              — append-only activity log (audit trail)
```

## File specs

### session.md

Created by the main agent on initialization. Read by sub-agents on startup and every poll cycle.

```markdown
# Side-Agent Session

- **Created:** <ISO-8601 timestamp>
- **Main agent ID:** <main-agent-id>
- **Status:** active | complete | aborted
- **Sub-agents requested:** <N>
- **Workspace:** <absolute path to workspace root>
- **Description:** <one-line description of the overall goal>
- **Last heartbeat:** <ISO-8601 timestamp — updated by the main agent on every poll cycle>
```

**Status transitions:**
- `active` → `complete` (main agent sets this when every task has reached a terminal state — `done` or `failed` — and results are aggregated)
- `active` → `aborted` (main agent sets this on error or user cancellation)
- Sub-agents must check this field every poll cycle. If `complete` or `aborted`, the sub-agent exits the loop.
- **Main-agent liveness (heartbeat):** the main agent updates `Last heartbeat` on every poll cycle. A sub-agent that reads `Status: active` but a `Last heartbeat` older than ~3 minutes treats the main agent as gone — it logs the staleness and exits (it does not loop forever). The user may also manually set `Status: aborted`.

### queue.md

Task list. The main agent appends tasks; sub-agents read and claim them. New tasks are appended; the `Status` and `Claimed by` fields are edited in place as work progresses. **Ownership is established by the claim directory** (see Claim ownership below), not by editing this file — `queue.md` only mirrors ownership for human readability and audit.

```markdown
# Side-Agent Task Queue

---

### TASK-001
- **Description:** Research the authentication module structure
- **Scope:** `packages/auth/`, `packages/wire/src/auth/`
- **Deliverable:** A markdown summary of all auth-related files, their responsibilities, and key types
- **Constraints:** Read-only. Do not modify any files.
- **Depends on:** none
- **Status:** pending
- **Claimed by:**

### TASK-002
- **Description:** Review the public API surface for missing error codes
- **Scope:** `packages/wire/src/api/`
- **Deliverable:** A list of API endpoints and their error handling coverage
- **Constraints:** Read-only. Do not modify any files.
- **Status:** pending
- **Claimed by:**
```

**Task ID format:** `TASK-<NNN>` — zero-padded sequential number assigned by the main agent.

**Status field transitions:**
- `pending` → `claimed` — sub-agent creates the claim directory `claims/TASK-<NNN>/` (the atomic ownership step) and mirrors the state here.
- `claimed` → `done` — sub-agent finished and wrote the result file. The result file's own `Status:` is `done` **or** `partial`; `partial` still maps to a `done` queue status. The main agent must read each result's `Status:` field to detect `partial` and flag it (do not infer success from the queue status alone).
- `claimed` → `failed` — sub-agent could not finish; wrote a result file with `Status: failed` and the error.
- `claimed` → `pending` (re-claim) — main agent resets a stale `claimed` task back to `pending` for another worker (see Stale-claim recovery).

**Claimed by field:** Empty while `pending`. Filled with the worker's ID (e.g., `sub-agent-1`) when the claim directory is created. This is a mirror only — the claim directory is authoritative.

**Depends on field:** `none`, or `TASK-XXX` (optionally a comma-separated list) naming tasks whose results this task needs. A dependency is satisfied only when `results/<dep>.md` exists **and** its `Status:` is `done` or `partial` — a `failed` dependency, or one with a missing/malformed `Status:` line, is **not** satisfied (default safe). The main agent must validate this field as an acyclic graph before dispatch: reject cycles, self-loops (`TASK-X` depending on `TASK-X`), and dangling targets (a dep id with no matching task). A worker must not claim a task until every dependency is satisfied.

### results/<task-id>.md

Written once by the sub-agent that owns the task. **Before writing, the worker must confirm `results/TASK-<id>.md` does not already exist** — if it exists, the task was already completed (or reclaimed and redone by another worker); the worker must not clobber it, must not remove the claim, and should bail and surface the conflict to the main agent. Never modified after writing.

```markdown
# Result: TASK-001

- **Task:** Research the authentication module structure
- **Completed by:** sub-agent-1
- **Completed at:** <ISO-8601 timestamp>
- **Status:** done | failed | partial

## Result

<the actual deliverable — summary, analysis, code, plan, etc.>

## Files examined

- `packages/auth/src/index.ts`
- `packages/auth/src/session.ts`
- ...

## Notes

<anything the main agent or user should know>
```

### log.md

Append-only. Both roles write here. This is the audit trail.

```markdown
# Side-Agent Activity Log

[2026-07-11T22:00:00Z] [main-agent] Session created. 3 tasks dispatched.
[2026-07-11T22:01:15Z] [sub-agent-1] Claimed TASK-001
[2026-07-11T22:01:20Z] [sub-agent-2] Claimed TASK-002
[2026-07-11T22:03:45Z] [sub-agent-1] Completed TASK-001 → results/TASK-001.md
[2026-07-11T22:04:10Z] [sub-agent-2] Failed TASK-002: <error summary>
```

## Protocol flows

### Main agent flow

```
1. Create .side-agent/ tree: session.md, queue.md, log.md, claims/, workers/, results/
2. Write session.md (status: active, Last heartbeat: now)
3. Decompose work into tasks; VALIDATE the dependency graph is a DAG (no cycles,
   no self-loops TASK-X→TASK-X, no dangling dep targets). If invalid, merge/reorder
   until acyclic before dispatch, and tell the user.
4. Write queue.md with all tasks (Status: pending, Claimed by: empty)
5. Write log.md (initial entry)
6. Instruct user to launch N sub-agent instances
7. Poll loop:
   a. Update session.md Last heartbeat: <now>
   b. Read queue.md — check every task's status
   c. Stale-claim recovery: scan the CONTENTS of claims/ (every claim dir present),
      reconciled against queue.md regardless of Status (see below)
   d. If all tasks are terminal (done or failed) → read all results/*.md (read each
      result's Status: to flag partial) → aggregate → write session.md (complete) → report
   e. Otherwise → wait (sleep 10-30s) → repeat
   f. On error or user cancel → drain/abort (see Completion, abort, cleanup)
```

### Sub-agent flow

```
1. Read .side-agent/session.md — confirm status: active (else stop)
2. Acquire a unique worker ID ATOMICALLY: try mkdir .side-agent/workers/sub-agent-1,
   then sub-agent-2, ... until one succeeds. The first N that succeeds is your ID
   (workers/ is the authoritative ID source; never count log entries).
3. Poll loop:
   a. Read session.md — if status != active → exit loop. If status is active but
      Last heartbeat is older than ~2-3 min → main is gone: log staleness and exit
      (independent of the "all terminal" exit below).
   b. Read queue.md — collect "pending" tasks whose dependencies are satisfied:
      results/<dep>.md exists AND its Status: is done/partial for every Depends on.
      A failed/missing/malformed dependency is NOT satisfied.
   c. If no claimable task:
      - If all tasks are terminal (done/failed) → exit loop (work complete)
      - Else → wait with jitter (sleep 5-15s) → repeat
   d. Claim the FIRST claimable task ATOMICALLY (see Claim ownership):
      - Create .side-agent/claims/TASK-<id>/ so it FAILS if it exists (POSIX: mkdir
        claims/TASK-<id>; PowerShell: New-Item -ItemType Directory -ErrorAction Stop.
        NEVER use cmd.exe mkdir — it returns success on an existing dir).
      - Classify the outcome:
        * Created OK → you own it. Write claims/TASK-<id>/claim.md (your id + ISO-8601),
          mirror into queue.md (Status: claimed, Claimed by: <id>), log "Claimed TASK-<id>".
        * Failed because it ALREADY EXISTS (lost race) → back off: log "Lost race on
          TASK-<id>", try the next claimable task (step 3b).
        * Failed for ANOTHER reason (parent claims/ missing, permissions, path-too-long)
          → NOT a race. Log the error, stop polling, surface to the main agent. Do not loop.
   e. Execute the task (respect scope/constraints; read dependency results first)
   f. Re-validate ownership: re-read claims/TASK-<id>/claim.md. If it is gone or its
      "Claimed by" is no longer your id → you were revoked (main reclaimed the stale
      claim and another worker took over). ABORT silently: do not write the result, do
      not touch the claim dir, log "Revoked TASK-<id>", go to step 3a.
   g. If results/TASK-<id>.md already exists → conflict; do not clobber, do not remove
      the claim; surface to main; go to step 3a.
   h. Write results/TASK-<id>.md (write-once; Status: done | failed | partial)
   i. Edit queue.md: Status: claimed → done (for done/partial) or failed
   j. Re-validate ownership AGAIN, then remove claims/TASK-<id>/ to release the lock.
      If ownership was lost mid-flight, LEAVE the result and the claim dir alone and
      exit the task without touching the dir.
   k. Append to log.md: "Completed TASK-<id>" or "Failed TASK-<id>: <error>"
   l. Go to step 3a
```

## Worker IDs (atomic)

A worker's ID is acquired by atomic per-ID directory creation in `workers/`, exactly like a claim: try `mkdir .side-agent/workers/sub-agent-1`, then `-2`, ... until one succeeds. The first `N` that succeeds is the worker's ID. `workers/` is the authoritative ID source (not `log.md` counting), so two joiners can never pick the same ID. (A `sub-agent-<random>` single mkdir is an equivalent collision-free alternative.)

## Claim ownership (atomic)

Ownership of a task is granted by a single **atomic** filesystem operation: creating the task's claim directory such that the create **fails if the directory already exists**. Two concurrent attempts on the same path cannot both succeed.

**Atomic claim invariant:** for any `TASK-<id>`, at most one worker holds the claim at a time, because ownership is granted by one atomic create — so two workers can never both believe they own, and therefore can never both execute, the same task. `queue.md` is a human-readable mirror; `claims/TASK-<id>/` is the single source of truth for ownership.

**Portable atomic create — use the one that provably fails-on-exists for your shell:**

| Shell | Atomic claim command | Fails on exists? |
|---|---|---|
| POSIX (bash / git-bash / zsh) | `mkdir .side-agent/claims/TASK-<id>` | yes (exit 1, EEXIST) |
| Windows PowerShell | `New-Item -ItemType Directory -Path .side-agent\claims\TASK-<id> -ErrorAction Stop` | yes (throws) |
| Windows cmd.exe | **do not use** — `mkdir` returns success on an existing dir | **NO** |

`-ErrorAction Stop` is mandatory in PowerShell (without it `New-Item` may return the existing item as success). cmd.exe `mkdir` of an existing directory returns exit 0 on Windows, so it is **not** atomic and must not be used for claims.

Why a directory and not a file edit? Editing `queue.md` is a read-modify-write — two workers can both read `pending`, and the second write silently clobbers the first claim. Directory creation has no read-then-write gap: the create itself is the test-and-set.

### Loser backoff and failure classification

A claim create can fail two ways — they must be told apart:

1. **Already exists (lost race)** → back off: skip to the next claimable task. If none remain, sleep a short randomized interval (5–15 s jitter) and rescan. Never retry the same create in a tight loop. (POSIX: after a failed `mkdir`, if the target now exists it was a lost race. PowerShell: a `ResourceExists` / "already exists" error is a lost race.)
2. **Other error** (parent `claims/` missing because init is incomplete, permissions, Windows MAX_PATH) → **not** a race. Log the error, stop polling, and surface it to the main agent. Do not classify this as a lost race or you will loop forever on a task that can never run.

### Stale-claim recovery (main agent only)

A worker that crashes after creating its claim dir but before completing leaves the dir behind with no result. The main agent is the only role that removes claim directories it does not own, which prevents two agents racing to recover the same task. **On each poll the main agent scans the CONTENTS of `claims/` (every claim directory present) and reconciles each against `queue.md` — regardless of the queue `Status`.** This also catches the orphaned-pending case (a `pending` task whose claim dir was left behind when the worker died between create and mirror):

For each `claims/TASK-<id>/` found:
1. If `results/TASK-<id>.md` exists → the task is done/failed. Ensure `queue.md` matches (do **not** reset a terminal task back to pending), and remove `claims/TASK-<id>/`.
2. Else if the claim dir has **no `claim.md`** → stale immediately (worker died right after the create). Remove `claims/TASK-<id>/`; if the queue task is not already terminal, reset it to `pending` and clear `Claimed by:`; log `Reclaimed stale TASK-<id>`.
3. Else if `claim.md` exists but its timestamp is older than the stale threshold (default **5 minutes**) → stalled/crashed. Remove `claims/TASK-<id>/`; reset to `pending` only if not already terminal, and clear `Claimed by:`; log `Reclaimed stale TASK-<id> (was <claimer>)`.
4. Else (`claim.md` fresh, within threshold) → healthy in-flight, including a worker legitimately inside the create→mirror window on a still-`pending` task. Leave it alone.

### Completion, abort, and cleanup

- **Completion (per task):** re-validate ownership → write the result → set `queue.md` `Status` → `done` (for `done`/`partial`) or `failed` → re-validate ownership again → remove your own claim dir. The double re-validation brackets the result write, so a reclaimed task's data and its new owner are never clobbered.
- **Abort a single task (worker):** if you cannot complete it, re-validate ownership; if still yours, write a `failed` result, set `queue.md` `Status` → `failed`, then re-validate and remove your claim dir. The main agent may re-dispatch by resetting a `failed` task to `pending` (removing any leftover claim dir first).
- **Session abort (main agent):** set `session.md` `Status` → `aborted` and log it. Sub-agents see it at the top of their next poll and stop starting new work — but a worker already mid-task finishes that task first. **Do not archive or delete `.side-agent/` immediately:** wait until in-flight claim directories have drained (or until all worker terminals report exited), otherwise in-flight writes race the cleanup and produce torn/missing files. Tell the user to defer cleanup until workers report exited.

## Error handling

- **Sub-agent task failure:** re-validate ownership; if still yours, write a `failed` result, set `queue.md` `Status` → `failed`, re-validate, remove the claim dir. The main agent reports the failure and may re-dispatch by resetting to `pending`.
- **Sub-agent crash:** the claim dir is left behind with no result. Stale-claim recovery detects it via the `claims/` scan and resets the task to `pending`. The task is never lost, and the orphaned-pending deadlock cannot occur because recovery scans `claims/`, not just `claimed` rows.
- **Main agent crash:** `Last heartbeat` stops updating. Sub-agents reading a stale heartbeat (older than ~2–3 min) log it and exit; they do not loop forever. The user may also manually set `Status` → `aborted`.
- **Race on the same task:** impossible by construction — the atomic create guarantees a single winner; every other worker backs off. Slow workers that exceed the threshold are reclaimed, and the reclaimed worker re-validates ownership before any write/release, so it cannot clobber the new owner.
- **mkdir for a non-race reason:** classified and surfaced (see Loser backoff), never mis-looped as a lost race.

## Cleanup

When the main agent reports to the user (and only after in-flight claims have drained), it offers two options:
1. **Archive** — move `.side-agent/` to `.side-agent-archive/<timestamp>/`, using a **Windows-safe** timestamp with no colons, e.g. `2026-07-11T22-00-00Z`.
2. **Delete** — remove `.side-agent/` entirely.

The main agent must not auto-delete without user consent — the log and results may be valuable for debugging.

Both `.side-agent/` and `.side-agent-archive/` are gitignored runtime state — they are never committed. Archive preserves the audit trail (log, claims, results) across sessions; delete discards it.
