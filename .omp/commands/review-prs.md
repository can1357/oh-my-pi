# Review PRs

Parallel PR triage: decide merge-worthiness, prepare rebased worktrees, fix blockers, return them for human merge.

## Arguments

`$ARGUMENTS` optional:
- space/comma-separated PR numbers/URLs; or
- GitHub-search qualifiers (`is:open`, `author:foo`, `label:bug`, `draft:false`, ...) and/or time window (`3d`, `2w`, `12h`).

No PRs or flags: all open PRs opened in last 3 days.

## 1. Resolve PRs

Parse `$ARGUMENTS`. Explicit numbers/URLs: use verbatim. Otherwise `github` `op: search_prs`; no-args default:

```
github { op: "search_prs", query: "is:open", since: "3d", limit: 50 }
```

Pass supplied qualifiers verbatim in `query`; add `is:open` unless present. Time window (`3d`, `2w`, `12h`, ISO date; see `github` docs): `since`. `dateField` defaults `created`; set `"updated"` only on explicit request for recently-touched PRs. Print resolved set before fan-out for scope confirmation.

## 2. One parallel `task` subagent/PR

Assign each PR's number, head ref, author, and workflow. Agents isolate; use `irc` only if a fix on PR A obviously conflicts with PR B.

### Required subagent workflow

#### Read and decide

1. Read `pr://<N>` (comments default; `?comments=0` skips) and `pr://<N>/diff` (changed-file listing). Full unified diff: `pr://<N>/diff/all`; file slice: `pr://<N>/diff/<i>`.
2. Check `git log origin/main` and `gh search prs` for an already-landed equivalent.
3. Decision:
   - `slop`: AI-generated noise, broken, off-spec, or net-negative. Drop; 1–2-line justification; no checkout.
   - `superseded`: fixed/merged in main or newer PR. Drop with pointer.
   - `worthy`: proceed.

Ambiguous: `worthy`; human decides on a real branch.

#### Checkout

```bash
gh_PR=<NUMBER>
# pr_checkout creates ~/.omp/wt/<encoded-repo>/pr-<N>/ and configures push remote
```

MUST use `github pr_checkout`, not raw `gh pr checkout`: it creates a dedicated worktree wired for later `pr_push`.

#### Symlink build artifacts

Before any worktree build/test, from the worktree symlink main-checkout outputs to avoid `bun check` / `cargo build` / native-loader recompilation:

```bash
MAIN="<absolute path to main worktree, e.g. ~/Projects/pi>"
WT="$(pwd)"

# Rust target dir + JS deps (root-level in this monorepo)
ln -snf "$MAIN/target"        "$WT/target"
ln -snf "$MAIN/node_modules"  "$WT/node_modules"

# Prebuilt native addon (avoids 30s+ napi-rs rebuild). Link only the .node
# binaries — the rest of packages/natives/native/ is tracked by git, so
# folder-level symlinks would shadow PR-modified files and break review.
for f in "$MAIN"/packages/natives/native/*.node; do
  [ -e "$f" ] && ln -snf "$f" "$WT/packages/natives/native/"
done
```

Before `pr_checkout`, derive `$MAIN` from original cwd: `git rev-parse --show-toplevel`. Symlinks MUST use absolute paths: worktree is outside main repo; relative paths break. MUST NOT symlink whole `packages/natives/native/`: it shadows tracked PR changes.

#### Rebase

```bash
git fetch origin main
git rebase origin/main
```

Mechanical conflicts (formatting, import order, adjacent edits): resolve, continue. Semantic conflicts: abort, note final report, do not commit.

#### Review and fix

Review for correctness, security, regressions, breaking-change impact, and new-path test coverage. Fix merge blockers only: build/test failure, obvious PR-introduced bugs, or edge cases required by the PR's goal. Do NOT taste-rewrite, unrelated-refactor, or expand scope.

Each fix: read existing patterns; follow `AGENTS.md` conventions; add/update behavior-change tests; run targeted area test files only—no project-wide subagent tests. End with `bun fmt` over union of edited files.

#### Commit

One conventional commit/logical fix atop rebased PR branch:

```bash
git add -A
git commit -m "fix(<scope>): <what & why>

Addresses review feedback on #<PR>."
```

Do NOT amend author commits, push, merge, or force-push author history; human reviews/merges.

#### Report

Return:

```
PR #<N>  <title>
Decision: worthy | slop | superseded
Worktree: ~/.omp/wt/.../pr-<N>   (or: not checked out)
Rebase:   clean | conflicts (resolved | aborted: <reason>)
Fixes:    <commit shas + one-liners>   (or: none needed)
Blockers: <anything the human must decide>
```

## 3. Aggregate

After all agents finish, print:

```
| PR | Title | Decision | Rebase | Fixes | Blockers |
|----|-------|----------|--------|-------|----------|
```

Then worktree paths grouped by decision for `cd` and merge.

## Rules

- MUST use parallel subagents, one/PR; NEVER serial loop.
- `slop`/`superseded`: skip checkout; record decision only.
- Fixes limited to merge blockers in that PR's diff.
- MUST NOT push or merge; human reviews and merges.
