---
title: Atomic Commits
description: Split a working tree into atomic, well-messaged commits with omp commit.
coverage: B
---

`omp commit` generates a Conventional Commit message from your staged changes, optionally splits unrelated changes into separate atomic commits, and updates any detected changelog files. The default flow is an agentic session that reads the diff, proposes a Conventional Commit analysis, and either commits it as a single commit or — when the changes are unrelated — proposes a split plan for you to confirm.

## Running omp commit

```bash
omp commit                # generate and commit
omp commit --dry-run      # preview only
omp commit --push         # commit, then push
omp commit --no-changelog # skip changelog updates
omp commit --legacy       # use the legacy deterministic pipeline
omp commit --context "…"  # pass extra context to the model
omp commit --model "…"    # override model selection
omp commit -c "…" -m "…"  # short flags for --context and --model
omp commit --help
```

If nothing is staged, `omp commit` stages every change in the working tree first. If there really is nothing to commit, it prints `No changes to commit.` and exits.

## Flags

| Flag | Short | Description |
| --- | --- | --- |
| `--push` | — | Push the commit to the remote after committing. |
| `--dry-run` | — | Preview the generated commit message without writing a commit. |
| `--no-changelog` | — | Skip changelog updates. |
| `--legacy` | — | Use the legacy deterministic pipeline instead of the agentic flow. |
| `--context` | `-c` | Additional context for the model. |
| `--model` | `-m` | Override model selection. |
| `--help` | `-h` | Show the help message. |

`--legacy` and `--no-changelog` affect the WHAT (pipeline path and changelog mutation). `--push` runs after the commit is written.

## The agentic flow

The default (non-`--legacy`) path runs an agentic session that:

1. Stages everything if no files are staged.
2. Detects changelog-boundary files (the targets that may need an entry) and any `AGENTS.md` context files in the project.
3. Short-circuits to a fallback single-commit proposal if the diff is trivial (a single-file mechanical change).
4. Otherwise, starts a commit agent session that walks the staged changes and emits a `CommitProposal` describing one Conventional Commit.
5. If the agent proposes multiple commits via `split_commit`, you are prompted to confirm before applying.

The legacy pipeline (when `--legacy` is passed) is a deterministic, single-commit flow: it runs `git diff --cached`, generates a Conventional Analysis (using map-reduce for large diffs), generates a summary (with one retry on validation), formats the commit message, and writes it. Use it when you want a predictable, no-agent commit.

## Map-reduce analysis for large diffs

When the diff is large, the analysis step fans out across files and reduces the observations back into a single Conventional Commit. The trigger is in `shouldUseMapReduce`:

- The map phase runs when the diff has at least `commit.mapReduceMinFiles` (default `4`) non-excluded files, **or** any single file is over `commit.mapReduceMaxFileTokens` tokens (default `50_000`).
- The map phase uses the smol model; the reduce phase uses the primary model.
- Concurrency is bounded by `commit.mapReduceMaxConcurrency` (default `5`).
- The whole analysis is bounded by `commit.mapReduceTimeoutMs` (default `120_000` ms).

Disable map-reduce entirely with the environment variable `PI_COMMIT_MAP_REDUCE=false` (the `commit.mapReduceEnabled` setting is `true` by default).

## Splitting unrelated changes

When the agent decides the staged files are unrelated, it proposes a split plan via the `split_commit` tool. Each item in the plan names one commit with:

- `type` — Conventional Commit type (e.g. `feat`, `fix`, `refactor`).
- `scope` — optional scope.
- `summary` — subject line, validated against `summary` rules (max 72 chars after normalisation).
- `details` — body bullets, capped at `MAX_DETAIL_ITEMS`.
- `changes` — which files and hunks go into this commit; each `hunks` entry is `all`, an `indices` list, or a `lines` range.
- `dependencies` — commit ids that must land first; the agent uses topological ordering to validate the plan.
- `rationale` — optional human-readable explanation.
- `issue_refs` — optional references (e.g. `#123`).

The tool validates the plan before returning it:

- Every file referenced must be in `git diff --cached` (or a detected changelog target).
- No file may appear in more than one commit.
- Every staged file must appear in exactly one commit.
- Hunk selectors must match the recorded diff.
- Dependencies must be satisfiable (topological order must exist).

A valid plan is stored on the agent state (`state.splitProposal`) and surfaced to you. After confirmation, the plan is applied: each commit is written in dependency order, with the agent session still in scope to react to writing failures.

If the agent rejects the plan (no split is needed), a single commit is proposed instead and applied after the same confirmation step.

## Changelog updates

When `--no-changelog` is **not** passed, omp detects changelog-boundary files in the staged set and, after the commit(s) are written, asks the agent to propose changelog entries. Existing unreleased sections are parsed and passed to the proposal so the agent only adds new entries. `commit.changelogMaxDiffChars` (default `120_000`) bounds the diff that is included in the changelog prompt.

## Dry-run

`--dry-run` runs the full pipeline (analysis, summary, changelog proposals) but does not write anything. The generated commit message is printed to stdout instead of committed; changelog proposals are simulated. The exit code is the same as a successful run.

## Pushing

`--push` runs `git push` against the configured remote after the commit is written. The push is unconditional — there is no `--force-with-lease` flag on `omp commit`.

## Sharp edges

- **Staging is implicit.** If `git diff --cached` is empty, `omp commit` stages every change in the working tree. Pre-stage selectively with `git add` if you do not want everything included.
- **Confirmation is terminal.** The split-commit prompt is `y/N` (default `N`). There is no `--yes` flag; pipe answers via the terminal.
- **`--legacy` is single-commit only.** The legacy pipeline does not split — it generates one Conventional Commit. Use the agentic flow (default) for split proposals.
- **Map-reduce is enabled by default.** Set `PI_COMMIT_MAP_REDUCE=false` to force the analysis to run on a single model when the diff is large.
- **Map-reduce costs model calls.** When the trigger fires, every staged file incurs a smol-model call and the reduce phase costs a primary-model call. Concurrency is bounded by `commit.mapReduceMaxConcurrency` (default `5`).
- **Changelog proposals are best-effort.** The agent's proposed changelog entries are written only when `--no-changelog` is not passed and the agent's proposal succeeds. Failures here do not roll back the commit.
