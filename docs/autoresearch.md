# Autoresearch

Autoresearch turns a session into an autonomous optimization loop: the agent writes a benchmark harness, runs it, logs the measured metric, changes code, and runs it again, until something stops it. It is a built-in extension (`packages/coding-agent/src/autoresearch/`, factory `createAutoresearchExtension`), registered by `sdk.ts` into every session that is not tool-restricted. It contributes a `/autoresearch` command, four tools, a dashboard widget, two turn hooks, and session-lifecycle hooks that rehydrate its state. It is not a background daemon: every iteration is an ordinary agent turn in the session you started it from.

This page states the contract — what the mode guarantees, what it does not, and where its state lives. The prompt templates in `packages/coding-agent/src/autoresearch/` (`prompt-setup.md`, `prompt.md`, `resume-message.md`, `command-resume.md`) are the instructions handed to the model; they are not a specification of the mechanism.

## Activation

| Input | Effect |
| ----- | ------ |
| `/autoresearch <goal>` | Enter the mode with `<goal>` recorded. On a fresh session the goal text is also submitted as the first user message. |
| `/autoresearch` | Leave the mode when on. When off, enter it: with no goal if no stored session matches the current branch, otherwise resuming that session and keeping its recorded goal. |
| `/autoresearch off` | Leave the mode. |
| `/autoresearch clear [--keep-tree\|--reset-tree]` | Close the session and reset (see [Clearing](#clearing)). |
| `Ctrl+X`, `Ctrl+Shift+X` | Toggle the dashboard widget and open its overlay. Display only. |

Entering appends an `autoresearch-control` session entry (`{ mode, goal? }`) and attaches the four tools; leaving appends the same entry with `mode: "off"`, carrying the goal when one is set, and detaches them. Those entries are the durable record: `reconstructControlState` replays them on `session_start`, `session_switch`, `session_branch`, and `session_tree`, so the mode survives a resume.

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

The loop itself is the `agent_end` hook. When a turn ends with the mode on, the hook sends `resume-message.md` as a hidden message (`customType: "autoresearch-resume"`, `display: false`, delivered as the next turn with `triggerTurn`). It sends it when the turn armed a resume — `init_experiment`, `run_experiment` and `log_experiment` all arm it — or when a completed run is still unlogged and no resume was already sent for that run. One iteration is therefore: edit, `run_experiment`, `log_experiment`, `agent_end`, hidden resume message, next turn.

## Stop conditions

The loop runs on while something arms it, so it ends whenever nothing does. Three conditions end it deliberately, in this precedence order. Autoresearch itself adds no judge, no verdict model, and no budget of its own — no token, cost, or wall-clock accounting. Ordinary session-wide limits (the session cost gate, `--max-time`) still apply, and `run_experiment` has its own per-run timeout (`timeout_seconds`, default 600) that bounds one benchmark run rather than the loop.

| Precedence | Condition | Terminal? |
| ---------- | --------- | --------- |
| 1 | **Pending user input.** `agent_end` checks `ctx.hasPendingMessages()` before anything else and returns without re-prompting. | **No** |
| 2 | **Iteration cap reached** for the current segment, checked in `log_experiment` after the run is recorded. | Yes, until re-enabled |
| 3 | **Explicit `off` or `clear`.** | Yes |

**Pending user input is non-terminal.** It disarms the resume for that turn only; the mode stays on, the tools stay attached, and the next `log_experiment` arms the resume again, so the loop picks up where it left off. Treat it as a pause, never as "the loop finished".

A fourth, quieter way to stop is simply that a turn armed nothing: `agent_end` also returns without re-prompting when no tool armed a resume and there is no newly completed run awaiting a log. A turn that only reads code, or that ends after a resume was already sent for the pending run, does not schedule another one.

## Changing branch

**Changing branch does not stop the loop, but it does break it.** Autoresearch is not disabled and its tools are not detached. Both hooks resolve the most recent open experiment for the current branch through `getActiveSessionForBranch`, so what happens next depends on the destination. If the destination branch has no open experiment, the agent receives the Phase 1 setup prompt as if nothing had ever been opened, and `run_experiment`, `log_experiment` and `update_notes` all answer `Error: no active autoresearch session for the current branch`; an already-armed resume can still be sent once, after which the loop goes quiet. If the destination branch has its own open experiment, the hooks and the tools use **that** experiment instead. Checking out the recorded branch restores its experiment on the next turn. The guard that was meant to detach the tools on a branch change (`onActiveBranch` in `before_agent_start`) compares the found session's branch against the current one, and the lookup has already filtered on that branch, so it never fires. Nothing is logged and nothing is announced either way, which makes this an easy cause to miss for a loop that appears to stall with nothing recorded.

Three details sharpen that.

**The two branch readers cannot disagree.** The hooks read the branch through `vcs.repo().label()` and the three tools through `vcs.git().currentBranch()`; in a Git checkout both resolve to the same `current_branch`, detached HEAD included. They would diverge only for a Jujutsu workspace, which `ensureAutoresearchBranch` refuses outright, and a colocated jj+git checkout resolves to Git for both. The duplication is a trap for a future change to either reader, not a live defect.

**A detached HEAD is the no-experiment case.** Both readers still agree there: both report no branch. The lookup then falls to the `branch IS NULL` arm, which never matches an experiment opened on a named branch.

**The off-branch agent can open a second experiment.** Handed Phase 1, it may do as Phase 1 asks and call `init_experiment`, which opens a **second** stored session against the new branch in the same database while the first stays open.

Branch handling is the least obvious part of this subsystem, and the part most worth measuring rather than reasoning about: three separate places decide which experiment a turn belongs to — the branch reader, the branch-filtered lookup, and the `onActiveBranch` guard that the lookup makes unreachable — and the prompt and tool error strings do not distinguish "no experiment yet" from "an experiment you have walked away from". A change here should be exercised against a real repository on each of the cases above, not inferred from the call sites.

## The iteration cap is per segment, and defaults to none

`max_iterations` on `init_experiment` is the only source of the cap. It is optional; when it is absent the stored `max_iterations` is `null` and **no cap exists**. The loop then runs until a user message, an explicit `off`, or a turn that arms nothing.

When it is set, `log_experiment` compares it against the number of logged runs **in the current segment** and stops when `segment runs >= max_iterations`. A segment is a baseline epoch within one session: `init_experiment` with `new_segment: true` bumps it, and the count restarts from zero, so a cap supplied again on that call applies afresh to the new segment. A cap of 20 does not bound a session at 20 runs; it bounds each segment at 20.

Two further consequences worth planning for:

- `max_iterations` is rewritten on **every** `init_experiment` call, including reconfiguration calls. Calling `init_experiment` again without the parameter clears the cap — including a `new_segment: true` call, which therefore carries no cap forward unless it supplies one.
- Reaching the cap appends `{ mode: "off" }` and detaches the tools, but does not close the stored session or touch the worktree. `/autoresearch` re-enters the same session — but the segment's run count is unchanged, so the very next logged run trips `segment runs >= max_iterations` again. Re-entry buys **one run at a time** until `new_segment: true` or a new cap changes the arithmetic.

**A caller who wants a total budget for a session must track it themselves.** Nothing in the subsystem accumulates runs across segments for the purpose of stopping, and nothing counts turns, tokens, or money.

## Tools

All four are declared `defaultInactive`, so they are invisible until the mode is entered, and detached again when it leaves. All except `init_experiment` refuse unless a stored session matches the current Git branch.

| Tool | Contract |
| ---- | -------- |
| `init_experiment` | Opens the session, or reconfigures the open one. Requires `./autoresearch.sh` to exist on the first call and on any `new_segment: true` call — and only on those calls does it auto-commit a dirty tree as the harness commit, and only on an `autoresearch/*` branch; a failed commit warns and continues. The baseline commit is set to `HEAD` when the session is opened and rewritten only by `new_segment: true`; a plain reconfiguration leaves it alone. Takes the metric name, unit, direction (`lower` default), secondary metrics, scope and off-limits paths, constraints, and `max_iterations`. |
| `run_experiment` | Runs the harness. The command is fixed and cannot be overridden; only `timeout_seconds` (default 600; a non-positive value means effectively unbounded) is a parameter. Abandons an earlier unlogged run first, inserts a pending row, streams output to the run log, and parses `METRIC`/`ASI` lines out of it. |
| `log_experiment` | Finalizes the one pending run. Requires `metric`, `status` (`keep`, `discard`, `crash`, `checks_failed`) and `description`. Records modified paths, scope deviations, optional `justification`, and `flag_runs` entries that exclude earlier runs from baseline and best-metric arithmetic. Recomputes a confidence figure (distance from baseline in multiples of the median absolute deviation; `null` with fewer than three usable runs in the segment). |
| `update_notes` | Replaces the session notes (`body`) or appends one bullet under an `## Ideas` heading (`append_idea`). The notes are injected into the system prompt every iteration. |

**Worktree effects of `log_experiment`.** On `keep`, the modified files are staged and committed — but only on an `autoresearch/*` branch; otherwise the commit is skipped with a warning and the changes stay in the worktree. `discard`, `crash` and `checks_failed` revert, and the two branches differ in what they reach: on an `autoresearch/*` branch `revertFailedExperiment` runs `git reset --hard HEAD` plus `git clean`, which throws away every tracked change and every non-ignored untracked file in the worktree — an uncommitted `autoresearch.sh` included, the exposure when `init_experiment`'s harness auto-commit failed. Ignored files and nested repositories survive it, because `clean` is called with its default options. Off an `autoresearch/*` branch the revert instead goes through `computeRunModifiedPaths`, which skips every path that was already dirty before the run, so files written before `run_experiment` started — the harness among them — are precisely the ones it leaves alone, and a user's unrelated edits are safe for the same reason.

The setup prompt's own `baseline_warning` string still states the opposite of that last sentence: it tells the agent that off-branch "`log_experiment discard` will only revert run-modified files … so harness files written before `init_experiment` may not survive a discard". The code is as described above; the warning is stale, and a reader who meets both should follow the code.

**Scope, off-limits, constraints and the reported status are records, not gates.** Nothing blocks an edit. `log_experiment` commits a kept run first and appends the scope-deviation warning afterwards; it does not refuse a `keep` because a path is off-limits, because the benchmark exited non-zero, or because the metric disagrees with the parsed one. Constraints are weaker still: `init_experiment` stores them and `buildExperimentState` carries them, but nothing supplies them to the iteration template and `prompt.md` never renders them, so they are recorded and never replayed. Notes are replayed, every iteration. The agent chooses the status, so a wrong status is recorded, not detected.

## Harness contract

`./autoresearch.sh` in the working directory. `run_experiment` records the command as `bash autoresearch.sh` and runs exactly that everywhere except Windows, where `resolveHarnessExecLine` substitutes the resolved host POSIX shell (`<shell> autoresearch.sh`) when there is one, so that a bare `bash` does not resolve to the WSL launcher. The recorded command still reads `bash autoresearch.sh`.

Standard output and standard error are captured to the run log, but not byte for byte: both streams pass through the shared `OutputSink`, whose `push` normalizes carriage returns to newlines and runs `sanitizeText` over each chunk before anything is written. Colour escapes and CR-based progress redraws do not survive into `benchmark.log`. Two line shapes are parsed out of the same stream (`ExperimentOutputScanner` in `autoresearch/helpers.ts`):

```text
METRIC <name>=<value>
ASI <key>=<value>
```

- A `METRIC` name matches `[\w.µ-]+` and its value must parse as a finite number. The separator after the keyword is `\s+`, which may include a newline, so `METRIC` on one line and `name=value` on the next is accepted — the streaming scanner holds the keyword back deliberately for this. The metric whose name equals the session's primary metric becomes the run's parsed primary; the rest are secondary metrics. A repeated name keeps the last value. `log_experiment` warns when the metric the model reports differs from the parsed one, and stores both.
- An `ASI` value is free-form metadata: `true`, `false`, `null`, a number, a JSON object/array/string, or otherwise the raw text.
- `__proto__`, `constructor` and `prototype` are rejected as names in both.
- Exit code 0 with no timeout is a passing run. A run cancelled by its timeout is recorded with `timed_out` set, whatever it printed before.

## The results store

`OMP_AUTORESEARCH_DB_DIR` **relocates the directory holding a local SQLite file. It does not select a backend.** `resolveAutoresearchPaths` in `autoresearch/storage.ts` is the only code that reads the variable, and the only thing it does is join the override directory with the project key instead of the default root. There is no driver registry and no remote option: `AutoresearchStorage` is a concrete class over `bun:sqlite`, reached through `openAutoresearchStorage` and `openAutoresearchStorageIfExists`.

**Set it to an absolute path with no surrounding whitespace.** The value is passed straight to `path.join`: unlike the neighbouring overrides in the environment-variable reference it is not trimmed, `~` is not expanded, and it need not be absolute. Three other spellings, each measured against this code:

- A **relative** value such as `bench-db` puts the database and the artifact directory in the same tree under the process working directory, and a later process finds them.
- A value beginning with a **literal tilde** does the same under a directory named `~`; nothing is created at the home-expanded path. In a shell that takes `OMP_AUTORESEARCH_DB_DIR='~/bench-db'`, since an unquoted `~/bench-db` is expanded before omp sees it.
- A **leading space** separates the two halves of the open, because trimming turns an otherwise-relative path into an absolute one. `mkdirSync` creates the directory under a path component that is a single space, while SQLite opens the whitespace-trimmed path: with no directory there the open fails with `unable to open database file`; with one, it succeeds there instead. The database then sits at the trimmed path while `storage.projectDir` keeps the space, so run logs and the database land in different trees, and `fs.existsSync(dbPath)` — the probe in `openAutoresearchStorageIfExists` — finds nothing. The two hooks and `run_experiment`, `log_experiment` and `update_notes` then behave as though no experiment existed, which is worse than it sounds: the hooks hand the agent the Phase 1 setup prompt, and the obedient next step is `init_experiment`, which goes through `openAutoresearchStorage` instead. That has no existence probe, so it opens the trimmed path, finds the stored session through `getActiveSessionForBranch`, skips the harness requirement, and **rewrites the goal, cap, scope, off-limits, constraints and metric definition of the experiment that was already there**, abandoning any pending run. `/autoresearch clear` likewise finds that session through `getActiveSession` and closes it, and resets the worktree when the conditions in [Clearing](#clearing) are met. Either call repopulates the cache under the untrimmed key, so the probing readers find the database again for the rest of that process.

No validation rejects any of these values and nothing reports the divergence, so treat the third as a defect rather than a quirk.

Layout, per Git repository root (or the working directory when there is no repository), encoded into one path segment as `--<root with separators replaced by ->--`:

| Path | Contents |
| ---- | -------- |
| `<dir>/<project-key>.db` | The SQLite database: sessions and runs. |
| `<dir>/<project-key>/runs/NNNN/benchmark.log` | Captured output of run `NNNN`, zero-padded to four digits. |

`<dir>` is `OMP_AUTORESEARCH_DB_DIR` when set, otherwise the `autoresearch` subdirectory of omp's state root — `~/.omp/autoresearch` by default, but a named profile or an existing XDG state root moves it (`getAutoresearchDbPath`, `getAutoresearchProjectDir` in `packages/utils/src/dirs.ts`). The encoding is not collision-free for pathological roots (`/a/b` and `/a-b` collide) and is fixed by compatibility with existing state.

Other properties of the store a caller should know:

- **The file is created lazily.** `openAutoresearchStorageIfExists` returns `null` when the file is absent, and the extension only looks at storage at all once the session's control entries show autoresearch was activated. A session that never touches the mode creates no database — with one exception: `/autoresearch clear` opens storage through `openAutoresearchStorage`, which creates the directory and the file even when there was nothing to clear.
- **One database per effective state root and repository root, shared by every session on it.** Sessions are distinguished inside it by the Git branch recorded on the row; `getActiveSessionForBranch` returns the most recent open session for the current branch, treating "no branch" on both sides as a match. Two sessions on the *same* branch and root therefore drive the *same* stored session. `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout = 5000` are set; within one process a module-level cache keyed by database path hands both sessions the same `AutoresearchStorage` instance. Nothing beyond that arbitrates between concurrent sessions, and the subsystem makes no concurrency guarantee.
- **The schema is created, never migrated.** The tables are `CREATE TABLE IF NOT EXISTS`. The constructor reads `PRAGMA user_version` and raises it to `SCHEMA_VERSION` when it is lower, leaving a higher version untouched; that read decides only whether to stamp, and nothing branches on an older value. There is no upgrade path today, so a future column would have to be additive or handled by new code.
- **Deletion never happens here.** Closing a session sets `closed_at`; abandoning a pending run sets `abandoned_at`; flagging a run sets `flagged`. Rows and run logs accumulate until removed by hand.
- **The storage module is exported; its schema is not a contract.** `@oh-my-pi/pi-coding-agent/autoresearch/storage` is a package export, so `AutoresearchStorage` and its `listRuns` / `listLoggedRuns` readers can be imported rather than opening the file by hand. Nothing versions that schema for outside consumers, though — `user_version` is only ever raised to the current value, never used to migrate — so treat both the class and the table shape as moving targets.

### Tables

`sessions` holds one row per experiment session: name, goal, primary metric with unit and direction, preferred command, branch, baseline commit, current segment, `max_iterations`, JSON arrays for scope paths, off-limits paths, constraints and secondary metric names, the notes blob, `created_at` and `closed_at`.

`runs` holds one row per `run_experiment` invocation, keyed to its session with `ON DELETE CASCADE`. It is written in three passes: inserted at start (segment, command, pre-run dirty paths, log path); completed when the process exits (duration, exit code, timeout flag, parsed metrics and ASI); logged when `log_experiment` finalizes it (status, description, metric, commit, modified paths, scope deviations, justification, confidence). A row with `status IS NULL AND abandoned_at IS NULL` is the pending run. Used sequentially there is at most one: `run_experiment` abandons any earlier one before inserting its own. That is not enforced by a constraint or a transaction, and awaits separate the abandon from the insert, so two overlapping `run_experiment` calls can leave two pending rows in one session.

Both tables use the SQLite rowid alias `id`. Run ids are the user-visible run numbers and the `run_id` argument of `flag_runs`. Timestamps are epoch milliseconds.

## Clearing

`/autoresearch clear` is the deliberate reset: it closes the experiment and resets the session's runtime state, and the stored history survives it. It is also **not** the only destructive path — `log_experiment` with `discard`, `crash` or `checks_failed` reverts the worktree too, and on an `autoresearch/*` branch that revert is a `git reset --hard HEAD` plus `git clean`. Clear does four things:

1. Resets the worktree to the session's baseline commit with `git reset --hard` plus `git clean` — when on an `autoresearch/*` branch, or when `--reset-tree` is passed, and not when `--keep-tree` is passed. With no baseline recorded it warns and skips the reset.
2. Deletes a fixed list of legacy on-disk artifacts from the working directory, **`autoresearch.sh` among them**, together with `autoresearch.md`, `autoresearch.checks.sh`, `autoresearch.program.md`, `autoresearch.ideas.md`, `autoresearch.jsonl`, `autoresearch.config.json` and `.autoresearch/`. `--keep-tree` suppresses the Git reset, not these deletions.
3. Closes the stored session by setting `closed_at`. Rows and run logs are kept; the history remains readable.
4. Appends `{ mode: "clear" }`, which also drops the recorded goal, and detaches the tools.

**`clear` picks its session without regard to branch, and that looks like a defect.** It closes the most recent still-open session through `getActiveSession`, so on one branch it can reset the worktree to another branch's baseline and close that other session. Every other lookup in the subsystem goes through `getActiveSessionForBranch`; nothing in the code or its comments suggests this one was meant to be the exception, and the consequence it carries — a hard reset against a baseline belonging to work you are not on — is the most destructive in the subsystem.

## See also

- [`OMP_AUTORESEARCH_DB_DIR`](./environment-variables.md) — the directory override, in the environment-variable reference.
- [Sessions](./session.md) — the `autoresearch-control` session entry this mode records and replays.
- [Extensions](./extensions.md) and [Hooks](./hooks.md) — the `before_agent_start` / `agent_end` machinery the loop is built on.
- [Slash command internals](./slash-command-internals.md) — how `/autoresearch` is dispatched.
