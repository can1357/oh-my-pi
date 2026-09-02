---
title: Auto-research
description: Experiment-driven optimization inside a repo — a benchmark harness, init/run/log experiment tools, per-project SQLite storage, branch isolation, and automatic resume.
coverage: B
---

Auto-research turns omp into an experiment-driven optimization loop. In this mode the agent builds a benchmark harness for your repo, then iterates: change code, run the harness, and record the measured result of every attempt. Results are stored per project, each experiment runs on a dedicated git branch, and unfinished runs are picked up automatically.

This is an advanced, experimental feature. It is built in (no setting enables it): `/autoresearch` is always available and the four experiment tools are exposed to the agent while the mode is on. Plan on supervising it — the agent proposes and runs its own experiments within the constraints you give it.

## Enabling the mode

```bash
/autoresearch speed up the fuzz target
```

The first argument is the goal. omp creates (or reuses) a dedicated `autoresearch/*` branch, records the goal, activates the mode, and forwards the goal to the agent. With no argument the mode is enabled without a goal; running `/autoresearch` again while the mode is on turns it off.

| Command | Effect |
| --- | --- |
| `/autoresearch <goal>` | Enable the mode for `<goal>` on a dedicated branch |
| `/autoresearch` | Toggle: disable when on, enable (no goal) when off |
| `/autoresearch off` | Leave the mode; the session and its runs are kept |
| `/autoresearch clear` | Close the session and reset the worktree to the baseline commit |
| `/autoresearch clear --keep-tree` | Close the session without touching the worktree |
| `/autoresearch clear --reset-tree` | Force the baseline reset even outside a dedicated branch |

Mode state is recorded in the session (`autoresearch-control` entries with `mode` and optional `goal`) and restored on resume, so the mode survives restarts and session switches.

## The experiment loop

Autoresearch runs in two phases. Phase 1 is harness setup: the agent inspects the target and writes `./autoresearch.sh` at the working directory — the canonical benchmark entrypoint that must exit 0 on success and print the primary metric as a line like `METRIC <name>=<value>`. It can also print free-form structured metadata as `ASI key=value` lines. Supporting files (benchmark binaries, fixtures, config) are part of the harness baseline and are committed when the session is initialized.

Phase 2 is the iteration loop built from four tools:

| Tool | Purpose |
| --- | --- |
| `init_experiment` | Open or reconfigure the session; snapshot the harness as the baseline. Pass `new_segment: true` to start a fresh baseline within the same session (use it when you intentionally change `autoresearch.sh`). |
| `run_experiment` | Run the fixed command `bash autoresearch.sh`. Output is captured, `METRIC`/`ASI` lines are parsed back to the agent, and the full log is stored. |
| `log_experiment` | Record the outcome of the latest run. On `keep`, modified files are committed; on `discard`/`crash`/`checks_failed`, the worktree is reverted. |
| `update_notes` | Replace the durable session playbook (`body`) or append to the ideas backlog (`append_idea`). Notes are injected into the agent's prompt every iteration. |

`init_experiment` takes the session configuration: `name` and `primary_metric` are required; `goal`, `metric_unit`, `direction` (`lower` or `higher`, default `lower`), `secondary_metrics`, `scope_paths` (expected-to-modify paths), `off_limits`, `constraints`, and `max_iterations` (soft per-segment cap) are optional. When the cap is reached, the mode turns itself off.

`run_experiment` accepts an optional `timeout_seconds` (default 600). The agent streams progress details while the run is in flight, and only a truncated preview of the output is echoed (10 lines / 4 KiB); the complete log is kept on disk.

`log_experiment` requires the primary `metric` value and a `status`; `description` is a short run summary. `metrics` and `asi` record secondary metrics and structured metadata, `justification` is required when keeping a run that touched paths outside `scope_paths`, and `flag_runs` (run id + reason) marks earlier runs as suspect so they are excluded from baseline and best-metric math.

## Dashboard

While the mode is on, the status line shows an `autoresearch` widget: run counts, kept runs, the pending run, and the mode state. `ctrl+x` expands/collapses it and `ctrl+shift+x` opens a scrollable overlay (`j`/`k` or arrows, `pageUp`/`pageDown`, `g`/`G` for top/bottom, `esc` or `q` to close).

## Branch isolation

Each session runs on a dedicated `autoresearch/<goal>-<date>` branch created from a clean worktree. The baseline commit is recorded at `init_experiment`; every `keep` is auto-committed and every `discard`/`crash`/`checks_failed` reverts the iteration's changes without rewinding earlier keeps. Switching off the branch hides the dashboard and detaches the tools but keeps the session — switching back resumes it.

The mode adapts when a dedicated branch is not possible:

- Pure Jujutsu workspaces (`.jj/` without a colocated `.git/`) are rejected — run `jj git init --colocate` first.
- A dirty worktree is refused at start — commit or stash before enabling.
- Outside any git repo, autoresearch runs with a warning and without branch isolation, baseline reset, or auto-commits (`discard` then only reverts files the run modified).

## Storage and resume

Session and run records live in a per-project SQLite database at `~/.omp/autoresearch/<encoded-project>.db` (WAL mode), with run logs under `~/.omp/autoresearch/<encoded-project>/runs/<NNNN>/`. `OMP_AUTORESEARCH_DB_DIR` overrides the base directory. The encoded key is derived from the repo root, so each checkout keeps its own history.

Sessions are keyed to their branch. After a turn ends with a run that was executed but not yet logged and no pending user message, omp automatically triggers a continuation turn ("Continue the autoresearch loop now") so a crashed or interrupted experiment is picked up without intervention.

Autoresearch runs in the main session as a built-in extension ([Extensions](/oh-my-pi/extending/extensions/)); it is not a separate agent like [Subagents](/oh-my-pi/features/subagents/). The experiment tools are active only while the mode is on.
