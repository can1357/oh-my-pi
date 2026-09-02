---
title: GitHub Integration
description: GitHub operations and the pr:// and issue:// URL schemes.
coverage: B
---

omp talks to GitHub through the `github` tool, which dispatches `gh` CLI calls and surfaces results as `pr://` and `issue://` URLs. The tool is automatically available when `gh` is on your `PATH`; otherwise it is skipped on start. Authentication is delegated to `gh` — `gh auth login` is the only setup step.

## Auth

`gh` must be installed and authenticated. `github` reads `gh`'s local credential fingerprint, scopes its cache by that fingerprint, and shells out for every network call. If you are not authenticated, the tool reports `GitHub CLI is not authenticated. Run \`gh auth login\`.`. If a command needs a repo context and none is available from the current checkout, it reports `GitHub repository context is unavailable. Pass \`repo\` explicitly or run the tool inside a GitHub checkout.`.

## Operations

The `github` tool dispatches by `op`. Each op takes only the fields it needs; unused fields are ignored.

| `op` | What it does | Key required fields |
| --- | --- | --- |
| `repo_view` | `gh repo view` summary (description, branches, visibility, languages, stars, forks). | `op` |
| `pr_create` | `gh pr create` with `--title`/`--body`/`--base`/`--head`/`--draft`/`--fill`/`--reviewer`/`--assignee`/`--label`. | `op` plus either `title` or `fill=true` |
| `pr_checkout` | Checks out one or more PRs into `~/.omp/wt/<number>-<repo-hash>` worktrees, each on a local branch `pr-<number>`. | `op` |
| `pr_push` | Pushes the current `pr-<number>` branch using the metadata written by `pr_checkout`. | `op` |
| `search_issues` | `gh api /search/issues` with `is:issue`. | `op` |
| `search_prs` | `gh api /search/issues` with `is:pr`. | `op` |
| `search_code` | `gh api /search/code` (with `text-match` headers). | `op`, `query` |
| `search_commits` | `gh api /search/commits` (always uses `committer-date`). | `op` |
| `search_repos` | `gh api /search/repositories`. | `op` |
| `run_watch` | Polls a GitHub Actions run (by id or URL) or the runs for a branch commit, live. | `op` |

`repo` is an `owner/repo` override for any op that accepts it (default for `search_issues`/`search_prs`/`search_code`/`search_commits` is the current checkout's `owner/repo`, suppressed when the query already carries a `repo:`/`org:`/`user:`/`owner:` qualifier).

### Pull request lifecycle

`pr_checkout` lands each PR into a dedicated worktree under `~/.omp/wt/`. The branch name is always `pr-<number>`. Existing worktrees are detected by the `refs/heads/pr-<number>` ref; if that branch is already at a different commit, `pr_checkout` fails unless `force=true`, in which case it forces the branch to the PR head. Cross-repo PRs are supported: the tool resolves a clone URL for the head repo, reuses an existing remote with the same URL when possible, or creates one named `fork-<owner>` (with a `-2`/`-3` suffix when that name conflicts). Push metadata is written to git-config under the primary repo:

```text
branch.pr-<number>.remote
branch.pr-<number>.merge
branch.pr-<number>.pushRemote
branch.pr-<number>.ompPrHeadRef
branch.pr-<number>.ompPrUrl
branch.pr-<number>.ompPrIsCrossRepository
branch.pr-<number>.ompPrMaintainerCanModify
```

`pr_push` reads those config keys and pushes with git (not `gh`). It maps the local branch to the recorded `ompPrHeadRef` so the PR head stays in sync. `pr_push` is the only path that can push for a `pr-<number>` branch, and it is intentionally metadata-driven, not generic.

`pr_create` shells out once and writes non-empty bodies to a temp file `gh-pr-body-*` passed as `--body-file`. After creation it best-effort re-reads the PR for a richer summary; failures there are swallowed.

### Actions run watching

`run_watch` is the only streaming op. It emits a final text result plus repeated `onUpdate` snapshots while polling. Two modes:

- **Run mode** (`run` supplied) — polls the run by id or full URL. URL `repo` must match an explicit `repo` when both are present.
- **Commit mode** (`run` omitted) — resolves the latest runs for the branch's commit, polls all of them together, and emits a clear message after `90` seconds if no runs ever appear.

Poll cadence is `3` seconds for the first `60` seconds, then `15` seconds. Up to `5` consecutive rate-limited poll failures are retried at the slow interval. Commit mode double-checks success: once all observed runs are green, the tool waits one more poll interval and succeeds only if the run-id set is unchanged — late workflows for the same commit are then included. On failure, `run_watch` saves the full failed-job logs to a session artifact (`<artifact-dir>/<id>.github.log`) and appends `Full failed-job logs: artifact://<id>` to the result. The inline result includes only the last `tail` lines per failed job (default `15`, max `200`).

## URL schemes

`pr://` and `issue://` are read-only internal URL schemes backed by `gh` and a shared SQLite cache. Both share `~/.omp/cache/github-cache.db` (override with `OMP_GITHUB_CACHE_DB`).

`pr://` URLs:

```text
pr://<owner>/<repo>/<number>          // single PR summary
pr://<owner>/<repo>/<number>/diff     // list of changed files
pr://<owner>/<repo>/<number>/diff/<i> // slice of one file
pr://<owner>/<repo>/<number>/diff/all // full unified diff
pr://<owner>/<repo>/<number>/<path>   // extracted JSON field (query string supported)
```

A bare `pr://owner/repo` opens a list view for the repo. `query` params: `state` (`open`/`closed`/`all`), `limit`, `author`, `label` — all forwarded to `gh`.

`issue://` URLs follow the same scheme (`issue://<owner>/<repo>/<number>`) and accept the same `state`/`limit`/`author`/`label` params.

The cache retains rendered Markdown plus the raw JSON payload returned by `gh`, including private bodies, comments, reviews, and review comments when comments are enabled. Rows are scoped by the local GitHub credential fingerprint.

### Cache settings

| Setting | Default | Description |
| --- | --- | --- |
| `github.cache.enabled` | (see settings) | Toggle the SQLite cache. |
| `github.cache.softTtlSec` | (see settings) | Soft TTL — re-render from cache before this. |
| `github.cache.hardTtlSec` | (see settings) | Hard TTL — force a fresh `gh` fetch after this. |

Past the hard TTL, the next read re-fetches with `gh`. Within the soft TTL, `gh` is not called at all. Between the soft and hard TTL, the cache is still used but the URL is stale and a warning may be surfaced. `pr_push` eagerly invalidates the cached `pr://` rows for the pushed PR so the next `pr://` read reflects the new head.

## Limits

- `search_*` default `limit` is `10`, max `50`; `limit` must be `> 0`.
- `run_watch` `tail` defaults to `15`, max `200`; `tail` must be `> 0`.
- PR review comments page size is `100`; Actions jobs page size is `100`.
- `pr_checkout` batch fan-out is unbounded in tool code; all requested PRs are launched with `Promise.allSettled()` so individual failures surface as a partial result instead of aborting the batch.
- PR diff listings show the first `50` files only.

## Sharp edges

- **Repository scoping for searches.** `repo` is not used for `search_repos` — repository scoping must be expressed in the query. For other searches, an unqualified `repo` defaults to the current checkout's `owner/repo` when gh can resolve it; otherwise pass `repo` explicitly.
- **Date qualifiers.** `since` / `until` accept relative durations (`3d`, `12h`, `2w`, `2mo`, `1y`), `YYYY-MM-DD`, or ISO datetime. They are rejected for `search_code` because GitHub code search has no supported date qualifier. Commit search always uses `committer-date` regardless of `dateField`.
- **`pr_push` needs `pr_checkout` first.** The op depends on the git-config metadata written by `pr_checkout` for the same branch; there is no alternative source.
- **Worktree serialization.** `pr_checkout` serializes git mutations per primary repo root inside `git.withRepoLock()`, so parallel checkout calls to the same primary repo do not race on shared `.git` state.
- **`run_watch` success is "no new runs appeared".** In commit mode, a successful result means all observed runs succeeded and the run-id set was stable one poll interval later — not merely that the latest poll looked green.
- **Tool requires `gh` on PATH.** The tool registration is skipped entirely when `gh` is not installed; if `gh` is installed but missing at execution time, the tool maps that to `GitHub CLI (gh) is not installed...`.
