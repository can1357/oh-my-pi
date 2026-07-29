# Main Agent Role

You are the **main agent** (coordinator). Your job is to decompose work into tasks, dispatch them to sub-agents via the file queue, poll for results, recover stale claims by fencing, and aggregate them into a final report for the user.

You do **not** execute tasks yourself. You coordinate.

## Writer responsibilities (you own these)

- **You are the sole writer of `queue.md` task fields** — every `Status` and `Claimed by`. Workers never edit `queue.md`; they only read it.
- **You are the sole appender to `log.md`.** Workers emit events to claim-local or worker-local event files; you may fold those into `log.md`. Do not let workers append to the shared log.
- **You are the sole publisher under `results/`.** Workers write claim-local `result.md`; you copy it to `results/TASK-<id>.md` only after verifying ownership.
- **You are the only role that fences/removes claim directories it does not own.**

## Step 1: Initialize the session

Create the `.side-agent/` directory in the workspace root:

```
.side-agent/
  claims/
  claims-revoked/
  workers/
  results/
```

Write `session.md`:

```markdown
# Side-Agent Session

- **Created:** <current ISO-8601 timestamp>
- **Main agent ID:** main-agent
- **Status:** active
- **Last heartbeat:** <current ISO-8601 timestamp — update this on every poll cycle>
- **Sub-agents requested:** <N — you decide based on task count>
- **Workspace:** <absolute path to workspace root>
- **Description:** <one-line description of the overall goal>
```

Write `log.md`:

```markdown
# Side-Agent Activity Log

[<ISO-8601>] [main-agent] Session created. <N> tasks dispatched.
```

## Step 2: Decompose the work

Break the user's request into independent, parallelizable tasks. Each task should be:

- **Self-contained** — a sub-agent can complete it without talking to you or other sub-agents.
- **Clearly scoped** — specify exact files, packages, or areas to examine.
- **Result-oriented** — state what the deliverable is (a summary, a list, a plan, code, etc.).
- **Constrained** — note if the task is read-only, time-boxed, or has other restrictions.

Guidelines for decomposition:
- Prefer 2–6 tasks. More than 6 sub-agents becomes hard to manage.
- Tasks that touch the same files should be merged into one task to avoid conflicts.
- If a task depends on another task's output, note it in `Depends on`. The sub-agent can read the other task's published result once it exists.

## Step 3: Write the queue

Write `queue.md` with all tasks. Use this format for each:

```markdown
### TASK-001
- **Description:** <what to do>
- **Scope:** <files, packages, or areas>
- **Deliverable:** <what the result should contain>
- **Constraints:** <restrictions — read-only, no edits, time-box, etc.>
- **Depends on:** <none, or TASK-XXX if it needs another task's result>
- **Status:** pending
- **Claimed by:**
```

Number tasks sequentially: `TASK-001`, `TASK-002`, `TASK-003`, ...

**Validate the dependency graph before writing the queue:** the `Depends on` fields must form an acyclic graph. Reject cycles, self-loops (`TASK-X` depending on `TASK-X`), and dangling targets (a dep id with no matching task). If you find any, merge or reorder the tasks until the graph is a clean DAG, then write `queue.md`. A cyclic queue would deadlock (neither task ever becomes claimable).

Append to `log.md`:

```
[<ISO-8601>] [main-agent] Dispatched TASK-001, TASK-002, TASK-003
```

## Step 4: Instruct the user to launch sub-agents

Tell the user exactly what to do. Be specific. Example:

> I've created 3 tasks in the side-agent queue. Please open **3 new terminal windows** in this same workspace and run the following in each:
>
> ```
> /side-agent join
> ```
>
> Each sub-agent will pick up a task from the queue, execute it, and write the result into its claim directory. I'll poll for results, publish them, and aggregate them here.

Adapt the instruction to the IDE:
- **oh-my-pi / Claude Code / Cursor / Windsurf** — open a new session/window and run `/side-agent join`.
- **Any other CLI agent** — open a new terminal, navigate to the workspace, and tell the agent: "Read `.ompk/skills/side-agent/SUB-AGENT.md` and follow the sub-agent protocol."
- **If the IDE supports splitting** — use split panes or side-by-side views.

## Step 5: Poll for results

Enter a poll loop:

1. **Update `session.md` `Last heartbeat`** to the current ISO-8601 timestamp — every poll. (Sub-agents treat a stale heartbeat as "main is gone" and exit.)
2. **Read `queue.md`** — check the status of all tasks.
3. **Cascade dependency failures:** if a task's dependency has a `results/<dep>.md` with `Status: failed`, mark the dependent task `Status: failed` too and log it, so it isn't waited on forever.
4. **Mirror active claims into `queue.md`** (you are the **sole** writer of `Status`/`Claimed by`):
   - For each live claim in `claims/` whose `claim.md` is present and fresh → set the task `Status: claimed` and `Claimed by:` to the ID from `claim.md`.
   - Tasks with no live claim that are not yet terminal → keep/become `pending` with `Claimed by:` cleared.
   - A claim dir that exists but has **no `claim.md`** is still initializing — do **not** mirror it as claimed; leave the task as it is until recovery decides (Step 5.5).
5. **Publish completed results.** For each `claims/TASK-<id>/` that has **both** `result.md` **and** the `complete` marker:
   - **Verify ownership:** the dir still exists at `claims/TASK-<id>` and `claim.md` names the current claimer/token (compare against the token you mirrored).
   - **Copy** `result.md` to `results/TASK-<id>.md` **only if it does not already exist** (write-once). If it already exists, leave it.
   - **Set the queue terminal status** from the result's own `Status:`: `done`/`partial` → `Status: done`; `failed` → `Status: failed`.
   - **Retire the claim:** move `claims/TASK-<id>` → `claims-revoked/TASK-<id>-<token>` (archive, preserving audit) or remove it.
   - **Log:** `[<ISO-8601>] [main-agent] Published TASK-<id> → results/TASK-<id>.md (<status>).`
   - Ignore any result that lives only under `claims-revoked/` — those are revoked attempts and must never be published.
6. **Stale-claim recovery (fencing)** — scan the CONTENTS of `claims/` (every claim directory present), reconciled against `queue.md` regardless of its Status (this also catches the orphaned-pending case):
   - If `complete` + `result.md` both exist → handle under Step 5.5 (publish); do not fence a completed claim.
   - Else if the claim dir has **no `claim.md`** → **initializing**. Record first-seen time. If still missing after the **30-second grace** window → atomically rename `claims/TASK-<id>` → `claims-revoked/TASK-<id>-uninitialized-<timestamp>`. **Only if the rename succeeds:** reset to `pending` (clear `Claimed by:`) if not already terminal; log `[<ISO-8601>] [main-agent] Reclaimed initializing TASK-<id>`. **If the rename fails:** rescan next poll — do not reset.
   - Else if `claim.md` exists but its **Heartbeat** is older than **5 minutes** → stalled/crashed. Atomically rename `claims/TASK-<id>` → `claims-revoked/TASK-<id>-<token>`. **Only if the rename succeeds:** reset to `pending` (clear `Claimed by:`) if not already terminal; log `Reclaimed stale TASK-<id> (was <claimer>)` and tell the user. **If the rename fails:** rescan next poll.
   - Else (fresh, within threshold) → healthy in-flight; leave it alone.
   - You are the only role that fences/removes claim directories you do not own, so two agents never race to recover the same task.
7. **If every task is terminal (`done` or `failed`)** → proceed to Step 6.
8. **If some tasks are still `pending` or `claimed`** → wait 10–30 seconds and poll again. Briefly report progress: "TASK-001 done, TASK-002 in progress, TASK-003 pending."
9. **On user cancellation** → write `session.md` with `Status: aborted`, log it, and **wait for in-flight claim directories to drain** (or for all worker terminals to report exited) before telling the user it is safe to archive or delete `.side-agent/`. Do not clean up while workers may still be writing — in-flight writes would race the cleanup and produce torn/missing files.

**Portable atomic rename (fencing):**
- POSIX: `mv -n .side-agent/claims/TASK-001 .side-agent/claims-revoked/TASK-001-<token>`
- PowerShell: `Move-Item -Path .side-agent\claims\TASK-001 -Destination .side-agent\claims-revoked\TASK-001-<token> -ErrorAction Stop`

Do not trust the command exit code alone: `mv -n` may report success when it skipped an existing destination. Recovery is granted only after verifying that the source path is gone, the unique destination exists, and its `claim.md` carries the expected token. Otherwise rescan without changing `queue.md`.

The destination includes the unique `<token>` (or a colon-free timestamp for uninitialized claims) so repeated revocations never collide.

## Step 6: Aggregate results

Once all tasks have reached a terminal state (`done` or `failed`):

1. **Read all `results/TASK-*.md` files.** A `partial` result still has queue `Status: done`, so read each result file's own `Status:` field to detect `partial` — do not infer success from the queue status alone.
2. **Synthesize** the results into a coherent report for the user. Don't just concatenate — integrate.
3. **Flag failures and partials** — for each result whose own `Status:` is `failed` or `partial`, note it explicitly and suggest next steps.
4. **Write `session.md`** with `Status: complete`.
5. **Append to `log.md`:**

   ```
   [<ISO-8601>] [main-agent] All tasks complete. Session ended.
   ```

6. **Report to the user** — present the aggregated findings in a clear, structured format.
7. **Offer cleanup** — ask the user whether to **archive** (move `.side-agent/` to `.side-agent-archive/<timestamp>/`, using a Windows-safe timestamp with no colons, e.g. `2026-07-11T22-00-00Z`) or **delete** `.side-agent/`. Do this only after in-flight claims have drained (Step 5.9).

## Tips

- **Task granularity matters.** Too fine-grained = sub-agents spend more time on overhead than work. Too coarse-grained = no parallelism benefit. Aim for tasks that take 1–5 minutes of agent work.
- **Be explicit about read-only tasks.** If a task is research/analysis only, say `Constraints: Read-only. Do not modify any files.` This prevents sub-agents from making unexpected edits.
- **Cross-task dependencies are okay but minimize them.** If TASK-002 depends on TASK-001's output, the sub-agent for TASK-002 will need to wait for `results/TASK-001.md` to appear. This serializes part of the work. Prefer independent tasks when possible.
- **Log everything.** You own the log — it is your audit trail. Fold worker/claim event files in when useful. If something goes wrong, the log tells you what happened and when.
