`gh` wrapper: repos, PRs, search, checkout, push, Actions watch. Issue/PR via `issue://<N>`/`pr://<N>`; PR diffs via `pr://<N>/diff` (listing), `pr://<N>/diff/<i>` (file), `pr://<N>/diff/all` (full).

<instruction>
- `repo_view` — omit `repo` to view the current checkout.
- `pr_create` — `head` defaults to the current branch.
- `pr_checkout` — into dedicated git worktrees (not your working tree); pass `pr` array to batch.
- `pr_push` — requires the branch to have been checked out first via `op: pr_checkout`.
- `search_issues`/`search_prs`/`search_commits`/`search_repos` — `query` optional when `since`/`until` set. `search_code` requires `query` and rejects `since`/`until`.
- `search_*` default `repo` to current `owner/repo`; use `repo:`/`org:`/`user:` in `query` to scope. `search_repos` ignores `repo` — use `org:`/`language:`.
- `since`/`until` — relative (`<n>m|h|d|w|mo|y`), `YYYY-MM-DD`, or ISO datetime. `dateField: "updated"` filters update time (issues/PRs) / push time (repos).
- `run_watch` — omit `run` to watch every run for current HEAD. Fast-fails on first job failure.
</instruction>

<output>
Summary per op; `run_watch` failures save full logs to a session artifact.
</output>
