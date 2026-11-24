`glab` op wrapper: projects/files, MRs, discussions, search, worktree checkout/push, CI pipelines/jobs. Read MR: `mr://` (list), `mr://<iid>` (`?comments=0&unresolved=1`), `mr://<iid>/diff` (files), `/diff/<i>`, `/diff/all`.

<instruction>
Select via `op`.
- `repo`: `[<host>/]<group…>/<project>` (nested groups supported); omit → current checkout. `group`: `[<host>/]<group…>`.
- `file_read`: read `path` or list directory from `repo`; omit `path` → root tree, omit `ref` → default branch.
- `mr_create`: never pushes (`--push=false`); `fill: true` is mutually exclusive with `title` and `body`.
- `mr_checkout`: MR(s) → dedicated git worktrees, never working tree; array `mr` batches multiple in one call.
- `mr_push`: requires prior `op: mr_checkout`.
- `mr_discussions`: hides system notes by default; filter with `state`, `noteType`, `path`.
- `mr_note`: mutually exclusive modes — reply (`discussionId`, ≥8-char prefix), diff comment (`path`, optional `line` or `oldLine`), or general note/discussion.
- `search_code`: `query` required; rejects `since`/`until`. `search_commits`: `query` and `since`/`until` are mutually exclusive; omit `query` with project scope for date-filtered commits.
- `pipeline_view`/`pipeline_watch`/`job_log`: omitting `pipeline`/`mr`/`ref` prefers the current branch's open MR head pipeline over branch push pipelines.
- `pipeline_watch`: ignores `allow_failure` jobs and fast-fails on real job failures.
- `since`/`until`: relative `<n>` + `m`/`h`/`d`/`w`/`mo`/`y` (e.g. `3d`, `2w`), ISO date `YYYY-MM-DD`, or ISO datetime.
</instruction>

<output>
Concise summary per op. Failed `pipeline_watch` and long `job_log` save full traces to session artifacts.
</output>

<critical>
GitLab-hosted repository files: MUST use `file_read`; NEVER `curl`/`wget` or raw `glab api`.
</critical>
