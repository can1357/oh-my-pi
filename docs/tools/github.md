# github

> Dispatch GitHub CLI operations for repositories, repository files, pull requests, search, and Actions run watching.

## Source
- Entry: `packages/coding-agent/src/tools/gh.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/github.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/gh-format.ts` — shorten commit SHAs for summaries.
  - `packages/coding-agent/src/tools/gh-renderer.ts` — TUI rendering, especially `run_watch` live/result views.
  - `packages/coding-agent/src/utils/git.ts` — `gh`/`git` process wrappers, repo locking, branch config writes.
  - `packages/utils/src/dirs.ts` — base directory for dedicated PR worktrees.
  - `packages/coding-agent/src/sdk.ts` — session artifact allocation hook.
  - `packages/coding-agent/src/session/artifacts.ts` — artifact filename format `<id>.<toolType>.log`.

## Availability and approval

- `github.enabled` defaults to `false`; enable the GitHub CLI tool in **Settings → Tools** before use.
- The tool is discoverable and strict-schema, and is created only when `gh` is available on `PATH`. Authentication is checked by the CLI when an operation runs.
- `repo_view`, `file_read`, every `search_*` operation, and `run_watch` request read approval. `pr_create`, `pr_checkout`, and `pr_push` request execution approval.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"repo_view" \| "file_read" \| "pr_create" \| "pr_checkout" \| "pr_push" \| "search_issues" \| "search_prs" \| "search_code" \| "search_commits" \| "search_repos" \| "run_watch"` | Yes | Dispatch selector. `GithubTool.execute()` switches only on this field. |
| `repo` | `string` | No | `[host/]owner/repo` override. The host prefix is optional only when it matches the host `gh` defaults to (github.com, or `GH_HOST` when set); a repository on any other host — including github.com while `GH_HOST` names an enterprise instance — must be qualified, or `gh` sends the request to its default host. Ignored when the identifier argument is already a full GitHub URL. For `search_issues`/`search_prs`/`search_code`/`search_commits`, defaults to the current checkout's repository when omitted (skipped when the query already contains a `repo:`/`org:`/`user:`/`owner:` qualifier or when current-repo resolution fails). Required in practice when `gh` cannot infer repo context from the current checkout. |
| `branch` | `string` | No | Used by `repo_view`, `file_read`, `pr_push`, and `run_watch`. `file_read` omits the ref to use the repository's default branch; `run_watch` falls back to the current git branch when `run` is omitted; `pr_push` falls back to the current branch. |
| `path` | `string` | No | Required by `file_read`. Repository-relative path to a file in the GitHub repository; leading `/` is rejected. |
| `pr` | `string \| string[]` | No | Used by `pr_checkout`. Each item may be a PR number, branch name, or GitHub PR URL. Array form enables batching. Omitted means current branch PR. |
| `force` | `boolean` | No | Used only by `pr_checkout`. Defaults to `false`; allows resetting an existing `pr-<number>` local branch to the PR head commit. |
| `forceWithLease` | `boolean` | No | Used only by `pr_push`; passed through to git push. |
| `title` | `string` | No | Used only by `pr_create`. Required unless `fill` is `true`. |
| `body` | `string` | No | Used only by `pr_create`. Mutually exclusive with `fill`. Empty/omitted body becomes `--body ""` to suppress the interactive editor. Non-empty body is written to a temp file and passed as `--body-file`. |
| `base` | `string` | No | Used only by `pr_create`; passed as `--base`. |
| `head` | `string` | No | Used only by `pr_create`; passed as `--head`. |
| `draft` | `boolean` | No | Used only by `pr_create`. Defaults to `false`. |
| `fill` | `boolean` | No | Used only by `pr_create`. Defaults to `false`. Mutually exclusive with `title` and `body`. |
| `reviewer` | `string[]` | No | Used only by `pr_create`; each entry becomes `--reviewer`. |
| `assignee` | `string[]` | No | Used only by `pr_create`; each entry becomes `--assignee`. |
| `label` | `string[]` | No | Used only by `pr_create`; each entry becomes `--label`. |
| `query` | `string` | No | Used by all `search_*` ops. Required by local validation only for `search_code`; the other search ops compose it with optional date/repo/type qualifiers and send the result to GitHub. |
| `since` | `string` | No | Lower date bound for `search_issues`, `search_prs`, `search_commits`, and `search_repos`. Accepts relative durations (`3d`, `12h`, `2w`, `2mo`, `1y`), `YYYY-MM-DD`, or an ISO datetime. Rejected for `search_code`. |
| `until` | `string` | No | Upper date bound for `search_issues`, `search_prs`, `search_commits`, and `search_repos`. Same formats as `since`. Rejected for `search_code`. |
| `dateField` | `"created" \| "updated"` | No | Date qualifier field for issue/PR/repo search. Defaults to `created`; repo search maps `updated` to GitHub's `pushed:` qualifier. Ignored for commit search, which always uses `committer-date:`. |
| `limit` | `number` | No | Used by all `search_*` ops. Defaults to `10`, floored, clamped to `50`, and must be `> 0`. |
| `run` | `string` | No | Used only by `run_watch`. Must be a numeric run ID or full GitHub Actions run URL. |
| `tail` | `number` | No | Used only by `run_watch`. Defaults to `15`, floored, clamped to `200`, and must be `> 0`. |

## Outputs
The tool returns a single text result built by `buildTextResult()` in `packages/coding-agent/src/tools/gh.ts`.

- `content`: one text block. Multi-item ops join sections with blank lines and `---` separators.
- `sourceUrl`: set for repository/file/PR/run results when a canonical URL is known.
- `details`: optional structured metadata used by the TUI renderer.
  - Common fields: `artifactId`, `repo`, `branch`, `worktreePath`, `remote`, `remoteBranch`, `headSha`, `runId`, `runIds`, `status`, `conclusion`, `failedJobs`.
  - `pr_checkout` adds `checkouts: GhPrCheckoutSummary[]`.
  - `run_watch` adds `watch: GhRunWatchViewDetails`, which drives the custom live/result renderer in `packages/coding-agent/src/tools/gh-renderer.ts`.
- Artifact trailer: when `artifactId` is present, the text body gets an appended line like `Full failed-job logs: artifact://<id>`.
  - `run_watch` allocates artifacts with `session.allocateOutputArtifact("github")`; persistent sessions therefore save failed-log bodies as `<artifact-dir>/<id>.github.log`.

`run_watch` is the only streaming op. It emits `onUpdate` snapshots while polling, then returns one final text result.

## Flow
1. `GithubTool.createIf()` exposes the tool only when `git.github.available()` finds `gh` on `PATH`.
2. `GithubTool.execute()` wraps dispatch in `untilAborted()` and switches on `params.op`.
3. Each op normalizes optional strings, arrays, booleans, and numeric caps locally in `packages/coding-agent/src/tools/gh.ts`.
4. CLI execution goes through `git.github.run/json/text()` in `packages/coding-agent/src/utils/git.ts`:
   - spawns `gh ...` with `Bun.spawn()`;
   - trims stdout/stderr unless `trimOutput: false`;
   - maps common auth/repo-context failures into tool-facing `ToolError` messages;
   - `json()` rejects empty or invalid JSON.
   - Current-checkout resolution runs `gh repo view --json url -q .url` and keeps the host: the result is `owner/repo` on github.com and `host/owner/repo` elsewhere. `gh` resolves a host-less `--repo` against `GH_HOST` (github.com by default), so the prefix is what keeps an enterprise checkout off github.com. `gh api` endpoint paths never carry a host, so repo-scoped API calls strip it back off and pass `--hostname` instead; GitHub search qualifiers do the same (`repo:owner/repo` plus `--hostname`).
   - A host named by a full URL (a `pr://<host>/…` read, a PR/issue/run URL argument) is preserved as given, including `github.com`, so `GH_HOST` cannot redirect that request. Cache rows drop a prefix naming the host `gh` defaults to — `github.com/owner/repo` and `owner/repo` share one row normally, while under `GH_HOST` the explicit `github.com/` form keeps its own rows because the bare form then means the configured instance.
5. Read-style ops (`repo_view`, `file_read`, `search_*`) fetch repository data and return text or formatted Markdown-like summaries. `file_read` uses GitHub's contents API with the raw-media accept header and preserves the response bytes as text. Single-issue and single-PR views were moved out of the tool and now resolve through the `issue://` / `pr://` internal URL schemes, which share the same SQLite cache.
6. PR diffs moved out of the tool. `pr://<N>/diff` lists changed files, `pr://<N>/diff/<i>` slices a single file, and `pr://<N>/diff/all` returns the full unified diff — see `docs/tools/read.md`. All three variants share one `gh pr diff` invocation through the `pr-diff` cache row.
7. `pr_checkout` resolves PR metadata first, then enters `git.withRepoLock()` before any git mutation so parallel checkout calls for the same primary repo do not race on shared `.git` state.
8. `pr_push` reads PR head metadata back from git branch config, derives a refspec, pushes with `git.push()`, then invalidates the cached `pr://` rows for the pushed PR via `invalidateAllForNumber()` so the next `pr://` read reflects the push.
9. `pr_create` shells out once, then best-effort re-reads the created PR for a richer summary.
10. `run_watch` chooses either run mode (`run` supplied) or commit mode (`run` omitted), polls GitHub Actions APIs every 3 seconds for the first minute and every 15 seconds after that, emits streaming updates, and may save a full failed-log artifact before returning.
11. Final text goes through `toolResult().text(...)`; if `session.allocateOutputArtifact()` returns a slot, failed-log text is persisted with `Bun.write()`.

## Modes / Variants

### `repo_view`

| Aspect | Value |
| --- | --- |
| Required fields | `op` |
| Optional fields | `repo`, `branch` |
| `gh` command | `gh repo view [<repo>] [--branch <branch>] --json <GH_REPO_FIELDS>` |
| Batching | None |
| Output | `# <owner/repo>` header, description, URL, default branch, requested branch, visibility, permission, primary language, stars, forks, archive/fork flags, updated timestamp, homepage, topics. `sourceUrl = data.url`. |

If `repo` is omitted, `gh` repository resolution is used.

### `file_read`

| Aspect | Value |
| --- | --- |
| Required fields | `op`, `path` |
| Optional fields | `repo`, `branch` |
| `gh` command | `gh api /repos/<repo>/contents/<encoded-path> --method GET -H "Accept: application/vnd.github.raw+json" [-f ref=<branch>]` |
| Batching | None |
| Output | The file content exactly as returned by the contents API (`trimOutput: false`). `sourceUrl` points to `https://github.com/<repo>/blob/<branch-or-HEAD>/<encoded-path>`; `details` contains the resolved `repo` and optional `branch`. |

`repo` defaults to the current checkout's GitHub repository. Omitting `branch` asks GitHub for the repository's default branch. Every path segment is URL-encoded independently. The operation rejects an empty path or one beginning with `/`; GitHub reports missing files, directories, and invalid refs through the normal CLI error mapping. The model-facing prompt requires this operation, rather than `curl` or `wget`, for files hosted in GitHub repositories.

Single-issue and single-PR reads live in the `issue://<N>` / `pr://<N>` URL schemes (see `docs/tools/read.md`). They share `~/.omp/cache/github-cache.db` (override via `OMP_GITHUB_CACHE_DB`) and the `github.cache.softTtlSec` / `github.cache.hardTtlSec` / `github.cache.enabled` settings. The cache retains rendered Markdown plus the raw JSON payload returned by `gh`, including private bodies, comments, reviews, and review comments when comments are enabled; rows are scoped by the local GitHub credential fingerprint. Root and repo-scoped reads (`issue://`, `pr://owner/repo`) issue a live `gh issue list` / `gh pr list` for browsing; query params `state`, `limit`, `author`, `label` pass through to `gh` (`issue://` accepts `state=open|closed|all`; `pr://` also accepts `merged`). PR diffs ride the same cache under `pr://<N>/diff[/…]`: the listing, full diff, and per-file slices all share one `pr-diff` row keyed by repo and PR number.

### `pr_create`

| Aspect | Value |
| --- | --- |
| Required fields | `op` plus either `fill=true` or `title` |
| Optional fields | `repo`, `title`, `body`, `base`, `head`, `draft`, `fill`, `reviewer[]`, `assignee[]`, `label[]` |
| `gh` command | `gh pr create ...` with flags assembled from provided fields |
| Batching | None |
| Output | `# Created Pull Request ...` summary with URL, state, draft flag, base/head, author, created time, labels, optional body. `sourceUrl` is the created PR URL. |

Branches:
- `fill && (title || body !== undefined)` throws.
- Non-empty `body` is written under a temp dir `gh-pr-body-*` in `os.tmpdir()`, passed as `--body-file`, then removed in `finally`.
- After creation, the tool parses the returned URL and best-effort runs `gh pr view <number> --repo <repo> --json <GH_PR_FIELDS_NO_COMMENTS>`; failures there are swallowed.

### `pr_checkout`

| Aspect | Value |
| --- | --- |
| Required fields | `op` |
| Optional fields | `repo`, `pr`, `force` |
| `gh` command | For each requested PR: `gh pr view [<pr>] [--repo <repo>] --json <GH_PR_CHECKOUT_FIELDS>`; cross-repo PRs may also call `gh repo view <headRepository> --json <GH_REPO_CLONE_FIELDS>`. |
| Batching | Yes. `pr` may be `string[]`; each PR is resolved in parallel, but git mutations are serialized per primary repo by `git.withRepoLock()`. |
| Output | Single PR: checkout/worktree summary plus `details.repo`, `details.branch`, `details.worktreePath`, `details.remote`, `details.remoteBranch`, `details.checkouts`. Batched: `# <n> Pull Request Worktrees (...)` plus one section per PR and aggregated `details.checkouts`. On partial failure the header becomes `# <n>/<total> Pull Request Worktrees checked out (<k> failed)` with a trailing `## Failed` list. |

Worktree and metadata behavior:
- Local branch name is always `pr-<number>`.
- Worktree path is `getWorktreeDir("<number>-<repo-hash>")` = `path.join(getWorktreesDir(), "<number>-<repo-hash>")`, where `<number>` is the PR number and `<repo-hash>` is `hashPath(primaryRepoRoot)` (a 7-hex digest of the primary repo root). `getWorktreesDir()` resolves the base in this order: a valid `OMP_WORKTREE_DIR`, the applied `worktree.base` setting, then the profile/XDG-aware data-root default (normally `~/.omp/wt`). Both overrides expand a leading `~` and must resolve to an absolute path; an invalid relative value is ignored and resolution falls through. `resolveAvailableWorktreePath()` appends a `-2`/`-3`… suffix when the resulting path is already registered with git or present on disk.
- Existing worktree detection is by branch ref `refs/heads/pr-<number>` from `git.worktree.list()`.
- New worktree creation calls `git.worktree.add(repoRoot, finalWorktreePath, localBranch, { signal })` after verifying the path is neither already registered nor already present on disk.
- For same-repo PRs, remote is `origin`. For cross-repo PRs, the tool resolves a clone URL for the head repo, reuses an existing remote with the same URL when possible, or creates `fork-<owner>` / `fork-<owner>-<n>`.
- The branch push metadata is persisted with `git config` under the repository's shared `.git/config` as:
  - `branch.pr-<number>.remote`
  - `branch.pr-<number>.merge`
  - `branch.pr-<number>.pushRemote`
  - `branch.pr-<number>.ompPrHeadRef`
  - `branch.pr-<number>.ompPrUrl`
  - `branch.pr-<number>.ompPrIsCrossRepository`
  - `branch.pr-<number>.ompPrMaintainerCanModify`
- If `refs/heads/pr-<number>` already exists at a different commit, checkout fails unless `force=true`, in which case `git branch --force` resets it to the fetched PR head.
- If a matching worktree already exists, the tool reuses it and reports `reused: true`.

### `pr_push`

| Aspect | Value |
| --- | --- |
| Required fields | `op` |
| Optional fields | `branch`, `forceWithLease` |
| `gh` command | None. This path uses git, not `gh`. |
| Batching | None |
| Output | `# Pushed Pull Request Branch` summary with local branch, remote, remote branch, remote URL, PR URL, and force-with-lease flag. `sourceUrl = prUrl` when known. |

Push target resolution reads the `branch.<name>.ompPrHeadRef`, `pushRemote`/`remote`, `ompPrUrl`, `ompPrMaintainerCanModify`, and `ompPrIsCrossRepository` git-config keys written by `pr_checkout`. If the current checked-out branch matches the target branch, the source ref is `HEAD`; otherwise it pushes `refs/heads/<branch>`. The refspec is `HEAD:refs/heads/<headRef>` or `refs/heads/<branch>:refs/heads/<headRef>`.

### `search_issues`

| Aspect | Value |
| --- | --- |
| Required fields | `op` |
| Optional fields | `repo`, `query`, `limit`, `since`, `until`, `dateField` |
| `gh` command | `gh api -X GET /search/issues -f q="<query> [date qualifier] [repo:<repo>] is:issue" -F per_page=<limit>` |
| Batching | None |
| Output | `# GitHub issues search`, echoed query, optional repo, result count, then one bullet per issue with repo/state/author/labels/timestamps/URL. |

`repo` defaults to the current checkout's `owner/repo` via `resolveSearchRepoScope()` when omitted. The default is suppressed when the composed query already contains a leading `repo:`/`org:`/`user:`/`owner:` qualifier or when `gh repo view` fails to resolve the current checkout (e.g. outside a github remote).

### `search_prs`

| Aspect | Value |
| --- | --- |
| Required fields | `op` |
| Optional fields | `repo`, `query`, `limit`, `since`, `until`, `dateField` |
| `gh` command | `gh api -X GET /search/issues -f q="<query> [date qualifier] [repo:<repo>] is:pr" -F per_page=<limit>` |
| Batching | None |
| Output | Same shape as `search_issues`, labeled as pull requests. |

`repo` defaults to the current checkout's `owner/repo` as in `search_issues`.

### `search_code`

| Aspect | Value |
| --- | --- |
| Required fields | `op`, `query` |
| Optional fields | `repo`, `limit` |
| `gh` command | `gh api -X GET /search/code -f q="<query> [repo:<repo>]" -F per_page=<limit> -H "Accept: application/vnd.github.text-match+json"` |
| Batching | None |
| Output | `# GitHub code search`, result count, then one bullet per match with path, repo, short commit SHA, URL, and first normalized text-match fragment line when present. |

`repo` defaults to the current checkout's `owner/repo` as in `search_issues`. `since` and `until` are explicitly rejected for this op because GitHub code search has no supported date qualifier.

### `search_commits`

| Aspect | Value |
| --- | --- |
| Required fields | `op` |
| Optional fields | `repo`, `query`, `limit`, `since`, `until`, `dateField` (accepted but ignored; commit searches use `committer-date`) |
| `gh` command | `gh api -X GET /search/commits -f q="<query> [committer-date qualifier] [repo:<repo>]" -F per_page=<limit>` |
| Batching | None |
| Output | `# GitHub commits search`, result count, then one bullet per commit: short SHA + first commit-message line, repo, author, date, URL. |

`repo` defaults to the current checkout's `owner/repo` as in `search_issues`.

### `search_repos`

| Aspect | Value |
| --- | --- |
| Required fields | `op` |
| Optional fields | `query`, `limit`, `since`, `until`, `dateField` |
| `gh` command | `gh api -X GET /search/repositories -f q="<query> [date qualifier]" -F per_page=<limit>` |
| Batching | None |
| Output | `# GitHub repositories search`, result count, then one bullet per repo with first description line, language, stars, forks, open issues, visibility, archive/fork flags, updated time, URL. |

`repo` is intentionally not used for this op. If `query`, `since`, and `until` are all omitted, the tool sends an empty GitHub repository-search query and the GitHub API may reject it.

### `run_watch`

| Aspect | Value |
| --- | --- |
| Required fields | `op` |
| Optional fields | `repo`, `branch`, `run`, `tail` |
| `gh` command | Repo resolution: `gh repo view --json url -q .url` when `repo` and run URL repo are both absent. Single-run mode uses `gh api --method GET /repos/<repo>/actions/runs/<runId>` and `gh api --method GET /repos/<repo>/actions/runs/<runId>/jobs`. Commit mode uses `gh api --method GET /repos/<repo>/branches/<branch>`, `gh api --method GET /repos/<repo>/actions/runs`, `gh api --method GET /repos/<repo>/actions/runs/<runId>/jobs`, and `gh api /repos/<repo>/actions/jobs/<jobId>/logs` for failed jobs. |
| Batching | Implicit batching only in commit mode: all workflow runs for one commit are tracked together. |
| Output | Streaming watch snapshots via `onUpdate`, then a final text report. On failure, appends `Full failed-job logs: artifact://<id>` and sets `details.artifactId`. |

Watch flow:
- `run` parsing accepts either a decimal run ID or a full run URL. URL repo must match explicit `repo` when both are given.
- Poll interval is `3` seconds (`RUN_WATCH_INTERVAL_DEFAULT`) for the first `60` seconds of the watch (`RUN_WATCH_FAST_WINDOW_MS`), then `15` seconds (`RUN_WATCH_INTERVAL_SLOW`). Rate-limited poll errors back off at the slow interval and are retried up to `5` consecutive failures (`RUN_WATCH_MAX_POLL_FAILURES`). Commit mode gives up with a clear message after `90` seconds if no runs ever appear (`RUN_WATCH_NO_RUNS_GIVE_UP_MS`).
- Failure grace period is fixed at 5 seconds (`RUN_WATCH_GRACE_DEFAULT`). When any failed job appears before completion, the tool emits a note, waits once, re-fetches state, then collects logs so concurrent failures are included.
- Failed-job logs are fetched with `gh api /repos/<repo>/actions/jobs/<jobId>/logs` via `git.github.run()`, not `json()`. Non-zero exit leaves `available: false` instead of failing the whole watch.
- Inline result includes only the last `tail` lines per failed job. The saved artifact contains full logs (`mode: "full"`).
- In commit mode, success is intentionally double-checked: once all known runs are successful, the tool waits one more poll interval and succeeds only if the set of run IDs is unchanged. This avoids returning before late workflow runs appear for the same commit.
- `details.watch` drives a specialized renderer in `packages/coding-agent/src/tools/gh-renderer.ts`; non-watch results fall back to generic text rendering.

## Side Effects
- Filesystem
  - `pr_create` may create a temp dir under `os.tmpdir()` named `gh-pr-body-*`, write `body.md`, then remove the dir in `finally`.
  - `pr_checkout` may create worktree directories named `<pr-number>-<repo-hash>` under the base selected by `OMP_WORKTREE_DIR`, then `worktree.base`, then the profile/XDG-aware default (normally `~/.omp/wt`), and add git worktrees there.
  - `run_watch` may write a session artifact with full failed-job logs.
- Network
  - Every op shells out to `gh`, which then talks to GitHub APIs except `pr_push`.
  - `pr_push` uses git network transport to the configured remote.
- Subprocesses / native bindings
  - All `gh` calls use `Bun.spawn(["gh", ...args])`.
  - `pr_checkout` and `pr_push` also invoke git helpers from `packages/coding-agent/src/utils/git.ts`.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - `run_watch` consumes `session.allocateOutputArtifact()` when failed-job logs are persisted.
  - Returned `details` objects carry run/checkouts metadata for the renderer/UI.
- User-visible prompts / interactive UI
  - `gh` interactive editor fallback is suppressed for `pr_create` by forcing either `--body-file` or `--body ""`.
  - `gh-renderer` provides compact headers for all ops and a custom live watch view for `run_watch`.
- Background work / cancellation
  - `run_watch` loops until success/failure and uses `scheduler.wait()` between polls.
  - `GithubTool.execute()` is wrapped in `untilAborted()`; `git.github.run()` forwards the abort signal into `Bun.spawn()`.

## Limits & Caps
- Search result default: `10` (`SEARCH_LIMIT_DEFAULT` in `packages/coding-agent/src/tools/gh.ts`).
- Search result max: `50` (`SEARCH_LIMIT_MAX`).
- PR file preview inside the `pr://` view: first `50` files only (`FILE_PREVIEW_LIMIT` in `gh.ts`). For aggregate diffs rejected at GitHub's 20,000-line limit, the `pr://<N>/diff` fetcher falls back to the paginated files API (`100` files per page, at most `3000` files); binary or individually oversized patches remain listed with an unavailable-patch marker.
- Run-watch poll interval: `3s` for the first `60s`, then `15s` (`RUN_WATCH_INTERVAL_DEFAULT`, `RUN_WATCH_FAST_WINDOW_MS`, `RUN_WATCH_INTERVAL_SLOW`); commit mode with no runs gives up after `90s` (`RUN_WATCH_NO_RUNS_GIVE_UP_MS`); up to `5` consecutive rate-limited poll failures are tolerated (`RUN_WATCH_MAX_POLL_FAILURES`).
- Run-watch failure grace period: `5s` (`RUN_WATCH_GRACE_DEFAULT`).
- Run-watch failed-log tail default: `15` lines (`RUN_WATCH_TAIL_DEFAULT`).
- Run-watch failed-log tail max: `200` lines (`RUN_WATCH_TAIL_MAX`).
- PR review comments page size: `100` (`REVIEW_COMMENTS_PAGE_SIZE`).
- Actions jobs page size: `100` (`RUN_JOBS_PAGE_SIZE`).
- Search and tail numeric inputs are floored with `Math.floor()`, clamped to the max, and rejected when non-finite or `<= 0`.
- `pr_checkout` batch fan-out is unbounded in tool code; all requested PRs are launched with `Promise.allSettled()` so individual failures surface as a partial result instead of aborting the batch.

## Errors
- Tool creation is skipped entirely when `gh` is not installed.
- `git.github.run()` throws `ToolError("GitHub CLI (gh) is not installed...")` if `gh` is missing at execution time.
- `git.github.text/json()` map common failures to model-facing messages:
  - not authenticated → `GitHub CLI is not authenticated. Run \`gh auth login\`.`
  - missing repo context without explicit `repo` → `GitHub repository context is unavailable. Pass \`repo\` explicitly or run the tool inside a GitHub checkout.`
  - otherwise stderr/stdout text, or fallback `GitHub CLI command failed: gh ...`
- `json()` also throws on empty stdout or invalid JSON.
- Local validation errors throw `ToolError`, including:
  - missing required per-op fields (`path` for `file_read`, `query` for `search_code`, `title` unless `fill=true`)
  - invalid numeric `limit` / `tail`
  - invalid `since` / `until` date bound
  - invalid `run` format
  - `fill` combined with `title` or `body`
  - missing git repo / branch / HEAD context for checkout, push, or watch
  - `pr_push` on a branch without `ompPrHeadRef` metadata
  - conflicting existing worktree path or branch without `force`
  - an absolute `file_read` path (a leading `/`)
- `run_watch` treats failed-job log fetches specially: missing log content does not fail the watch; it marks that log `available: false` and prints `Log tail unavailable.` / `Full log unavailable.`.
- `pr_create` swallows only the post-create best-effort `gh pr view` refresh; the create step itself still fails normally.

## Notes
- `appendRepoFlag()` intentionally skips `--repo` when the identifier argument is already a full GitHub URL; that lets `gh` derive repo/number from the URL.
- `normalizePrIdentifierList()` accepts `reviewer`, `assignee`, and `label` arrays too; the helper name is broader than its callers.
- `pr_push` depends on `pr_checkout` having run first for that local branch; there is no alternate metadata source.
- `pr_checkout` stores push metadata in branch config, not in the worktree directory. Reusing the same `pr-<number>` branch reuses those config keys.
- Worktree write serialization is keyed by the primary repo root, not the current worktree path, because git worktrees share `.git/config`, `packed-refs`, commit-graph, and worktree metadata files.
- `search_repos` is the only search op that never forwards `repo`; repository scoping must be expressed in the query itself.
- `run_watch` success on commit mode means “all observed runs succeeded and no additional runs appeared one poll later”, not merely “latest poll looked green”.
- The TUI renderer collapses failed log previews unless the result view is expanded; the underlying text result still contains the same tailed lines plus any artifact reference.
