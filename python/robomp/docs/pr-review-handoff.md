# Handoff: incoming-PR review feature

Wire robomp to **review pull requests opened by contributors** (and other bots), in two
phases: (1) classify + rank, (2) a real line-by-line review posted as one GitHub review.
robomp **never merges, closes, approves, or pushes** — the rank label is the verdict; the
maintainer acts on it.

Confirmed decisions:
- **COMMENT-only.** `submit_pr_review` always uses `event="COMMENT"`. Never `APPROVE` /
  `REQUEST_CHANGES` (those gate merge — the maintainer's call).
- **SQLite staging.** Inline comments are staged in a sqlite table, flushed in one review.
  Survives `--continue` resume; honours "DB is the only source of truth, in-memory state is
  just `_inflight`."
- **Reuse the issue isolation verbatim.** The PR head is checked out into a per-PR worktree
  (clone pool + slot uid + natives cache + scrubbed env) **before** the agent starts, and
  that worktree is the agent's cwd. Review is read-only on that checkout.

The agent prompt already exists: `src/prompts/pr_review_rubric.md` (rename to
`kickoff_pr_review.md` — see §5). Everything below is the wiring around it.

---

## 1. How the existing flows work (the substrate to mirror)

End-to-end, every task today follows the same spine:

```
GitHub webhook
  └─ server.py  POST /webhook/github   (HMAC verify; 401 on bad sig)
       └─ github_events.route(event_type, payload, …)  → RouteDecision(queue|skip, task, …)
            └─ db.record_event(...)  INSERT OR IGNORE on X-GitHub-Delivery   → 202
  WorkerPool._dispatch_loop  (BEGIN IMMEDIATE claim; _inflight set keyed by (owner,repo,number))
       └─ WorkerPool._dispatch(row)   re-derives handler from (event_type, action)
            └─ tasks.<entry>(settings, db, github, sandbox, git_transport, payload, delivery_id, …)
                 ├─ resolve RepoInfo + IssueInfo (PRs are issues)
                 ├─ sandbox.ensure_workspace(...)   → per-issue worktree (clone pool, slot, natives)
                 ├─ db.upsert_issue(...)            → state + branch + session_dir
                 └─ worker.run_task(task_kind=..., inputs=TaskInputs, …)
                      ├─ ToolBindings(inbound_thread_number=pr_number, inbound_is_pr=…)
                      ├─ _build_prompt(task_kind, …) → persona.<prompt>(...)
                      ├─ RpcClient(omp --mode rpc, cwd=worktree, custom_tools=host_tools.build(bindings))
                      └─ _drive_turn(...)  → completion/dirty reminders until terminal tool / clean
```

Existing task kinds and their analogues for us:

| Task | Trigger (`route`) | Workspace | Terminal action | Notes |
|---|---|---|---|---|
| `triage_issue` | `issues.opened` | fresh `farm/<hex>/<slug>` worktree | `gh_open_pr` / `mark_unable_to_reproduce` / `abort_task` | **The fresh-entry template** for `review_pr`. |
| `handle_comment` | `issue_comment.created` on an issue | resume existing | one `gh_post_comment` | |
| `handle_pr_conversation` | `issue_comment.created` on a PR | resume bot-PR branch | `gh_post_comment` / push | bot-owned PRs only. |
| `handle_review` | `pull_request_review_comment.created` on a **bot-authored** PR | resume via `existing_branch=pr.head_ref` | reply / push | **The PR-context template** — shows `ensure_workspace(existing_branch=…)` and `inbound_is_pr`. |
| `cleanup_workspace` | `issues.closed` / bot `pull_request.merged` | removes worktree | — | |

Two facts that shape the wiring:
- `route()` and `WorkerPool._dispatch()` **both** branch on `(event_type, action)`. `route`
  decides queue/skip + carries `submitter`/`directive`; `_dispatch` re-derives the handler.
  **A new task kind must be added in both.**
- `host_tools.build(bindings)` returns an **identical tuple for every task kind** (to keep the
  LLM prompt cache warm); tools **self-gate at execution time** (e.g. `classify_issue` rejects
  when `bindings.inbound_is_pr`). We follow the same pattern: add the new tools to `build()`
  unconditionally and gate them on a `review_mode` flag.

---

## 2. Routing (`src/github_events.py`)

### 2a. New entry: incoming PR opened

Add a `pull_request` branch **before** the existing `pull_request`/`closed` block. Trigger a
one-shot review on `opened`, `reopened`, and `ready_for_review`; **skip everything else**
(notably `synchronize` already falls through to the final skip — keep it that way: do **not**
re-review on new commits).

```python
if event_type == "pull_request" and action in ("opened", "reopened", "ready_for_review"):
    pr = payload.get("pull_request") or {}
    if bool(pr.get("draft")):
        return RouteDecision("skip", None, repo, None, "draft PR")
    pr_user = pr.get("user") or {}
    if _is_bot_account(pr_user, bot_login):
        return RouteDecision("skip", None, repo, None, "bot-authored PR")   # our own farm PRs
    number = pr.get("number")
    if not isinstance(number, int):
        return RouteDecision("skip", None, repo, None, "PR missing number")
    login, assoc = _submitter_info(pr)           # PR author = rate-limit subject
    return RouteDecision("queue", "review_pr", repo, issue_key(repo, number),
                         f"pull_request.{action}", submitter=login, association=assoc)
```

Use the PR's **own** key (`issue_key(repo, number)`), not `_resolve_pr_key` — an incoming PR
has no originating bot issue.

### 2b. Gate incoming-PR comments ("don't run on comments unless I ask")

Today `issue_comment.created` on **any** PR queues `handle_pr_conversation`. For incoming
(non-bot) PRs that would make the bot respond to every comment. Change the PR branch of the
`issue_comment` handler to:

- PR author **is** the bot → `handle_pr_conversation` (unchanged).
- PR author is **not** the bot → **skip**, *unless* `_directive_kwargs(...)` is non-empty
  (a maintainer `@bot` mention or a configured reviewer bot). A directive routes to the
  existing directive path; only an explicit "re-review" directive re-runs the review.

The PR author is on `payload.issue.user.login` for `issue_comment` events. `synchronize`,
`edited`, etc. need no change (they already skip).

### 2c. Cleanup for incoming PRs

`pull_request.closed` currently requires a bot-authored, merged PR. Incoming-PR review
worktrees would otherwise leak. Extend the close branch (or add a TTL sweep) so an incoming
PR's worktree is GC'd on close. Minimal: when the PR has a workspace row, route
`pull_request.closed` → `cleanup_workspace` regardless of author/merge.

---

## 3. Dispatch (`src/queue.py` `_dispatch`)

Add a branch mirroring `triage_issue`:

```python
elif event == "pull_request" and action in ("opened", "reopened", "ready_for_review"):
    await tasks.review_pr(
        settings=self.settings, db=self.db, github=self.github,
        sandbox=self.sandbox, git_transport=self.git_transport,
        payload=row.payload, delivery_id=row.delivery_id,
        attempts=row.attempts, slot_uid=slot_uid,
    )
```

Idempotency: `record_event` dedups on delivery id and `_inflight` serializes per
`(owner,repo,number)`. Add one guard in `tasks.review_pr`: if the PR already carries a
`triaged`/`review:*` label, skip the re-review (a `reopened` shouldn't redo work) unless a
directive forces it.

---

## 4. Task dispatcher (`src/tasks.py` `review_pr`)

New entry point — structurally `triage_issue` (fresh worktree) crossed with `handle_review`
(PR context). Key differences: it checks out the **PR head**, and it never opens an issue row
for an originating issue (the PR is the unit).

```python
async def review_pr(*, settings, db, github, sandbox, git_transport,
                    payload, delivery_id, attempts=0, slot_uid=None) -> None:
    pr_node = payload.get("pull_request") or {}
    pr_number = int(pr_node.get("number") or 0)
    repo_full = str((payload.get("repository") or {}).get("full_name") or "")
    if pr_number <= 0 or not repo_full:
        return
    repo = await github.get_repo(repo_full)
    issue = await github.get_issue(repo_full, pr_number)   # PR-as-issue → title/body/labels
    pr = await github.get_pull_request(repo_full, pr_number)

    # idempotency: already triaged? bail (see §3)
    key = issue_key(repo_full, pr_number)
    db.upsert_issue(key=key, repo=repo_full, number=pr_number, state="reviewing", pr_number=pr_number)

    workspace = sandbox.ensure_workspace(
        repo=repo.full_name, number=pr_number, title=issue.title,
        clone_url=repo.clone_url, default_branch=repo.default_branch,
        pr_head=pr_number,                       # ← NEW: check out the PR head (see §6)
        author_name=settings.resolved_author_name, author_email=settings.git_author_email,
        slot_uid=slot_uid,
    )
    db.upsert_issue(key=key, repo=repo_full, number=pr_number, state="reviewing",
                    branch=workspace.branch, session_dir=str(workspace.session_dir), pr_number=pr_number)

    inputs = TaskInputs(settings=settings, db=db, github=github, git_transport=git_transport,
                        repo=repo, issue=issue, workspace=workspace, delivery_id=delivery_id,
                        attempts=attempts, slot_uid=slot_uid, natives_cache=sandbox.natives_cache)
    await run_task(task_kind="review_pr", inputs=inputs, pr_number=pr_number)
```

`run_task(..., pr_number=pr_number)` makes `ToolBindings.inbound_is_pr=True` and points the
comment tools at the PR thread (existing behavior). Add `review_pr` to `tasks.__all__`.

---

## 5. Prompt + persona (`src/persona.py`, `src/prompts/`)

- **Rename** `src/prompts/pr_review_rubric.md` → `src/prompts/kickoff_pr_review.md` (it's the
  full kickoff now, not just a rubric).
- Add the loader, mirroring `kickoff`:

  ```python
  def kickoff_pr_review(*, repo: RepoInfo, pr: PullRequestInfo, workspace: Workspace) -> str:
      return render(_load("kickoff_pr_review.md"), {"repo": repo, "pr": pr, "workspace": workspace})
  ```

  The template references `{{repo.*}}`, `{{pr.number|author|head_ref|base_ref|head_repo|html_url}}`,
  `{{workspace.branch}}`. Title/body/diff come from the `fetch_pr` tool, not template vars
  (`PullRequestInfo` has no title/body). `_lookup` returns `""` for any missing field — safe.
- `_build_prompt` (`worker.py`): add a `task_kind == "review_pr"` branch calling
  `persona.kickoff_pr_review(repo=inputs.repo, pr=<pr>, workspace=inputs.workspace)`. The `pr`
  object must reach `_build_prompt` — simplest is to add an optional `pr: PullRequestInfo | None`
  param to `run_task`/`_build_prompt` (parallel to `comment`/`review_payload`), or rebuild it
  from `inputs.issue` (number/author) + a `get_pull_request` call inside the branch.
- **`todo_phases.toml`**: add a `review_pr` table (Phase 0 orient / Phase 1 classify / Phase 2
  review) so `seed_phases("review_pr")` seeds the todo list, like `triage_issue`.
- **`host_tools.toml`**: add descriptions for the four new tools (see §7).

---

## 6. Sandbox: check out the PR head (`src/sandbox.py`)

This is the load-bearing isolation change. Reuse the entire worktree machinery; only the
**checkout source** differs. The PR head may live on a fork, so it is fetched via
`refs/pull/<n>/head` on the base repo's remote (not a branch on origin).

- **`GitTransport` protocol** — add:
  ```python
  def fetch_pr_head(self, *, repo: str, pool_dir: Path, pr_number: int) -> None: ...
  ```
  `LocalGitTransport`: `git fetch origin pull/<n>/head` (PAT injected per-call, as
  `fetch_base_ref` does). `ProxyGitTransport`: add the matching gh-proxy git op (mirror its
  `fetch_base_ref` path over the HMAC channel + a proxy-server handler).
- **`ensure_workspace`** — add `pr_head: int | None = None`. When set, in the `not repo_exists`
  branch:
  ```python
  self.transport.fetch_pr_head(repo=repo, pool_dir=pool, pr_number=pr_head)
  _run(["git", "worktree", "add", "--detach", str(repo_dir), "FETCH_HEAD"], cwd=pool)
  ```
  Detached HEAD (never a pushable branch — review is read-only). Set
  `workspace.branch = f"review/pr-{pr_head}"` for bookkeeping/logging only. Everything after
  (slot chown, `_share_git_metadata_with_slots`, `_provision_runtime_dirs`, natives-cache
  hardlink, identity config) runs unchanged, so the review worktree gets the **same isolation
  and the warm native cache** as a fix worktree (`bun check`/lsp stay fast).

Result: the agent's cwd is the PR head, fully isolated, read-only. No credentialed push remote
is configured for review worktrees.

---

## 7. Host tools (`src/host_tools.py`)

Add a `review_mode: bool = False` field to `ToolBindings`; set it from `run_task`
(`review_mode = task_kind == "review_pr"`). Self-gating pattern (consistent with how
`classify_issue` gates on `inbound_is_pr`):

- New review tools require `review_mode` → reject otherwise.
- `gh_push_branch` / `gh_open_pr` **refuse** when `review_mode` (read-only review; never push to
  a contributor's branch).

Four new tools, registered unconditionally in `build()`:

| Tool | Params | Behavior | Audit |
|---|---|---|---|
| `fetch_pr` | — (defaults to inbound PR) | `get_pull_request` + `list_pr_files`; returns title, body, `Fixes #N` links, changed-file list (path/status/+−). The premise read. | yes |
| `classify_pr` | `rank`(req `review:p0..p3`), `type`(one of `_PR_TYPES`), `area[]`(⊆ `_FUNCTIONAL`), `provider?`, `rationale` | Validate (drop unknowns silently, like `classify_issue`); `github.add_issue_labels(repo, pr.number, ["triaged", rank, type, *area, provider?])` (issues-labels API works on PRs); persist rank in the issue row. | yes |
| `pr_review_comment` | `path`(req), `line`(req int), `body`(req), `side`="RIGHT", `start_line?`, `start_side?` | **Stage only** — append to sqlite (§9). Validate path/line/body. Return staged count. No GitHub call. | yes |
| `submit_pr_review` | `body`(req), `event`="COMMENT" (forced) | Read staged rows → `github.submit_pr_review(repo, pr.number, body, "COMMENT", comments)` → `clear_staged_review_comments` on success. | yes |

New allowlists next to the existing ones:
```python
_PR_RANKS = ("review:p0", "review:p1", "review:p2", "review:p3")
_PR_TYPES = ("feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build")
# area reuses _FUNCTIONAL; provider:<name> + _PLATFORMS as for classify_issue
```

`classify_pr` mirrors `_build_classify_issue` (validation + label apply + persist + audit).
`submit_pr_review` clears the buffer only after a 2xx so a failed post is retryable.

---

## 8. Backend (`github_backend.py` + `github_client.py` + `proxy_client.py` + `proxy/server.py`)

- `PullRequestInfo`: add `title: str = ""`, `body: str = ""`. Populate in `_pr_from_payload`
  (REST `/pulls/{n}` carries both) and proxy `_pr_from`.
- `GitHubBackend` protocol + both impls:
  - `list_pr_files(repo, pr_number) -> list[PullRequestFileInfo]` → `GET /pulls/{n}/files`
    (new small frozen dataclass: `path`, `status`, `additions`, `deletions`).
  - `submit_pr_review(*, repo, pr_number, body, event, comments) -> PullRequestReviewInfo`
    → `POST /pulls/{n}/reviews` with `comments=[{path, line, side, body, start_line?, start_side?}]`.
- gh-proxy mode (`proxy_client.py` + `src/proxy/server.py`): add `/gh/v1/pr_files` (GET) and
  `/gh/v1/submit_pr_review` (POST) endpoints + client wrappers. HMAC signing is generic — no
  protocol change. Validate inputs server-side with the existing `_require_*` helpers.

---

## 9. DB (`src/db.py`)

One staging table (schema block near `events`/`issues`/`tool_calls`):

```sql
CREATE TABLE IF NOT EXISTS pr_review_comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key   TEXT NOT NULL,      -- repo__owner#<pr_number>
  path        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  side        TEXT NOT NULL DEFAULT 'RIGHT',
  start_line  INTEGER,
  start_side  TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pr_review_comments_key ON pr_review_comments(issue_key);
```

DAOs (thread-safe via the existing `_lock`): `stage_review_comment(...)`,
`list_staged_review_comments(issue_key) -> list[...]`, `clear_staged_review_comments(issue_key)`.
Rank persistence reuses the `issues` row (`classification`/a new `pr_rank` column) keyed by the
PR's `issue_key`.

---

## 10. Worker completion gate (`src/worker.py`)

- `_needs_completion_reminder`: extend so `task_kind == "review_pr"` reminds until
  `submit_pr_review` is in `tools_called` (the terminal action), mirroring the
  `_TERMINAL_TRIAGE_TOOLS` logic. Add a `_TERMINAL_REVIEW_TOOLS = {"submit_pr_review", "abort_task"}`.
  Review worktrees are read-only, so the dirty-state reminder is irrelevant — skip it for
  `review_pr` (or it'll be clean anyway).
- `run_task`: thread `review_mode`/`pr` through to `ToolBindings`/`_build_prompt` (§5, §7).

---

## 11. Config (`src/config.py`) — optional

Add `pr_review_enabled: bool = True` (`ROBOMP_PR_REVIEW_ENABLED`) so the whole flow can be
killed without a redeploy; check it in `route()`'s new branch. Reuse the existing
`repo_allowlist`, `maintainers`, `reviewer_bots`. No new auth.

---

## 12. Routing truth table

| Event | Condition | Result |
|---|---|---|
| `pull_request.opened` / `reopened` / `ready_for_review` | non-draft, author ≠ bot, allowlisted, enabled | **`review_pr`** |
| `pull_request.opened` | draft / bot-authored | skip |
| `pull_request.synchronize` (new commits) | — | **skip** (no re-review) |
| `pull_request.edited` / others | — | skip |
| `issue_comment.created` on incoming PR | not a directive | **skip** |
| `issue_comment.created` on incoming PR | maintainer `@bot` / reviewer bot | directive path (may re-review) |
| `issue_comment.created` on bot PR | — | `handle_pr_conversation` (unchanged) |
| `pull_request.closed` | has review workspace | `cleanup_workspace` |

---

## 13. Test plan (`tests/`, `pytest`, `httpx.MockTransport`)

Mirror existing test style; assert observable contracts, never internals.

- **Routing** (`test_github_events.py`): `pull_request.opened` → `review_pr`; draft/bot/non-allowlist
  → skip; `synchronize` → skip; incoming-PR comment → skip unless directive.
- **classify_pr** (`test_host_tools.py`): happy path applies `triaged`+`review:pN`+type+area
  (assert the labels in the mocked `add_issue_labels` call); bad rank → validation error; unknown
  area dropped silently.
- **Staging + submit**: `pr_review_comment` writes rows (assert via DB); `submit_pr_review` posts
  one review with all staged comments + `event="COMMENT"` (assert the mocked POST body) and clears
  the buffer; second submit with empty buffer posts summary-only / no-ops.
- **review_mode gating**: `gh_push_branch`/`gh_open_pr` refuse under `review_mode`; review tools
  refuse outside it.
- **Sandbox** (`test_sandbox.py`, real local bare repo as upstream): `pr_head` checkout yields a
  detached worktree at the PR head commit; no push remote configured.
- **Completion gate**: a `review_pr` turn ending before `submit_pr_review` triggers the reminder.

Do **not** enable the integration smoke (`ROBOMP_INTEGRATION=1`) in the default suite.

---

## 14. Open questions for @can1357

1. **Rank label namespace**: `review:p0..p3` (proposed, avoids colliding with issue `prio:p0..p3`)
   — or reuse `prio:`? These must exist (or be auto-creatable) as repo labels.
2. **`type` labels**: introduce `feat`/`fix`/`docs`/… as bare labels, or namespace `type:feat`?
   The repo's current label set should be checked before `classify_pr` writes them.
3. **Re-review trigger phrasing**: which directive text re-runs Phase 2 vs. just answers a
   question? (Routed through the existing directive path.)
4. **Cleanup**: GC incoming-PR review worktrees on `pull_request.closed` (any author), or a TTL
   sweep? (§2c.)
