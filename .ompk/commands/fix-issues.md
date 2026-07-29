# Fix Issues Command

Diagnose, reproduce, and (when reproducible) fix open GitHub issues in parallel — each in its own clean worktree, with build artifacts symlinked so nothing recompiles.

## Arguments

- `$ARGUMENTS` — optional. Either:
  - a space- or comma-separated list of issue numbers / URLs, OR
  - GitHub-search qualifiers (`is:open`, `label:bug`, `author:foo`, ...) and/or a relative time window like `3d`, `2w`, `12h`.

If no issues and no flags are passed, default to **all open issues opened in the last 3 days**.

## Steps

### 1. Resolve the issue set

Parse `$ARGUMENTS`.

- If explicit issue numbers/URLs given, use them verbatim.
- Otherwise call the `github` tool with `op: search_issues`. Default (no args):

  ```
  github { op: "search_issues", query: "is:open", since: "3d", limit: 50 }
  ```

  Pass any user-supplied qualifiers verbatim through `query` (combine with `is:open` if not already present). Use `since` for the time window (`3d`, `2w`, `12h`, ISO date — see the `github` tool docs); set `dateField: "updated"` instead of the `created` default only when the user explicitly asks for recently-touched issues.

Print the resolved set before fanning out so the user can confirm scope.

### 2. Fan out one subagent per issue

Use **`task` with parallel subagents** — one task per issue. Pass the issue number, title, body summary, and the workflow below as the assignment. Subagents work in isolation; coordinate via `irc` only when two issues clearly touch the same file.

Each subagent **MUST** follow this exact workflow:

#### a. Read everything

1. Read `issue://<N>` (or `issue://<owner>/<repo>/<N>` for cross-repo) — fetches the issue body plus comments; comments often carry the real repro and fix hints. Append `?comments=0` only if you explicitly want to skip them.
2. `gh search prs` for the issue number to see if a fix is already in flight.
   - If a PR exists and looks reasonable → switch tracks: review that PR per `.omp/commands/review-prs.md` instead, and report back as `existing-pr`. Do **not** open a competing fix.

#### b. Diagnose & try to reproduce — **in the current cwd, on `main`**

Reproduce **here first**, before touching any worktree. The point is to confirm the bug is real on current main before investing in a fix branch.

1. Read the relevant source paths in this checkout. Form a concrete hypothesis (one or two sentences) about the failure.
2. Write a focused test file under the package the bug lives in. Naming: `repro-issue-<N>-<slug>.test.ts` (or `.rs`, etc.) — unique, greppable, deletable.
3. Run **only that test file**, not the suite. Confirm it fails for the reason in the issue.

Outcomes:
- **Reproduced** → continue to (c).
- **Not reproduced** → stop. Delete the test file. Report `unreproduced` with: hypothesis tried, evidence it doesn't fail, and what info would unblock (versions, OS, config, repro snippet from author). Do **not** create a worktree or commit.
- **Out of scope / not a bug** (e.g. user config error, intended behavior, dup) → stop. Report `not-a-bug` with the explanation suitable for posting to the issue.

#### c. Create a worktree off main

Only after a confirmed local repro:

```bash
MAIN="$(git rev-parse --show-toplevel)"
ENC="$(printf '%s' "$MAIN" | sed 's|[/\\:]|-|g')"
WT="$HOME/.omp/wt/${ENC}/fix-issue-<N>"

git -C "$MAIN" fetch origin main
git -C "$MAIN" worktree add -B "fix/issue-<N>" "$WT" origin/main
```

Branch naming: `fix/issue-<N>` (or `fix/issue-<N>-<slug>` if you'll open multiple). Path under `~/.omp/wt/<encoded-main-path>/...` matches the convention `pr_checkout` uses.

#### d. Symlink build artifacts

From the new worktree, link build outputs from `$MAIN` so `bun check` / `cargo build` / native loaders skip rebuilds:

```bash
cd "$WT"
ln -snf "$MAIN/target"       "$WT/target"
ln -snf "$MAIN/node_modules" "$WT/node_modules"

# Only the .node binaries are expensive to rebuild. The rest of
# packages/natives/native/ is tracked by git, so folder-level symlinks would
# shadow real source files and break the fix.
for f in "$MAIN"/packages/natives/native/*.node; do
  [ -e "$f" ] && ln -snf "$f" "$WT/packages/natives/native/"
done
```

Use absolute paths — the worktree lives outside the main checkout.

#### e. Move the repro test in & fix

1. Move (don't copy) the failing test file from the main checkout into the same path inside the worktree. Delete it from main so the original cwd is left clean.
2. Confirm it still fails inside the worktree on the current branch.
3. Implement the fix in source. Match existing patterns (see `AGENTS.md`); fix at the source, not at the symptom; no stubs, no mocks added to product code.
4. Re-run the repro test until it passes.
5. Add or adjust adjacent unit/contract tests where the fix changes a real contract — not just plumbing. Run **only** the affected test files; no full-suite runs from subagents.
6. Run `bun fmt` over the union of files edited.

#### f. Commit

Conventional commit, one logical change per commit, with `Fixes #<N>`:

```bash
git add -A
git commit -m "fix(<scope>): <one-line summary>

<short body explaining root cause and the fix>

Fixes #<N>."
```

Do **not** push. The human pushes / opens the PR.

#### g. Report back

Each subagent returns a short structured report:

```
Issue #<N>  <title>
Status:    fixed | unreproduced | not-a-bug | existing-pr (#<M>)
Repro:     <test path inside worktree>            (if applicable)
Worktree:  ~/.omp/wt/.../fix-issue-<N>            (if created)
Branch:    fix/issue-<N>                          (if created)
Commits:   <shas + one-liners>                    (if any)
Notes:     <root cause in one sentence; or what info is missing>
```

### 3. Aggregate

After all subagents finish, print a single summary table:

```
| # | Title | Status | Branch / Notes |
|---|-------|--------|----------------|
```

Group worktree paths by status (`fixed` first), so the user can `cd` and push the ready ones in one pass.

## Rules

- **MUST** reproduce on `main` in the current cwd **before** creating any worktree. No worktree until repro is confirmed.
- **MUST** use parallel subagents — one per issue.
- **MUST** check for an existing PR first; if one exists and is reasonable, divert to `review-prs` flow instead of duplicating work.
- **MUST** symlink `target`, `node_modules`, and the native `*.node` binaries before any build/test runs in the worktree. **MUST NOT** symlink the whole `packages/natives/native/` directory that would shadow tracked source files.
- **MUST** use conventional commits with `Fixes #<N>` in the body.
- **MUST NOT** push, open PRs, or comment on issues. Human handles delivery.
- **MUST NOT** ship stubs, mocks-as-product-code, or "TODO: implement" placeholders as a fix.
- **MUST NOT** expand scope: fix the reported bug, not adjacent code smells.
- If repro fails, delete the temporary test file from cwd before yielding — leave the original checkout clean.
