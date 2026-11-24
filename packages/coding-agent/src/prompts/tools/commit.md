Selective commits in a shared worktree: commit only the changes you and your subagents made while other agents and the user keep editing.

The `commit` object exists in JavaScript and Python Eval; it is not a standalone tool.

<instruction>
- Your edit tools (edit, write, ast_edit, conflict resolution, isolated-subagent merges) journal every write. So does the shell (`bash`, eval `sh()`) for what it writes itself: its builtins (`sed -i`, `sd`, `cp`, `mv`, `rm`, `tee`) and redirections (`cat > file <<EOF`, `>> file`), for text files up to 4 MiB that git does not ignore. `commit.draft()` attributes every changed line of the repository (HEAD → worktree) to the agent that wrote it and preselects the lines in scope. What a program you run writes on its own (formatters, codegen, `git`, package managers, scripts) is unrecorded, like the user's own edits, and NEVER preselected. `take` what those wrote: whole files are listed under Unrecorded, lines inside a file you edited show as `left out: unrecorded`, and a rewrite of your own lines (a formatter) comes up under Review.
- Scope (`agents`): omitted → you plus your subagents; `"self"` → your own edits only; `"ParserFix"` or `["ParserFix", "DocsWriter"]` → those subagents, each with its own subagents; `"*"` → every agent of the session.
- Repository (`repo`): omitted → the repository containing the session cwd; a path (relative to the cwd) inside another checkout → that repository, e.g. `commit.draft(repo="../other")`. The draft and its commit stay in that repository.
- The summary lists Selected (`✓` whole file, `◐` part of it), Review (`?`), other agents of the session not in scope, Left out (`·`, deselected in-scope edits), and Unrecorded (`·`, paths changed by other programs or by hand).
- `show(path=None)` lists hunks. Each run of change lines is headed by its unit id (`3b` = hunk 3, unit b; a unit is one actor's lines within a hunk), a mark (`✓` selected, `?` needs review, `·` left out), and its owner. Without a path: every partially selected or review file.
- `take(path=None, *units, grep=None)` / `drop(…)`: `path` is exact, a glob (`packages/tui/**`), or a unique suffix (`CHANGELOG.md` when only one changed). No units → the whole file. `grep` → every unit with a line matching the regex, across all files unless `path` is given. `take("**")` selects every change in the repository, including ones no agent made (the user's own work). `only(*globs)` deselects everything outside the globs; use it to split the work into several commits. When at least one target matches, `only` reports unmatched paths or globs; if none match, it throws naming them and leaves the selection unchanged.
- Binary, non-UTF-8, and large files, symlinks, and mode-only changes (`chmod`) have a single unit `1` and commit whole, as in the worktree. A mode change of a text file goes with its selected lines. Existing initialized submodules with a changed HEAD appear under Review as a single gitlink unit `1`; inspect the old and new SHAs and select explicitly with `take("path")`. Only the pointer is committed, not dirty files inside the submodule. Redraft if its HEAD changes before committing. Submodule additions, deletions, type changes, uninitialized checkouts, and untracked nested repositories remain unsupported.
- `diff()` prints the exact candidate commit against HEAD. A long line edited in place prints once, as `!…kept [-removed-]{+added+} kept…`; the returned patch holds both lines whole.
- `commit(subject, body=None, *, fixes=None, amend=False, no_verify=False)`: one-line subject; body is a string or a list of lines; `fixes=123` appends `Fixes #123`. Builds the commit from a private index on the current HEAD (or as the first commit of a new repository): other agents' staged entries stay staged, the worktree is never touched, and a concurrent commit by someone else is never overwritten (when it changed the same lines the call fails; draft again). Refuses while a merge, cherry-pick, revert, rebase, or `git am` is in progress, or the index has unresolved conflicts; finish or abort the operation or resolve the conflicts first, using plain `git commit` for commits within an operation. Hooks and commit signing run as with `git commit`; `no_verify=True` skips the `pre-commit` and `commit-msg` hooks (only when the user asks). Prints the commit and what remains; the draft then holds what remains, freshly preselected, so keep using it for the next commit. `amend=True` only rewrites a commit this flow made in this session.
- Review reasons: "edits lines added by X that were never committed" means your edit builds on someone's uncommitted lines, so committing yours alone commits part of theirs; "in-scope lines rewritten afterwards by …" means the file no longer holds what you wrote: a formatter or script you ran did that (take the hunk), or someone else did; "the edit record cannot be replayed" means the file's history is lost (oversized or binary content, an older session), so `show(path)` and take your lines yourself. Decide from what you did; ask the user only when you cannot tell.
- Every method is async and prints its result; `silent=True` skips printing. `print(d)` repeats the current summary.
- JavaScript: same names with an options object: `commit.draft({ agents: "self", repo: "../other" })`, `d.take("src/a.ts", { units: ["2a"] })`, `d.commit("fix: …", { body: ["- …"], fixes: 12, noVerify: true })`.
</instruction>

<examples>
```python
d = await commit.draft()
await d.show()  # only when the summary lists ◐ or ? items
await d.take("packages/catalog/src/compat/rules.json")  # regenerated by my `bun run gen:compat`
await d.take("src/editor.ts", "2")  # my lines, reflowed by the formatter I ran
await d.drop("src/editor.ts", "3")
await d.commit("fix(tui): kept the cursor on wrapped lines", ["- Clamped the column after wrapping."], fixes=812)
```

```python
d = await commit.draft("ParserFix")  # one subagent's work only
await d.commit("feat(parser): added the streaming parser")
```

```python
d = await commit.draft()  # several commits from one draft
await d.only("src/parser/**", "test/parser/**")
await d.commit("feat(parser): added the streaming parser", ["- Added `StreamParser`."])
await d.only("docs/**")  # d now holds what remains, preselected again
await d.commit("docs: documented the streaming parser")
```
</examples>

<critical>
NEVER build a commit in a shared worktree with `git add`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, or `git restore`; use `commit`.
</critical>
