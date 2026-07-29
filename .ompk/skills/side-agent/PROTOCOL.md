# Side-Agent Coordination Protocol

A file-based protocol for coordinating one main agent with N sub-agents. All coordination happens through files in a shared `.side-agent/` directory. No IPC, no sockets, no extensions — just file reads, writes, and atomic directory/file operations.

Two properties make the protocol race-safe across both POSIX and Windows:

1. **Atomic claim creation.** Task ownership is granted by a single exclusive-create of a claim directory (`mkdir` that fails if the directory already exists). The claim is cemented by an immutable **claim token** written to `claim.md`.
2. **Fencing via atomic rename.** The main agent revokes a stale claim by atomically **renaming the whole claim directory** into a quarantine path (`claims-revoked/`). After a successful rename, the original claim path no longer exists, so the old worker cannot write its result, cannot create the completion marker, and cannot have its result published. Only a **successful** rename grants recovery; a failed rename means the main agent rescans instead of resetting.

**A rename command's exit code is not fencing proof.** In particular, `mv -n` may exit successfully after skipping an existing destination. The main agent grants recovery only after verifying that the source path is absent, the freshly unique destination exists, and its `claim.md` contains the expected token. Any other state means rescan without changing the queue.

## Roles and writer ownership

| Artifact | Sole writer(s) | Readers |
|---|---|---|
| `session.md` | main agent | everyone |
| `queue.md` tasks | main agent (appends tasks; sole writer of every `Status` and `Claimed by`) | workers read-only |
| `claims/TASK-<id>/claim.md` | the owning worker (heartbeat field) | main reads |
| `claims/TASK-<id>/result.md` | the owning worker (write-once) | main reads after marker |
| `claims/TASK-<id>/complete` | the owning worker (created last) | main reads |
| `claims/TASK-<id>/events.md`, `workers/<id>/events.md` | the owning worker | main may read |
| `results/TASK-<id>.md` | main agent (publishes from a completed claim; write-once) | everyone |
| `log.md` | **main agent only** | everyone |
| `claims-revoked/` | main agent (rename target) | audit only |

**Workers never edit `queue.md`, never write under `results/`, never remove or rename a claim, and never append to `log.md`.** They write only inside their own `claims/TASK-<id>/` directory and their own `workers/<id>/` directory.

## Directory structure

```
<workspace-root>/.side-agent/
  session.md              — session metadata, lifecycle signal, main heartbeat (main-owned)
  queue.md                — task queue (MAIN is the sole writer of Status and Claimed by)
  claims/                 — atomic per-task claim locks (one dir per ACTIVE claim)
    TASK-001/
      claim.md            — Claimed by, Claim token, Claimed at, Heartbeat, Task
      result.md           — claim-local result (written once by the owning worker)
      complete            — completion marker, created LAST by the worker
      events.md           — claim/worker-local event log (optional)
    TASK-002/
      ...
  claims-revoked/         — quarantine + audit graveyard for fenced/recovered claims
    TASK-001-<token>/     — stale/aborted claim moved here atomically by the main agent
      claim.md
      result.md           (present if the worker wrote one before being fenced)
  workers/                — atomic worker-ID registration (one dir per active worker)
    sub-agent-1/
      events.md           — worker-local event log (optional)
  results/                — published results (main-owned; main writes here on completion)
    TASK-001.md
    TASK-002.md
  log.md                  — main-owned audit trail (only the main agent appends)
```

`.side-agent/` and `.side-agent-archive/` are gitignored runtime state — they are never committed. `claims-revoked/` preserves the audit trail for every fenced claim.

## File specs

### session.md

Created by the main agent on initialization. Read by sub-agents on startup and every poll cycle. Main-owned.

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
- Sub-agents check this field every poll cycle. If `complete` or `aborted`, the sub-agent exits.
- **Main-agent liveness (heartbeat):** the main agent updates `Last heartbeat` on every poll cycle. A sub-agent that reads `Status: active` but a `Last heartbeat` older than ~3 minutes treats the main agent as gone — it logs the staleness and exits. The user may also manually set `Status: aborted`.

### queue.md

Task list. The main agent appends tasks and is the **sole writer** of every task's `Status` and `Claimed by` fields. Workers **never edit `queue.md`** — they only read it to find claimable tasks. `Status` and `Claimed by` are mirrors of the claim-directory state, derived by the main agent on each poll. Ownership is established by the claim directory plus its claim token (see Claim ownership), **not** by editing this file.

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

**Status field transitions (all performed by the main agent):**
- `pending` → `claimed` — main agent mirrors a newly-observed live claim (worker created `claims/TASK-<NNN>/claim.md`).
- `claimed` → `done` — main agent published a completed result. The result file's own `Status:` is `done` **or** `partial`; `partial` still maps to a `done` queue status. The main agent reads each result's `Status:` to detect `partial` (do not infer success from the queue status alone).
- `claimed` → `failed` — main agent published a result whose own `Status:` is `failed`.
- `claimed` → `pending` (re-claim) — main agent fenced a stale claim and reset it for another worker (see Stale-claim recovery).

**Claimed by field:** Empty while `pending`. Filled with the worker's ID (e.g., `sub-agent-1`) by the main agent when it mirrors the claim. Mirror only — the claim directory + token are authoritative.

**Depends on field:** `none`, or `TASK-XXX` (optionally a comma-separated list) naming tasks whose results this task needs. A dependency is satisfied only when `results/<dep>.md` exists **and** its `Status:` is `done` or `partial` — a `failed` dependency, or one with a missing/malformed `Status:` line, is **not** satisfied (default safe). The main agent validates this field as an acyclic graph before dispatch: reject cycles, self-loops, and dangling targets. A worker must not claim a task until every dependency is satisfied.

### claims/TASK-<id>/claim.md

Written by the owning worker immediately after the atomic claim create. The **Claim token is immutable** for the life of the claim (generated once, never reused across claims). The **Heartbeat** is renewed by the worker.

```markdown
# Claim: TASK-001

- **Claimed by:** sub-agent-1
- **Claim token:** <UUID v4 or 64+ bit random hex — generated once at claim time, never reused>
- **Claimed at:** <ISO-8601>
- **Heartbeat:** <ISO-8601 — renewed by the worker ≥ once/minute and before/after long steps>
- **Task:** TASK-001
```

### claims/TASK-<id>/result.md

Claim-local result, written once by the owning worker into its **own** claim directory (never directly under `results/`). The worker writes it, then creates the `complete` marker last, then stops touching the claim. The main agent reads it only after the `complete` marker appears, and publishes its content to `results/TASK-<id>.md`.

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

### claims/TASK-<id>/complete

The **completion marker**. An empty file (optionally holding the completion timestamp + token for audit). Created **last** by the worker, only after `result.md` is fully written. Its presence is the sole signal that `result.md` is complete and publishable. The create happens-after the `result.md` write (same worker, same directory), so a reader that sees the marker is guaranteed a fully-written `result.md`; a worker that crashed mid-write of `result.md` leaves no marker, so the torn result is never read.

### results/TASK-<id>.md

Published by the main agent by copying a completed claim's `result.md`. **Write-once:** the main agent writes `results/TASK-<id>.md` only when it does not already exist. If it already exists (already published), the main agent leaves it and just retires the claim.

### log.md

**Main-owned.** Only the main agent appends. Workers do **not** append to the shared `log.md` — concurrent appends from many workers would interleave and tear on every platform. Workers emit events to claim-local `claims/TASK-<id>/events.md` or worker-local `workers/sub-agent-N/events.md`; the main agent may read and fold those into `log.md`.

```markdown
# Side-Agent Activity Log

[2026-07-11T22:00:00Z] [main-agent] Session created. 3 tasks dispatched.
[2026-07-11T22:01:15Z] [main-agent] Mirrored claim TASK-001 → sub-agent-1.
[2026-07-11T22:01:20Z] [main-agent] Mirrored claim TASK-002 → sub-agent-2.
[2026-07-11T22:03:45Z] [main-agent] Published TASK-001 → results/TASK-001.md (done).
[2026-07-11T22:04:10Z] [main-agent] Published TASK-002 → results/TASK-002.md (failed).
[2026-07-11T22:06:00Z] [main-agent] Fenced stale claim TASK-003 (was sub-agent-3) → claims-revoked/.
```

## Protocol flows

### Main agent flow

```
1. Create .side-agent/ tree: session.md, queue.md, log.md, claims/, claims-revoked/,
   workers/, results/
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
   c. Cascade dependency failures: if a dep result is failed, mark the dependent
      task failed too and log it, so it isn't waited on forever.
   d. MIRROR active claims into queue.md (you are the SOLE writer of Status/Claimed by):
      for each live claim in claims/ whose claim.md is present and fresh, set the task
      Status: claimed and Claimed by: <id from claim.md>. Tasks with no live claim that
      are not yet terminal stay/become pending with Claimed by: cleared.
   e. PUBLISH completed results: for each claims/TASK-<id>/ that has BOTH result.md AND
      the complete marker:
        - Verify token/path/current ownership: the dir still exists at claims/TASK-<id>
          and claim.md names the current claimer/token.
        - Copy result.md to results/TASK-<id>.md ONLY if it does not already exist.
        - Set queue Status: done (for done/partial) or failed.
        - Retire the claim: move claims/TASK-<id> → claims-revoked/TASK-<id>-<token>
          (archive) or remove it.
        - Log the publication.
      Ignore any result that lives only under claims-revoked/ — those are revoked
      attempts and must never be published.
   f. STALE-CLAIM RECOVERY (fencing) — see below.
   g. If all tasks are terminal (done or failed) → read all results/*.md (read each
      result's Status: to flag partial) → aggregate → write session.md (complete) → report.
   h. Otherwise → wait (sleep 10-30s) → repeat.
   i. On error or user cancel → drain/abort (see Completion, abort, cleanup).
```

### Sub-agent flow

```
1. Read .side-agent/session.md — confirm status: active (else stop)
2. Acquire a unique worker ID ATOMICALLY: try mkdir .side-agent/workers/sub-agent-1,
   then sub-agent-2, ... until one succeeds. The first N that succeeds is your ID
   (workers/ is the authoritative ID source; never count log entries).
3. Poll loop:
   a. Read session.md — if status != active → exit loop. If status is active but
      Last heartbeat is older than ~2-3 min → main is gone: emit an event (worker-local)
      and exit.
   b. Read queue.md (READ-ONLY — never edit it) — collect pending tasks whose deps are
      satisfied: results/<dep>.md exists AND its Status: is done/partial for every
      Depends on. A failed/missing/malformed dependency is NOT satisfied.
   c. If no claimable task:
      - If all tasks are terminal (done/failed) → exit loop (work complete)
      - Else → wait with jitter (sleep 5-15s) → repeat
   d. Claim the FIRST claimable task ATOMICALLY (see Claim ownership):
      - Create .side-agent/claims/TASK-<id>/ so it FAILS if it exists (POSIX: mkdir
        claims/TASK-<id>; PowerShell: New-Item -ItemType Directory -ErrorAction Stop.
        NEVER use cmd.exe mkdir — it returns success on an existing dir).
      - Created OK → you own it. Generate a fresh Claim token (UUID/random). Write
        claims/TASK-<id>/claim.md (Claimed by, Claim token, Claimed at, Heartbeat: now,
        Task). Do NOT edit queue.md (the main agent mirrors it). Emit a claim event to
        claims/TASK-<id>/events.md or workers/<id>/events.md.
      - Failed because it ALREADY EXISTS (lost race) → back off: emit "lost race",
        try the next claimable task (step 3b).
      - Failed for ANOTHER reason (parent claims/ missing, permissions, path-too-long)
        → NOT a race. Emit the error, stop polling, surface it to the main agent.
   e. Execute the task, RENEWING THE HEARTBEAT: re-validate path+token (re-read
      claim.md; if dir/token gone → revoked, abort silently), then rewrite claim.md via
      atomic temp-write+replace with an updated Heartbeat — at least once per minute AND
      before and after any long step.
   f. Re-validate ownership before writing the result: re-read claims/TASK-<id>/claim.md.
      If the dir/file is gone (main fenced it to claims-revoked/) or the token is no
      longer yours → you were revoked. ABORT silently: write nothing further, touch
      nothing, emit a revoked event, go to step 3a.
   g. Write claims/TASK-<id>/result.md (write-once; Status: done | failed | partial).
   h. Create the complete marker LAST (only after result.md is fully written). Then STOP
      touching the claim.
   i. Emit a completion event (claim/worker-local). Do NOT edit queue.md and do NOT
      remove the claim — the main agent publishes the result and retires the claim.
   j. Go to step 3a.
```

## Worker IDs (atomic)

A worker's ID is acquired by atomic per-ID directory creation in `workers/`, exactly like a claim: try `mkdir .side-agent/workers/sub-agent-1`, then `-2`, ... until one succeeds. The first `N` that succeeds is the worker's ID. `workers/` is the authoritative ID source (not `log.md` counting), so two joiners can never pick the same ID. (A `sub-agent-<random>` single mkdir is an equivalent collision-free alternative.)

## Claim ownership (atomic + fenced)

Ownership of a task is granted by a single **atomic** filesystem operation: creating the task's claim directory such that the create **fails if the directory already exists**. The claim is then cemented by an immutable **claim token** in `claim.md`. A worker proves it still owns a claim by re-reading `claim.md` and confirming **both** that the path still exists **and** that the token is still its own.

**Atomic claim invariant:** for any `TASK-<id>`, at most one worker holds the claim at a time, because ownership is granted by one atomic create. Two workers can never both believe they own the same task, so two workers can never execute the same task. `queue.md` is a human-readable mirror maintained by the main agent; `claims/TASK-<id>/` plus its `claim.md` token are the single source of truth for ownership.

**Fencing invariant:** the main agent revokes a claim by atomically **renaming** the whole `claims/TASK-<id>/` directory into `claims-revoked/TASK-<id>-<token>`. After a successful rename, `claims/TASK-<id>/` no longer exists, so the old worker's next re-validation fails (path gone) and any write it attempts to `claims/TASK-<id>/...` fails. A fenced worker therefore cannot create the `complete` marker and cannot have its `result.md` published — revoked attempts are ignored. This is strictly safer than deleting the claim in place: the old worker can never operate on a path the main agent has already fenced.

**Portable atomic create — use the one that provably fails-on-exists for your shell:**

| Shell | Atomic claim command | Fails on exists? |
|---|---|---|
| POSIX (bash / git-bash / zsh) | `mkdir .side-agent/claims/TASK-<id>` | yes (exit 1, EEXIST) |
| Windows PowerShell | `New-Item -ItemType Directory -Path .side-agent\claims\TASK-<id> -ErrorAction Stop` | yes (throws) |
| Windows cmd.exe | **do not use** — `mkdir` returns success on an existing dir | **NO** |

`-ErrorAction Stop` is mandatory in PowerShell (without it `New-Item` may return the existing item as success). cmd.exe `mkdir` of an existing directory returns exit 0 on Windows, so it is **not** atomic and must not be used for claims.

**Portable atomic rename (fencing) — the revoke operation:**

| Shell | Atomic rename command | Notes |
|---|---|---|
| POSIX | `mv -n .side-agent/claims/TASK-001 .side-agent/claims-revoked/TASK-001-<token>` | rename(2); atomic |
| Windows PowerShell | `Move-Item -Path .side-agent\claims\TASK-001 -Destination .side-agent\claims-revoked\TASK-001-<token> -ErrorAction Stop` | throws on failure |

The destination includes the unique `<token>` (or a colon-free timestamp for uninitialized claims) so repeated revocations never collide and the audit trail is preserved.

**Portable atomic temp-write+replace (claim.md heartbeat renewal; also usable for result.md):**

| Shell | Atomic rewrite |
|---|---|
| POSIX | write to `claim.md.tmp.<token>` then `mv -f claim.md.tmp.<token> claim.md` |
| Windows PowerShell | write to `claim.md.tmp.<token>` then `Move-Item -Force claim.md.tmp.<token> claim.md` |

Why a directory and not a file edit? Editing `queue.md` is a read-modify-write — two workers can both read `pending`, and the second write silently clobbers the first claim. Directory creation has no read-then-write gap: the create itself is the test-and-set. And because workers never edit `queue.md` at all (the main agent is the sole writer), there is no read-modify-write race on the queue.

### Loser backoff and failure classification

A claim create can fail two ways — they must be told apart:

1. **Already exists (lost race)** → back off: skip to the next claimable task. If none remain, sleep a short randomized interval (5–15 s jitter) and rescan. Never retry the same create in a tight loop. (POSIX: after a failed `mkdir`, if the target now exists it was a lost race. PowerShell: a `ResourceExists` / "already exists" error is a lost race.)
2. **Other error** (parent `claims/` missing because init is incomplete, permissions, Windows MAX_PATH) → **not** a race. Emit the error, stop polling, and surface it to the main agent. Do not classify this as a lost race or you will loop forever on a task that can never run.

### Stale-claim recovery (main agent only, fenced)

A worker that crashes mid-task leaves its claim directory behind. The main agent is the **only** role that fences/removes claim directories it does not own, which prevents two agents racing to recover the same task. **On each poll the main agent scans the CONTENTS of `claims/` (every claim directory present) and reconciles each against `queue.md` — regardless of the queue `Status`.** This also catches the orphaned-pending case (a `pending` task whose claim dir was left behind when the worker died between create and mirror).

For each `claims/TASK-<id>/` found:
1. If **both** `complete` marker **and** `result.md` exist → a finished result is ready. Handle it under the PUBLISH step (flow 7e); do **not** fence a completed claim — retire it after publishing.
2. Else if `claim.md` is **missing** → **initializing** (the worker created the dir but has not written `claim.md` yet). Record the first-seen time and leave it alone. If `claim.md` is still missing after the **30-second initialization grace** window → atomically rename `claims/TASK-<id>` → `claims-revoked/TASK-<id>-uninitialized-<timestamp>`. **Only if the rename succeeds:** reset the task to `pending` and clear `Claimed by:` (if not already terminal); log `Reclaimed initializing TASK-<id>`. **If the rename fails:** the worker wrote `claim.md` or the dir already moved — do **not** reset; rescan next poll.
3. Else if `claim.md` exists but its **Heartbeat** is older than the stale threshold (default **5 minutes**) → stalled/crashed. Atomically rename `claims/TASK-<id>` → `claims-revoked/TASK-<id>-<token>`. **Only if the rename succeeds:** reset to `pending` (if not already terminal), clear `Claimed by:`; log `Reclaimed stale TASK-<id> (was <claimer>)`. **If the rename fails:** rescan next poll.
4. Else (`claim.md` present, heartbeat fresh) → healthy in-flight. Leave it alone.

**Only a successful rename grants recovery.** A failed rename means the claim changed between scan and fence (the worker wrote `claim.md`, or the dir was already moved) — the main agent must **not** reset the task and simply rescans. This is the fence that prevents the main agent from destroying a claim a live worker is actively using.

### Completion, abort, and cleanup

- **Per task (worker):** re-validate ownership → write `result.md` → create the `complete` marker last → stop touching the claim. The worker does **not** edit `queue.md` and does **not** remove the claim.
- **Per task (main agent):** on seeing `complete` + `result.md`, verify token/path/current ownership → publish to `results/TASK-<id>.md` only if absent → set the queue terminal status → archive (move to `claims-revoked/TASK-<id>-<token>`) or remove the claim. Revoked attempts (claims-revoked only) are ignored.
- **Abort a single task (worker):** if you cannot complete it, re-validate ownership; if still yours, write a `failed` `result.md`, create the `complete` marker, and stop. The main agent publishes the failure. The main agent may re-dispatch by fencing/resetting the task.
- **Session abort (main agent):** set `session.md` `Status` → `aborted` and log it. Sub-agents see it at the top of their next poll and stop starting new work — but a worker already mid-task finishes that task first. **Do not archive or delete `.side-agent/` immediately:** wait until in-flight claim directories have drained (or until all worker terminals report exited), otherwise in-flight writes race the cleanup and produce torn/missing files. Tell the user to defer cleanup until workers report exited.

## Error handling

- **Sub-agent task failure:** re-validate ownership; if still yours, write a `failed` `result.md`, create the `complete` marker, and stop. The main agent publishes the failure and may re-dispatch by fencing/resetting the task to `pending`.
- **Sub-agent crash:** the claim dir is left behind. Stale-claim recovery detects it via the `claims/` scan: an empty dir triggers the 30-second initializing grace, and a stalled heartbeat (older than 5 min) is fenced via atomic rename to `claims-revoked/`. The task is reset only after a successful fence. The task is never lost.
- **Slow/stalled worker fenced mid-task:** the fence renames its claim away. On its next re-validation the worker sees its claim path is gone (or token no longer current) and aborts silently, touching nothing. It cannot clobber a new owner because its writes target a path that no longer exists.
- **Main agent crash:** `Last heartbeat` stops updating. Sub-agents reading a stale heartbeat (older than ~2–3 min) log it and exit; they do not loop forever. The user may also manually set `Status` → `aborted`.
- **Race on the same task:** impossible by construction — the atomic create guarantees a single winner; every other worker backs off. Slow workers are fenced, and a fenced worker re-validates ownership before any write, so it cannot publish into the current claim.
- **mkdir/rename for a non-race reason:** classified and surfaced (see Loser backoff / fencing), never mis-looped as a lost race or a successful recovery.

## Cleanup

When the main agent reports to the user (and only after in-flight claims have drained), it offers two options:
1. **Archive** — move `.side-agent/` to `.side-agent-archive/<timestamp>/`, using a **Windows-safe** timestamp with no colons, e.g. `2026-07-11T22-00-00Z`.
2. **Delete** — remove `.side-agent/` entirely.

The main agent must not auto-delete without user consent — the log, results, and `claims-revoked/` may be valuable for debugging.

Both `.side-agent/` and `.side-agent-archive/` are gitignored runtime state — they are never committed. Archive preserves the audit trail (log, results, fenced claims) across sessions; delete discards it.
