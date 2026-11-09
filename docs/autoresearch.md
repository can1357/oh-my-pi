# Autoresearch

Autoresearch turns a session into an autonomous optimization loop: the agent writes a benchmark harness, runs it, logs the measured metric, changes code, and runs it again, until something stops it. It is a built-in extension (`packages/coding-agent/src/autoresearch/`, factory `createAutoresearchExtension`), registered by `sdk.ts` into every session that is not tool-restricted. It contributes a `/autoresearch` command, four tools, a dashboard widget, and two turn hooks. It is not a background daemon: every iteration is an ordinary agent turn in the session you started it from.

This page states the contract — what the mode guarantees, what it does not, and where its state lives. The prompt templates in `packages/coding-agent/src/autoresearch/` (`prompt-setup.md`, `prompt.md`, `resume-message.md`, `command-resume.md`) are the instructions handed to the model; they are not a specification of the mechanism.

## Activation

| Input | Effect |
| ----- | ------ |
| `/autoresearch <goal>` | Enter the mode with `<goal>` recorded. On a fresh session the goal text is also submitted as the first user message. |
| `/autoresearch` | Enter the mode with no goal when off; leave it when on. |
| `/autoresearch off` | Leave the mode. |
| `/autoresearch clear [--keep-tree\|--reset-tree]` | Close the session and reset (see [Clearing](#clearing)). |
| `Ctrl+X`, `Ctrl+Shift+X` | Toggle the dashboard widget and open its overlay. Display only. |

Entering appends an `autoresearch-control` session entry (`{ mode, goal? }`) and attaches the four tools; leaving appends `{ mode: "off" }` and detaches them. Those entries are the durable record: `reconstructControlState` replays them on `session_start`, `session_switch`, `session_branch`, and `session_tree`, so the mode survives a resume.

**Who can activate it.** Two gates, and nothing else — no setting, no role, no allow-list:

- `sdk.ts` constructs the extension only when the session is not created with `restrictToolNames`. In a restricted session the command does not exist.
- `AgentSession.prompt` routes a leading `/` to extension commands unless the caller passes `runCommands: false` or `expandPromptTemplates: false`. The interactive TUI, print mode (`modes/print-mode.ts`), RPC (`modes/rpc/rpc-mode.ts`) and ACP all use the default path, so `/autoresearch <goal>` is reachable from each of them. The task executor (`task/executor.ts`) prompts subagents with `runCommands: false`, so a subagent cannot activate the mode by prompting itself.

There is no API that sets the goal other than this command and the `goal` parameter of `init_experiment`. A programmatic caller sets a goal by sending the command text as a prompt.

**Git gates** (`ensureAutoresearchBranch` in `autoresearch/git.ts`), applied in this order:

1. A pure Jujutsu workspace (`.jj/` without a colocated `.git/`) is **refused**.
2. No Git repository at all: accepted with a warning. The mode then runs without branch isolation, baseline reset, or auto-commits.
3. Already on a branch named `autoresearch/*`: accepted as-is.
4. Otherwise a dirty worktree is **refused** — commit or stash first.
5. Otherwise a new branch `autoresearch/<goal-slug>-<YYYYMMDD>` is created and checked out, with a `-2`, `-3`, … suffix when the name is taken.

## The loop

Phase 1 is harness setup. While the mode is on and no stored session exists yet, `before_agent_start` injects `prompt-setup.md`, which tells the model to write `./autoresearch.sh` so that it exits 0 and prints `METRIC <name>=<value>`, validate it with the ordinary `bash` tool, and then call `init_experiment`.

Phase 2 is the iteration loop. Once a session exists, `before_agent_start` injects `prompt.md` instead, carrying the goal, working directory, branch, baseline commit, notes, current segment, baseline and best metric, the last three runs, unjustified scope deviations, and any pending run.

The loop itself is the `agent_end` hook. When a turn ends with the mode on, the hook sends `resume-message.md` as a hidden message (`customType: "autoresearch-resume"`, `display: false`, delivered as the next turn with `triggerTurn`). It sends it when the turn armed a resume — `init_experiment` and `log_experiment` both arm it — or when a completed run is still unlogged and no resume was already sent for that run. One iteration is therefore: edit, `run_experiment`, `log_experiment`, `agent_end`, hidden resume message, next turn.

## Stop conditions

Three, in this precedence order. There is no judge, no verdict model, no token budget, no cost gate, and no wall-clock bound on the loop as a whole. (`run_experiment` has its own per-run timeout — `timeout_seconds`, default 600 — which bounds one benchmark run, not the loop.)

| Precedence | Condition | Terminal? |
| ---------- | --------- | --------- |
| 1 | **Pending user input.** `agent_end` checks `ctx.hasPendingMessages()` first and returns without re-prompting. | **No** |
| 2 | **Iteration cap reached** for the current segment, checked in `log_experiment` after the run is recorded. | Yes, until re-enabled |
| 3 | **Explicit `off` or `clear`.** | Yes |

**Pending user input is non-terminal.** It disarms the resume for that turn only; the mode stays on, the tools stay attached, and the next `log_experiment` arms the resume again, so the loop picks up where it left off. Treat it as a pause, never as "the loop finished".

Separately, and *not* a stop condition: `before_agent_start` re-reads the Git branch every turn. If the worktree is no longer on the branch recorded for the session, the mode is silently dropped for that turn — widget hidden, tools detached, no autoresearch prompt. Nothing is logged and nothing is announced. A run that appears to stall with no new rows is most often this.

## The iteration cap is per segment, and defaults to none

`max_iterations` on `init_experiment` is the only source of the cap. It is optional; when it is absent the stored `max_iterations` is `null` and **no cap exists**. The loop then runs until a user message, an explicit `off`, or a branch change.

When it is set, `log_experiment` compares it against the number of logged runs **in the current segment** and stops when `segment runs >= max_iterations`. A segment is a baseline epoch within one session: `init_experiment` with `new_segment: true` bumps it, and the count restarts from zero, so the same cap applies again to the new segment. A cap of 20 does not bound a session at 20 runs; it bounds each segment at 20.

Two further consequences worth planning for:

- `max_iterations` is rewritten on **every** `init_experiment` call, including reconfiguration calls. Calling `init_experiment` again without the parameter clears the cap.
- Reaching the cap appends `{ mode: "off" }` and detaches the tools, but does not close the stored session or touch the worktree. `/autoresearch` re-enters the same session and the loop continues.

**A caller who wants a total budget for a session must track it themselves.** Nothing in the subsystem accumulates runs across segments for the purpose of stopping, and nothing counts turns, tokens, or money.

## Tools

All four are declared `defaultInactive`, so they are invisible until the mode is entered, and detached again when it leaves. All except `init_experiment` refuse unless a stored session matches the current Git branch.

| Tool | Contract |
| ---- | -------- |
| `init_experiment` | Opens the session, or reconfigures the open one. Requires `./autoresearch.sh` to exist on the first call and on any `new_segment: true` call. On an `autoresearch/*` branch it auto-commits a dirty tree as the harness commit, then records `HEAD` as the baseline commit. Takes the metric name, unit, direction (`lower` default), secondary metrics, scope and off-limits paths, constraints, and `max_iterations`. |
| `run_experiment` | Runs the harness. The command is fixed at `bash autoresearch.sh` and cannot be overridden; only `timeout_seconds` (default 600; a non-positive value means effectively unbounded) is a parameter. Abandons an earlier unlogged run first, inserts a pending row, streams output to the run log, and parses `METRIC`/`ASI` lines out of it. |
| `log_experiment` | Finalizes the one pending run. Requires `metric`, `status` (`keep`, `discard`, `crash`, `checks_failed`) and `description`. Records modified paths, scope deviations, optional `justification`, and `flag_runs` entries that exclude earlier runs from baseline and best-metric arithmetic. Recomputes a confidence figure (distance from baseline in multiples of the median absolute deviation; `null` with fewer than three usable runs in the segment). |
| `update_notes` | Replaces the session notes (`body`) or appends one bullet under an `## Ideas` heading (`append_idea`). The notes are injected into the system prompt every iteration. |

**Worktree effects of `log_experiment`.** On `keep`, the modified files are staged and committed — but only on an `autoresearch/*` branch; otherwise the commit is skipped with a warning and the changes stay in the worktree. On `discard`, `crash` and `checks_failed` the worktree is reverted. Off an `autoresearch/*` branch the revert is limited to paths the run itself modified, so harness files written before `init_experiment` may not survive it.

## Harness contract

`./autoresearch.sh` in the working directory, invoked as `bash autoresearch.sh`. Its stdout and stderr are captured verbatim to the run log; two line shapes are parsed out of the stream (`ExperimentOutputScanner` in `autoresearch/helpers.ts`):

```text
METRIC <name>=<value>
ASI <key>=<value>
```

- A `METRIC` name matches `[\w.µ-]+` and its value must parse as a finite number; the line must otherwise be the whole line. The metric whose name equals the session's primary metric becomes the run's parsed primary; the rest are secondary metrics. `log_experiment` warns when the metric the model reports differs from the parsed one, and stores both.
- An `ASI` value is free-form metadata: `true`, `false`, `null`, a number, a JSON object/array/string, or otherwise the raw text.
- `__proto__`, `constructor` and `prototype` are rejected as names in both.
- Exit code 0 with no timeout is a passing run. A run cancelled by its timeout is recorded with `timed_out` set, whatever it printed before.

## The results store

`OMP_AUTORESEARCH_DB_DIR` **relocates the directory holding a local SQLite file. It does not select a backend.** `resolveAutoresearchPaths` in `autoresearch/storage.ts` is the only code that reads the variable, and the only thing it does is join the override directory with the project key instead of the default root. There is no interface, no driver registry, and no remote option: `AutoresearchStorage` is a concrete class over `bun:sqlite`, reached through `openAutoresearchStorage` and `openAutoresearchStorageIfExists`.

Layout, per Git repository root (or the working directory when there is no repository), encoded into one path segment as `--<root with separators replaced by ->--`:

| Path | Contents |
| ---- | -------- |
| `<dir>/<project-key>.db` | The SQLite database: sessions and runs. |
| `<dir>/<project-key>/runs/NNNN/benchmark.log` | Captured output of run `NNNN`, zero-padded to four digits. |

`<dir>` is `OMP_AUTORESEARCH_DB_DIR` when set, otherwise `~/.omp/autoresearch` (`getAutoresearchDbPath`, `getAutoresearchProjectDir` in `packages/utils/src/dirs.ts`). The encoding is not collision-free for pathological roots (`/a/b` and `/a-b` collide) and is fixed by compatibility with existing state.

Other properties of the store a caller should know:

- **The file is created lazily.** `openAutoresearchStorageIfExists` returns `null` when the file is absent, and the extension only looks at storage at all once the session's control entries show autoresearch was activated. A session that never touches the mode creates no database.
- **One database per repository root, shared by every session on it.** Sessions are distinguished inside it by the Git branch recorded on the row; `getActiveSessionForBranch` returns the most recent open session for the current branch, treating "no branch" on both sides as a match. Two sessions on the *same* branch and root therefore drive the *same* stored session. `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout = 5000` are set; within one process a module-level cache keyed by database path hands both sessions the same `AutoresearchStorage` instance.
- **The schema is created, never migrated.** The tables are `CREATE TABLE IF NOT EXISTS`, and `PRAGMA user_version` is stamped with `SCHEMA_VERSION` on open. No code reads that version back, so there is no upgrade path today; a future column would have to be additive or handled by new code.
- **Deletion never happens here.** Closing a session sets `closed_at`; abandoning a pending run sets `abandoned_at`; flagging a run sets `flagged`. Rows and run logs accumulate until removed by hand.

### Tables

`sessions` holds one row per experiment session: name, goal, primary metric with unit and direction, preferred command, branch, baseline commit, current segment, `max_iterations`, JSON arrays for scope paths, off-limits paths, constraints and secondary metric names, the notes blob, `created_at` and `closed_at`.

`runs` holds one row per `run_experiment` invocation, keyed to its session with `ON DELETE CASCADE`. It is written in three passes: inserted at start (segment, command, pre-run dirty paths, log path); completed when the process exits (duration, exit code, timeout flag, parsed metrics and ASI); logged when `log_experiment` finalizes it (status, description, metric, commit, modified paths, scope deviations, justification, confidence). A row with `status IS NULL AND abandoned_at IS NULL` is the pending run — there is at most one, and `run_experiment` abandons any earlier one before starting.

Both tables use the SQLite rowid alias `id`. Run ids are the user-visible run numbers and the `run_id` argument of `flag_runs`. Timestamps are epoch milliseconds.

## Clearing

`/autoresearch clear` does four things, and it is the only destructive path:

1. Resets the worktree to the session's baseline commit with `git reset --hard` plus `git clean` — when on an `autoresearch/*` branch, or when `--reset-tree` is passed, and not when `--keep-tree` is passed.
2. Deletes a fixed list of legacy on-disk artifacts from the working directory, **`autoresearch.sh` among them**, together with `autoresearch.md`, `autoresearch.checks.sh`, `autoresearch.program.md`, `autoresearch.ideas.md`, `autoresearch.jsonl`, `autoresearch.config.json` and `.autoresearch/`.
3. Closes the stored session by setting `closed_at`. Rows and run logs are kept; the history remains readable.
4. Appends `{ mode: "clear" }`, which also drops the recorded goal, and detaches the tools.

One asymmetry to be aware of: `clear` closes the most recent still-open session through `getActiveSession`, which is **not** filtered by branch, while every other lookup in the subsystem matches on the current branch.

## See also

- [`OMP_AUTORESEARCH_DB_DIR`](./environment-variables.md) — the directory override, in the environment-variable reference.
- [Extensions](./extensions.md) and [Hooks](./hooks.md) — the `before_agent_start` / `agent_end` machinery the loop is built on.
- [Slash command internals](./slash-command-internals.md) — how `/autoresearch` is dispatched.
