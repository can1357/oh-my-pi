`gh` op wrapper: repos/files, PRs, stacked PRs, search, checkout, push, Actions watch. Read issue/PR: `issue://<N>`/`pr://<N>`. Stacks: `stack://` (list), `stack://<N>` (one stack). PR diffs: `pr://<N>/diff` (files); `pr://<N>/diff/<i>` (file slice, 1-indexed); `pr://<N>/diff/all` (full).

<instruction>
Select via `op`.
- `repo`: `[host/]owner/repo`; qualify the host for a repo outside the checkout's own GitHub instance.
- `repo_view`: omit `repo` → current checkout.
- `file_read`: read `path` from `repo`; omit `repo` → current checkout, `branch` → default branch.
- `pr_create`: `head` defaults current branch. Prefer `op: stack` when splitting one change into reviewable layers.
- `pr_checkout`: PR(s) → dedicated git worktrees, never working tree; array `pr` batches multiple in one call.
- `pr_push`: requires prior `op: pr_checkout`.
- `stack`: `command` required. Non-interactive: `view` always `--json`; `submit` always `--auto`; `merge` always `--yes`. `init`/`add`/`checkout` need branch, PR, or stack identifiers — never prompt. `view` with `stack` reads the remote Stacks API; without it, views the local `gh stack`. Requires `gh extension install github/gh-stack` for local commands.
- `search_issues`/`search_prs`/`search_commits`/`search_repos`: `query` optional with `since`/`until`; omit for date-only filter. `search_code`: `query` required; rejects `since`/`until`.
- `search_*`: `repo` defaults current checkout's `owner/repo`; search elsewhere with `repo:`/`org:`/`user:` in `query`. `search_repos`: ignores `repo`; scope via `org:`/`language:` in `query`.
- `since`/`until`: relative `<n>` + `m`/`h`/`d`/`w`/`mo`/`y` (e.g. `3d`, `2w`), ISO date `YYYY-MM-DD`, or ISO datetime. `dateField: "updated"`: update time (issues/PRs), push time (repos), never creation.
- `run_watch`: omit `run` → every run for current HEAD; `branch` defaults current. Fast-fails first job failure.
</instruction>

<output>
Concise summary per op. `run_watch` failures save full logs to a session artifact.
</output>

<critical>
GitHub-hosted repository file: MUST use `file_read`; NEVER `curl`/`wget`.
</critical>
