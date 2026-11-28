# gitlab

> Dispatch GitLab CLI (`glab`) operations for projects, repository files, issues, merge requests, discussions, search, worktree checkout/push, and CI pipelines/jobs.

## Source

- Entry: `packages/coding-agent/src/tools/gl.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/gitlab.md`
- Key collaborators:
   - `packages/coding-agent/src/tools/details/gitlab.ts` / `packages/coding-agent/src/ui/tools/gitlab.tsx` — result types and TUI presenter (`pipeline_watch` live/result views, `tool.gl` icon).
   - `packages/coding-agent/src/tools/gl-common.ts` — nested-group project/group parsing, canonical host-qualified ref parsing, host-trust enforcement, `glab api` JSON/text/paginated wrappers, and MR IID resolution.
   - `packages/coding-agent/src/tools/gl-view.ts` — project overview, cached MR overview (`mr://`), and cached issue view.
   - `packages/coding-agent/src/tools/gl-mr.ts` — MR create (`--push=false`), update, discussions listing, notes/replies/diff comments, and discussion resolution.
   - `packages/coding-agent/src/tools/gl-mr-checkout.ts` — isolated git worktree MR checkout and push.
   - `packages/coding-agent/src/tools/gl-search.ts` — MR, issue, code, commit, and project search with project/group/global scoping.
   - `packages/coding-agent/src/tools/gl-ci.ts` — pipeline list/view/watch (including trigger/bridge jobs and fork MR `project_id`), job logs/retry, and `ci_lint`.
   - `packages/coding-agent/src/tools/github-cache.ts` & `packages/coding-agent/src/tools/gh-cache-invalidation.ts` — shared SQLite cache (schema v5) and bash invalidation for `glab` / `git push`.
   - `packages/coding-agent/src/internal-urls/mr-protocol.ts` — `mr://` internal URL handler (list, single overview, and `/diff` slices).
   - `packages/coding-agent/src/utils/gitlab.ts` — `glab` process wrapper (`gitlab.run/json/text()`).

## Availability and approval

- `gitlab.enabled` defaults to `false`; enable the GitLab CLI tool in **Settings → Tools** before use.
- The tool is discoverable and strict-schema, and is created only when `glab` is available on `PATH`.
- Read approval: `repo_view`, `file_read`, `issue_view`, `mr_discussions`, `search_mrs`, `search_issues`, `search_code`, `search_commits`, `search_projects`, `pipeline_list`, `pipeline_view`, `pipeline_watch`, `job_log`.
- Exec approval: `mr_create`, `mr_update`, `mr_checkout`, `mr_push`, `mr_note`, `mr_discussion_resolve`, `job_retry`, `ci_lint`.
- Host-trust guard: when `GITLAB_TOKEN`, `GITLAB_ACCESS_TOKEN`, or `OAUTH_TOKEN` is set in the environment, requests are only permitted to `gitlab.com`, `GITLAB_HOST`/`GITLAB_URI`/`GITLAB_URL`/`GL_HOST`, hosts configured in `glab`'s `config.yml`, or the checkout's own GitLab host.

## Operations

- **Projects & files**: `repo_view`, `file_read` (reads files at `ref`, defaults to `HEAD`, or paginates directory trees when `path` is omitted/`.` or 404s as a directory), `issue_view`.
- **Merge requests**: `mr_create` (always passes `--push=false --yes`), `mr_update`, `mr_checkout` (isolated git worktree keyed by host/project/IID), `mr_push` (pushes worktree branch after verifying push remote matches the MR source project).
- **Discussions**: `mr_discussions` (hides system notes by default), `mr_note` (reply by `discussionId` or ≥8-char prefix, diff comment by `path` with optional `line`/`oldLine`, or general/internal note), `mr_discussion_resolve`.
- **Search**: `search_mrs`, `search_issues`, `search_code`, `search_commits`, `search_projects`.
- **CI**: `pipeline_list`, `pipeline_view`, `pipeline_watch` (prefers current branch's open MR head pipeline, ignores `allow_failure` jobs, includes trigger/bridge jobs, spills full/partial traces to session artifacts), `job_log`, `job_retry`, `ci_lint`.
