# Review PRs Command

Triage incoming pull requests in parallel: decide what's worth merging, prep clean rebased worktrees, fix any blockers, and hand them back ready for human merge.

## Arguments

- `$ARGUMENTS` — optional. Either:
  - a space- or comma-separated list of PR numbers / URLs, OR
  - GitHub-search qualifiers (`is:open`, `author:foo`, `label:bug`, `draft:false`, ...) and/or a relative time window like `3d`, `2w`, `12h`.

If no PRs and no flags are passed, default to **all open PRs opened in the last 3 days**.

## Steps

### 1. Resolve the PR set

Parse `$ARGUMENTS`.

- If explicit PR numbers/URLs given, use them verbatim.
- Otherwise call the `github` tool with `op: search_prs`. Default (no args):

  ```
  github { op: "search_prs", query: "is:open", since: "3d", limit: 50 }
  ```

  Pass any user-supplied qualifiers verbatim through `query` (combine with `is:open` if not already present). Use `since` for the time window (`3d`, `2w`, `12h`, ISO date — see the `github` tool docs); set `dateField: "updated"` instead of the `created` default only when the user explicitly asks for recently-touched PRs.

Print the resolved set before fanning out so the user can confirm scope.

### 2. Fan out one subagent per PR

Use **`task` with parallel subagents** — one task per PR. Pass the PR number, head ref, author, and the workflow below as the assignment. Each subagent works in isolation; they coordinate via `irc` only if a fix on PR A would obviously conflict with PR B.

Each subagent **MUST** follow this exact workflow:

#### a. Read & decide

1. Read `pr://<N>` (with comments by default; append `?comments=0` to skip) and `pr://<N>/diff` for the changed-files listing — use `pr://<N>/diff/all` when you need the full unified diff, or `pr://<N>/diff/<i>` for a single file slice.
2. Check `git log origin/main` and `gh search prs` for whether the same change already landed.
3. Classify into one of:
   - **slop** — AI-generated noise, broken, off-spec, or net-negative. Drop, write a 1–2 line justification, do not check out.
   - **superseded** — already fixed/merged in main or by a newer PR. Drop with a pointer.
   - **worthy** — proceed.

Anything ambiguous defaults to `worthy` — let the human decide on a real branch.

#### b. Check out into a worktree

```bash
gh_PR=<NUMBER>
# pr_checkout creates ~/.omp/wt/<encoded-repo>/pr-<N>/ and configures push remote
```

Use the `github pr_checkout` tool, **not** raw `gh pr checkout`. That gives a dedicated worktree wired up for `pr_push` later.

#### c. Symlink build artifacts (skip native rebuilds)

From inside the new worktree, link the heavy build outputs from the main checkout so `bun check` / `cargo build` / native loaders do not recompile:

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

Resolve `$MAIN` from the original cwd before `pr_checkout` (`git rev-parse --show-toplevel`). Use absolute paths in symlinks; the worktree lives outside the main repo so relative paths break.

#### d. Rebase onto main

```bash
git fetch origin main
git rebase origin/main
```

If the rebase conflicts:
- Resolve trivially mechanical conflicts (formatting, import order, adjacent-line edits) and continue.
- Anything semantic → abort the rebase, leave a note in the final report, do not commit.

#### e. Review & fix critical issues

Inside the worktree, review the diff with the lens of: correctness, security, regressions, breaking-change impact, test coverage of the new path.

Only fix things that **block merge**: build/test breakage, obvious bugs introduced by the PR, missing edge-case handling the PR's own goal demands. Do **not** rewrite for taste, refactor unrelated code, or expand scope.

For every fix:
- Read existing patterns first; match repo conventions (see `AGENTS.md`).
- Add or update tests for the actual behavior change.
- Run only the targeted test file(s) for the area touched. No project-wide test runs from subagents.

Format/lint at the end with `bun fmt` over the union of files you edited.

#### f. Commit

One conventional commit per logical fix on top of the rebased PR branch:

```bash
git add -A
git commit -m "fix(<scope>): <what & why>

Addresses review feedback on #<PR>."
```

Do **not** amend the PR author's commits. Do **not** push — the human merges.

#### g. Report back

Each subagent returns a short structured report:

```
PR #<N>  <title>
Decision: worthy | slop | superseded
Worktree: ~/.omp/wt/.../pr-<N>   (or: not checked out)
Rebase:   clean | conflicts (resolved | aborted: <reason>)
Fixes:    <commit shas + one-liners>   (or: none needed)
Blockers: <anything the human must decide>
```

### 3. Aggregate

After all subagents finish, print a single summary table:

```
| PR | Title | Decision | Rebase | Fixes | Blockers |
|----|-------|----------|--------|-------|----------|
```

Followed by the worktree paths grouped by decision, so the user can `cd` and merge in one go.

## Rules

- **MUST** use parallel subagents — one per PR — not a serial loop.
- **MUST** use `github pr_checkout` (carries push metadata) — not raw `gh pr checkout`.
- **MUST** symlink `target`, `node_modules`, and the native `*.node` binaries before any build/test runs in the worktree. **MUST NOT** symlink the whole `packages/natives/native/` directory that would shadow tracked PR changes.
- **MUST NOT** push or merge. Human reviews and merges.
- **MUST NOT** expand scope: fixes are limited to merge blockers on this PR's diff.
- **MUST NOT** force-push over the PR author's history.
- If a PR is `slop`/`superseded`, skip checkout entirely — just record the decision.
