"""Minimal typed GitHub REST client (PAT auth, httpx)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

GITHUB_API = "https://api.github.com"
ACCEPT = "application/vnd.github+json"
API_VERSION = "2022-11-28"


class GitHubError(RuntimeError):
    """Raised on non-2xx responses from GitHub."""

    def __init__(self, status: int, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(f"GitHub {status}: {message}")
        self.status = status
        self.message = message
        self.retry_after = retry_after


@dataclass(slots=True, frozen=True)
class IssueInfo:
    repo: str
    number: int
    title: str
    body: str
    state: str
    author: str
    labels: tuple[str, ...]
    is_pull_request: bool


@dataclass(slots=True, frozen=True)
class CommentInfo:
    id: int
    author: str
    body: str
    created_at: str


@dataclass(slots=True, frozen=True)
class RepoInfo:
    full_name: str
    default_branch: str
    clone_url: str
    private: bool


@dataclass(slots=True, frozen=True)
class PullRequestInfo:
    repo: str
    number: int
    html_url: str
    head_ref: str
    base_ref: str
    state: str
    author: str = ""
    head_repo: str = ""
    title: str = ""
    body: str = ""
    head_sha: str = ""


@dataclass(slots=True, frozen=True)
class PullRequestFileInfo:
    path: str
    status: str
    additions: int
    deletions: int
    patch: str = ""


@dataclass(slots=True, frozen=True)
class WorkflowRunInfo:
    """GitHub Actions workflow run for release verdict aggregation."""

    id: int
    name: str
    event: str
    status: str
    conclusion: str | None
    head_branch: str | None
    head_sha: str
    html_url: str
    run_attempt: int


@dataclass(slots=True, frozen=True)
class WorkflowJobInfo:
    """GitHub Actions job with its failed step names."""

    id: int
    run_id: int
    name: str
    status: str
    conclusion: str | None
    html_url: str
    failed_steps: tuple[str, ...]


@dataclass(slots=True, frozen=True)
class ReleaseInfo:
    """Published GitHub Release metadata for a tag."""

    tag: str
    name: str | None
    draft: bool
    prerelease: bool
    html_url: str
    asset_names: tuple[str, ...]


@dataclass(slots=True, frozen=True)
class ReviewCommentInfo:
    """In-line PR review comment (attached to a file/line)."""

    id: int
    author: str
    body: str
    path: str
    line: int | None
    created_at: str


@dataclass(slots=True, frozen=True)
class PullRequestReviewInfo:
    """Top-level PR review (the summary block, not the inline comments)."""

    id: int
    author: str
    body: str
    state: str  # APPROVED / CHANGES_REQUESTED / COMMENTED
    submitted_at: str


@dataclass(slots=True, frozen=True)
class IssueSummary:
    """Lightweight projection of an issue for list views (no body)."""

    repo: str
    number: int
    title: str
    state: str
    author: str
    labels: tuple[str, ...]
    comments: int
    updated_at: str
    created_at: str
    html_url: str
    # `completed` / `not_planned` / `reopened` when closed; empty otherwise.
    state_reason: str = ""
    # Search results mix issues and PRs; list_issues always yields issues.
    is_pull_request: bool = False


@dataclass(slots=True, frozen=True)
class IssueIndexEntry:
    """Full projection of an issue/PR for the local search index (includes body).

    Produced by `GitHubClient.list_issue_index_entries` / webhook payloads and
    stored verbatim in the orchestrator's `issue_index` table.
    """

    repo: str
    number: int
    is_pull_request: bool
    title: str
    body: str
    state: str  # open | closed
    state_reason: str  # completed | not_planned | reopened | ""
    merged_at: str  # ISO timestamp for merged PRs; "" otherwise
    author: str
    labels: tuple[str, ...]
    comments: int
    created_at: str
    updated_at: str
    html_url: str


@dataclass(slots=True, frozen=True)
class ReactionInfo:
    """A reaction on an issue/comment.

    `content` is GitHub's reaction string: `+1`, `-1`, `laugh`, `hooray`,
    `confused`, `heart`, `rocket`, `eyes`. The auto-close scheduler only
    looks at `-1` (👎) reactions from the issue's original author.
    """

    content: str
    user_login: str
    user_type: str


def _parse_retry_after(resp: httpx.Response) -> float | None:
    ra = resp.headers.get("retry-after")
    if ra:
        try:
            return float(ra)
        except ValueError:
            pass
    reset = resp.headers.get("x-ratelimit-reset")
    if reset:
        try:
            return max(0.0, float(reset) - time.time())
        except ValueError:
            pass
    return None


class GitHubClient:
    """Async + sync facades over a small slice of the GitHub REST API."""

    def __init__(
        self,
        token: str,
        *,
        transport: httpx.BaseTransport | None = None,
        platform: str = "github",
    ) -> None:
        self._token = token
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Accept": ACCEPT,
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "robomp/0.1",
        }
        self._transport = transport
        self._platform = platform

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=GITHUB_API,
            headers=self._headers,
            transport=self._transport,
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

    def _async_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=GITHUB_API,
            headers=self._headers,
            transport=self._transport,  # type: ignore[arg-type]
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

    # ---- request helpers ----
    def _check(self, resp: httpx.Response) -> Any:
        if resp.status_code >= 400:
            retry_after = _parse_retry_after(resp)
            try:
                msg = resp.json().get("message", resp.text)
            except Exception:
                msg = resp.text
            raise GitHubError(resp.status_code, str(msg), retry_after=retry_after)
        if resp.status_code >= 300:
            # Redirect we couldn't (or weren't asked to) follow. GitHub uses 301
            # for transferred repos / issues. Surface as a normal error so host
            # tools map it to RpcCommandError instead of mis-parsing the body.
            location = resp.headers.get("location", "")
            raise GitHubError(
                resp.status_code,
                f"unexpected redirect to {location!r}; resource may have moved",
            )
        if resp.status_code == 204 or not resp.content:
            return None
        return resp.json()

    _TRANSIENT_RETRY_DELAYS = (1.0, 3.0, 10.0)
    """Backoff schedule for transient connection/timeout/5xx errors."""

    _TRANSIENT_STATUSES = frozenset({500, 502, 503, 504})
    """Upstream statuses treated as transient — retried for idempotent methods only."""

    _IDEMPOTENT_METHODS = frozenset({"GET", "HEAD"})
    """Methods safe to replay: a lost response cannot have caused a visible write."""

    def _transient_5xx(self, method: str, exc: GitHubError) -> bool:
        return method.upper() in self._IDEMPOTENT_METHODS and exc.status in self._TRANSIENT_STATUSES

    def request_sync(
        self, method: str, path: str, *, json: Mapping[str, Any] | None = None, params: Mapping[str, Any] | None = None
    ) -> Any:
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                with self._client() as client:
                    resp = client.request(method, path, json=json, params=params)
                    return self._check(resp)
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "transient error, retrying",
                    extra={"method": method, "path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                time.sleep(delay)
            except GitHubError as exc:
                if delay is None or not self._transient_5xx(method, exc):
                    raise
                last_exc = exc
                log.warning(
                    "transient github 5xx, retrying",
                    extra={
                        "method": method,
                        "path": path,
                        "attempt": attempt + 1,
                        "delay": delay,
                        "status": exc.status,
                    },
                )
                time.sleep(delay)
        raise last_exc  # type: ignore[misc]

    async def request(
        self, method: str, path: str, *, json: Mapping[str, Any] | None = None, params: Mapping[str, Any] | None = None
    ) -> Any:
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                async with self._async_client() as client:
                    resp = await client.request(method, path, json=json, params=params)
                    return self._check(resp)
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "transient error, retrying",
                    extra={"method": method, "path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                await asyncio.sleep(delay)
            except GitHubError as exc:
                if delay is None or not self._transient_5xx(method, exc):
                    raise
                last_exc = exc
                log.warning(
                    "transient github 5xx, retrying",
                    extra={
                        "method": method,
                        "path": path,
                        "attempt": attempt + 1,
                        "delay": delay,
                        "status": exc.status,
                    },
                )
                await asyncio.sleep(delay)
        raise last_exc  # type: ignore[misc]

    async def _request_text_tail(self, path: str, *, max_bytes: int) -> str:
        """Stream a text response while retaining at most its final bytes."""
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                async with self._async_client() as client:
                    async with client.stream("GET", path) as resp:
                        if resp.status_code >= 300:
                            await resp.aread()
                            self._check(resp)
                        tail = bytearray()
                        async for chunk in resp.aiter_bytes():
                            tail.extend(chunk)
                            overflow = len(tail) - max_bytes
                            if overflow > 0:
                                del tail[:overflow]
                        return tail.decode("utf-8", errors="replace")
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "transient text fetch error, retrying",
                    extra={"path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                await asyncio.sleep(delay)
            except GitHubError as exc:
                if delay is None or not self._transient_5xx("GET", exc):
                    raise
                last_exc = exc
                log.warning(
                    "transient github text fetch 5xx, retrying",
                    extra={"path": path, "attempt": attempt + 1, "delay": delay, "status": exc.status},
                )
                await asyncio.sleep(delay)
        raise last_exc  # type: ignore[misc]

    # ---- repos / issues / comments / PRs ----
    async def get_repo(self, repo: str) -> RepoInfo:
        data = await self.request("GET", f"/repos/{repo}")
        return _repo_from_payload(data)

    async def list_workflow_runs(self, repo: str, *, head_sha: str) -> list[WorkflowRunInfo]:
        """List workflow runs attached to one commit."""
        data = await self.request(
            "GET",
            f"/repos/{repo}/actions/runs",
            params={"head_sha": head_sha, "per_page": 100},
        )
        return [_workflow_run_from_payload(item) for item in (data or {}).get("workflow_runs") or []]

    async def list_workflow_jobs(self, repo: str, run_id: int) -> list[WorkflowJobInfo]:
        """List the latest jobs for a workflow run."""
        data = await self.request(
            "GET",
            f"/repos/{repo}/actions/runs/{run_id}/jobs",
            params={"filter": "latest", "per_page": 100},
        )
        return [_workflow_job_from_payload(item) for item in (data or {}).get("jobs") or []]

    async def get_job_log_tail(self, repo: str, job_id: int, *, tail_lines: int = 200) -> str:
        """Return the final lines of a GitHub Actions job log."""
        limit = max(0, int(tail_lines))
        if limit == 0:
            return ""
        text = await self._request_text_tail(
            f"/repos/{repo}/actions/jobs/{job_id}/logs",
            max_bytes=4 * 1024 * 1024,
        )
        return "\n".join(text.splitlines()[-limit:])

    async def get_tag_sha(self, repo: str, tag: str) -> str | None:
        """Resolve a lightweight or annotated tag to its commit SHA."""
        encoded_tag = quote(tag, safe="")
        try:
            data = await self.request("GET", f"/repos/{repo}/git/ref/tags/{encoded_tag}")
        except GitHubError as exc:
            if exc.status == 404:
                return None
            raise
        obj = (data or {}).get("object") or {}
        sha = str(obj.get("sha") or "")
        if obj.get("type") == "tag" and sha:
            annotated = await self.request("GET", f"/repos/{repo}/git/tags/{sha}")
            obj = (annotated or {}).get("object") or {}
            sha = str(obj.get("sha") or "")
        return sha or None

    async def get_release_by_tag(self, repo: str, tag: str) -> ReleaseInfo | None:
        """Return the GitHub Release for a tag when one exists."""
        encoded_tag = quote(tag, safe="")
        try:
            data = await self.request("GET", f"/repos/{repo}/releases/tags/{encoded_tag}")
        except GitHubError as exc:
            if exc.status == 404:
                return None
            raise
        return _release_from_payload(data)

    async def get_issue(self, repo: str, number: int) -> IssueInfo:
        data = await self.request("GET", f"/repos/{repo}/issues/{number}")
        return _issue_from_payload(repo, data)

    async def list_closing_pull_requests(self, repo: str, number: int) -> tuple[int, ...]:
        """Return PR numbers currently linked to issue ``number`` via "Closes"/"Fixes"
        keywords or the Development panel.

        Walks ``GET /repos/{repo}/issues/{N}/timeline`` and computes net
        ``connected`` − ``disconnected`` events for sources that are pull
        requests. Only PRs whose timeline source carries ``state == "open"``
        are returned — a merged or closed PR no longer needs the bot's work.

        Pagination intentionally skipped: a just-opened issue has at most a
        handful of timeline entries, and the bot only consults this on
        ``issues.opened`` triage.
        """
        data = await self.request(
            "GET",
            f"/repos/{repo}/issues/{number}/timeline",
            params={"per_page": 100},
        )
        linked: set[int] = set()
        states: dict[int, str] = {}
        for event in data or []:
            if not isinstance(event, Mapping):
                continue
            ev = event.get("event")
            source = event.get("source") or {}
            src_issue = source.get("issue") if isinstance(source, Mapping) else None
            if not isinstance(src_issue, Mapping) or "pull_request" not in src_issue:
                continue
            pr_number = src_issue.get("number")
            if not isinstance(pr_number, int):
                continue
            states[pr_number] = str(src_issue.get("state") or "open")
            if ev == "connected":
                linked.add(pr_number)
            elif ev == "disconnected":
                linked.discard(pr_number)
        return tuple(sorted(n for n in linked if states.get(n, "open") == "open"))

    async def get_pull_request(self, repo: str, number: int) -> PullRequestInfo:
        data = await self.request("GET", f"/repos/{repo}/pulls/{number}")
        return _pr_from_payload(repo, data)

    async def list_pr_files(self, repo: str, pr_number: int) -> list[PullRequestFileInfo]:
        files: list[PullRequestFileInfo] = []
        page = 1
        while True:
            data = await self.request(
                "GET",
                f"/repos/{repo}/pulls/{pr_number}/files",
                params={"per_page": 100, "page": page},
            )
            batch = [_pr_file_from_payload(item) for item in (data or [])]
            files.extend(batch)
            if len(batch) < 100:
                return files
            page += 1

    async def list_issues(
        self,
        repo: str,
        *,
        state: str = "open",
        limit: int = 30,
    ) -> list[IssueSummary]:
        """List recent issues for `repo`, newest-updated first. Excludes pull requests.

        `state` is one of `open`, `closed`, `all`. `limit` is capped at 100 by the
        GitHub `per_page`; we don't paginate here — the dashboard browse view shows
        a recent slice, not every issue ever.
        """
        if state not in ("open", "closed", "all"):
            raise ValueError(f"invalid state: {state!r}")
        per_page = max(1, min(int(limit), 100))
        data = await self.request(
            "GET",
            f"/repos/{repo}/issues",
            params={"state": state, "per_page": per_page, "sort": "updated", "direction": "desc"},
        )
        out: list[IssueSummary] = []
        for item in data or []:
            if "pull_request" in item:
                continue  # GitHub's /issues endpoint also returns PRs; skip them.
            out.append(_summary_from_item(repo, item))
        return out

    async def search_issues(self, repo: str, query: str, *, limit: int = 10) -> list[IssueSummary]:
        """Search issues AND pull requests in `repo` using GitHub issue-search syntax.

        `query` takes bare keywords plus qualifiers (`is:pr`, `is:closed`,
        `label:bug`, `in:title`, …); the `repo:` scope is applied here. Results
        come back in GitHub's best-match order. `limit` is capped at 30 — this
        serves triage lookups (duplicates, prior fixes), not pagination.
        """
        per_page = max(1, min(int(limit), 30))
        data = await self.request(
            "GET",
            "/search/issues",
            params={"q": f"repo:{repo} {query}".strip(), "per_page": per_page},
        )
        items = (data or {}).get("items") or []
        return [_summary_from_item(repo, item) for item in items]

    async def list_issue_index_entries(
        self,
        repo: str,
        *,
        since: str | None = None,
        page: int = 1,
        per_page: int = 100,
    ) -> list[IssueIndexEntry]:
        """One page of issues AND PRs (with bodies) for the local search index.

        `since` is GitHub's ISO `updated_at` lower bound; omit for a full
        backfill. Callers page from 1 until a short page comes back.
        """
        params: dict[str, Any] = {
            "state": "all",
            "per_page": max(1, min(int(per_page), 100)),
            "page": max(1, int(page)),
            "sort": "updated",
            "direction": "asc",
        }
        if since:
            params["since"] = since
        data = await self.request("GET", f"/repos/{repo}/issues", params=params)
        return [index_entry_from_issue_object(repo, item) for item in (data or [])]

    async def list_comments(self, repo: str, number: int) -> list[CommentInfo]:
        data = await self.request("GET", f"/repos/{repo}/issues/{number}/comments", params={"per_page": 100})
        return [_comment_from_payload(item) for item in (data or [])]

    async def list_review_comments(self, repo: str, pr_number: int) -> list[ReviewCommentInfo]:
        """List inline review comments on a PR (the ones attached to a path:line)."""
        data = await self.request(
            "GET",
            f"/repos/{repo}/pulls/{pr_number}/comments",
            params={"per_page": 100},
        )
        out: list[ReviewCommentInfo] = []
        for item in data or []:
            user = item.get("user") or {}
            line = item.get("line")
            if not isinstance(line, int):
                orig = item.get("original_line")
                line = orig if isinstance(orig, int) else None
            out.append(
                ReviewCommentInfo(
                    id=int(item.get("id") or 0),
                    author=str(user.get("login") or ""),
                    body=str(item.get("body") or ""),
                    path=str(item.get("path") or ""),
                    line=line,
                    created_at=str(item.get("created_at") or ""),
                )
            )
        return out

    async def list_pr_reviews(self, repo: str, pr_number: int) -> list[PullRequestReviewInfo]:
        """List top-level reviews on a PR. Empty-body reviews are skipped — they
        carry no novel text beyond what the inline comments + merge state convey."""
        data = await self.request(
            "GET",
            f"/repos/{repo}/pulls/{pr_number}/reviews",
            params={"per_page": 100},
        )
        out: list[PullRequestReviewInfo] = []
        for item in data or []:
            user = item.get("user") or {}
            body = str(item.get("body") or "").strip()
            if not body:
                continue
            out.append(
                PullRequestReviewInfo(
                    id=int(item.get("id") or 0),
                    author=str(user.get("login") or ""),
                    body=body,
                    state=str(item.get("state") or ""),
                    submitted_at=str(item.get("submitted_at") or item.get("created_at") or ""),
                )
            )
        return out

    async def post_comment(self, repo: str, number: int, body: str) -> CommentInfo:
        data = await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/comments",
            json={"body": body},
        )
        return _comment_from_payload(data)

    async def open_pull_request(
        self,
        *,
        repo: str,
        head: str,
        base: str,
        title: str,
        body: str,
        draft: bool = False,
        maintainer_can_modify: bool = True,
    ) -> PullRequestInfo:
        data = await self.request(
            "POST",
            f"/repos/{repo}/pulls",
            json={
                "title": title,
                "body": body,
                "head": head,
                "base": base,
                "draft": draft,
                "maintainer_can_modify": maintainer_can_modify,
            },
        )
        return _pr_from_payload(repo, data)

    async def request_reviewers(
        self,
        *,
        repo: str,
        pr_number: int,
        reviewers: list[str] | None = None,
        team_reviewers: list[str] | None = None,
    ) -> None:
        payload: dict[str, Any] = {}
        if reviewers:
            payload["reviewers"] = reviewers
        if team_reviewers:
            payload["team_reviewers"] = team_reviewers
        if not payload:
            return
        await self.request(
            "POST",
            f"/repos/{repo}/pulls/{pr_number}/requested_reviewers",
            json=payload,
        )

    async def add_issue_labels(self, repo: str, number: int, labels: list[str]) -> tuple[str, ...]:
        """Append labels to an issue (or PR). Returns the full label set after the add.

        Uses `POST /repos/{owner}/{repo}/issues/{n}/labels` which is *additive* —
        we never remove or overwrite existing labels.
        """
        if not labels:
            return ()
        data = await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/labels",
            json={"labels": labels},
        )
        return tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in (data or []))

    async def remove_issue_label(self, repo: str, number: int, label: str) -> None:
        """Remove one label from an issue (or PR)."""
        if not label:
            return
        encoded = quote(label, safe="")
        await self.request(
            "DELETE",
            f"/repos/{repo}/issues/{number}/labels/{encoded}",
        )

    def _review_comments_payload(self, comments: list[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """Adapt canonical host-tool comment shape to the wire schema for this platform.

        GitHub keeps line/side/start_line/start_side; Forgejo only reads
        path/body/new_position (+old_position), so github-only keys are dropped
        and `line` is mapped to `new_position` for RIGHT-side comments or
        `old_position` for LEFT-side (removed-line) comments.
        """
        if self._platform != "forgejo":
            return [dict(c) for c in comments]
        payload: list[dict[str, Any]] = []
        for c in comments:
            entry: dict[str, Any] = {"path": c["path"], "body": c["body"]}
            if str(c.get("side", "RIGHT")).upper() == "LEFT":
                entry["old_position"] = c["line"]
            else:
                entry["new_position"] = c["line"]
            payload.append(entry)
        return payload

    async def submit_pr_review(
        self,
        *,
        repo: str,
        pr_number: int,
        body: str,
        event: str,
        comments: list[Mapping[str, Any]],
        commit_id: str | None = None,
    ) -> PullRequestReviewInfo:
        payload: dict[str, Any] = {"body": body, "event": event, "comments": self._review_comments_payload(comments)}
        if commit_id:
            payload["commit_id"] = commit_id
        data = await self.request("POST", f"/repos/{repo}/pulls/{pr_number}/reviews", json=payload)
        return _pr_review_from_payload(data)

    async def add_assignees(self, repo: str, number: int, assignees: list[str]) -> None:
        if not assignees:
            return
        await self.request(
            "POST",
            f"/repos/{repo}/issues/{number}/assignees",
            json={"assignees": assignees},
        )

    async def list_comment_reactions(self, repo: str, comment_id: int) -> tuple[ReactionInfo, ...]:
        """Reactions on an issue comment, filtered server-side to 👎 (`content=-1`).

        The auto-close scheduler only consults 👎 reactions; filtering server-side
        keeps payloads small even on noisy threads. Returns reactions in the
        order GitHub provides (creation order).
        """
        data = await self.request(
            "GET",
            f"/repos/{repo}/issues/comments/{comment_id}/reactions",
            params={"content": "-1", "per_page": 100},
        )
        return tuple(_reaction_from_payload(item) for item in (data or []))

    async def close_issue(self, repo: str, number: int, *, reason: str = "completed") -> None:
        """Close an issue with `state_reason` (`completed`/`not_planned`/`reopened`)."""
        await self.request(
            "PATCH",
            f"/repos/{repo}/issues/{number}",
            json={"state": "closed", "state_reason": reason},
        )

    async def get_authenticated_login(self) -> str:
        data = await self.request("GET", "/user")
        return str(data["login"])


def _workflow_run_from_payload(data: Mapping[str, Any]) -> WorkflowRunInfo:
    return WorkflowRunInfo(
        id=int(data.get("id") or 0),
        name=str(data.get("name") or ""),
        event=str(data.get("event") or ""),
        status=str(data.get("status") or ""),
        conclusion=str(data["conclusion"]) if data.get("conclusion") is not None else None,
        head_branch=str(data["head_branch"]) if data.get("head_branch") is not None else None,
        head_sha=str(data.get("head_sha") or ""),
        html_url=str(data.get("html_url") or ""),
        run_attempt=int(data.get("run_attempt") or 1),
    )


def _workflow_job_from_payload(data: Mapping[str, Any]) -> WorkflowJobInfo:
    failed_steps = tuple(
        str(step.get("name") or "")
        for step in data.get("steps") or []
        if isinstance(step, Mapping) and step.get("conclusion") not in {"success", "skipped"}
    )
    return WorkflowJobInfo(
        id=int(data.get("id") or 0),
        run_id=int(data.get("run_id") or 0),
        name=str(data.get("name") or ""),
        status=str(data.get("status") or ""),
        conclusion=str(data["conclusion"]) if data.get("conclusion") is not None else None,
        html_url=str(data.get("html_url") or ""),
        failed_steps=failed_steps,
    )


def _release_from_payload(data: Mapping[str, Any]) -> ReleaseInfo:
    name = data.get("name")
    return ReleaseInfo(
        tag=str(data.get("tag_name") or ""),
        name=str(name) if name is not None else None,
        draft=bool(data.get("draft")),
        prerelease=bool(data.get("prerelease")),
        html_url=str(data.get("html_url") or ""),
        asset_names=tuple(
            str(asset.get("name") or "") for asset in data.get("assets") or [] if isinstance(asset, Mapping)
        ),
    )


def _repo_from_payload(data: Mapping[str, Any]) -> RepoInfo:
    return RepoInfo(
        full_name=str(data["full_name"]),
        default_branch=str(data["default_branch"]),
        clone_url=str(data["clone_url"]),
        private=bool(data.get("private", False)),
    )


def _issue_from_payload(repo: str, data: Mapping[str, Any]) -> IssueInfo:
    labels_raw = data.get("labels") or []
    labels = tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in labels_raw)
    user = data.get("user") or {}
    return IssueInfo(
        repo=repo,
        number=int(data["number"]),
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
        state=str(data.get("state") or "open"),
        author=str(user.get("login") or ""),
        labels=labels,
        is_pull_request="pull_request" in data,
    )


def _pr_review_from_payload(data: Mapping[str, Any]) -> PullRequestReviewInfo:
    user = data.get("user") or {}
    body = str(data.get("body") or "").strip()
    return PullRequestReviewInfo(
        id=int(data.get("id") or 0),
        author=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        body=body,
        state=str(data.get("state") or ""),
        submitted_at=str(data.get("submitted_at") or data.get("created_at") or ""),
    )


def _summary_from_item(repo: str, item: Mapping[str, Any]) -> IssueSummary:
    """Build an `IssueSummary` from a REST issue object (list or search shape)."""
    user = item.get("user") or {}
    labels_raw = item.get("labels") or []
    return IssueSummary(
        repo=repo,
        number=int(item["number"]),
        title=str(item.get("title") or ""),
        state=str(item.get("state") or "open"),
        author=str(user.get("login") or ""),
        labels=tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in labels_raw),
        comments=int(item.get("comments") or 0),
        updated_at=str(item.get("updated_at") or ""),
        created_at=str(item.get("created_at") or ""),
        html_url=str(item.get("html_url") or ""),
        state_reason=str(item.get("state_reason") or ""),
        is_pull_request="pull_request" in item,
    )


def index_entry_from_issue_object(repo: str, item: Mapping[str, Any]) -> IssueIndexEntry:
    """Build an `IssueIndexEntry` from a REST *issue-shaped* object.

    Accepts both plain issues and the issue representation of a PR (webhook
    `issues`/`issue_comment` payloads, `/repos/{repo}/issues` items): PRs carry
    a `pull_request` sub-object holding `merged_at`.
    """
    user = item.get("user") or {}
    labels_raw = item.get("labels") or []
    pr_obj = item.get("pull_request")
    is_pr = pr_obj is not None
    merged_at = str(pr_obj.get("merged_at") or "") if isinstance(pr_obj, Mapping) else ""
    return IssueIndexEntry(
        repo=repo,
        number=int(item["number"]),
        is_pull_request=is_pr,
        title=str(item.get("title") or ""),
        body=str(item.get("body") or ""),
        state=str(item.get("state") or "open"),
        state_reason=str(item.get("state_reason") or ""),
        merged_at=merged_at,
        author=str(user.get("login") or ""),
        labels=tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in labels_raw),
        comments=int(item.get("comments") or 0),
        created_at=str(item.get("created_at") or ""),
        updated_at=str(item.get("updated_at") or ""),
        html_url=str(item.get("html_url") or ""),
    )


def index_entry_from_pr_object(repo: str, item: Mapping[str, Any]) -> IssueIndexEntry:
    """Build an `IssueIndexEntry` from a REST *pull-request-shaped* object
    (webhook `pull_request*` payloads), where `merged_at` sits at the top level.
    """
    user = item.get("user") or {}
    labels_raw = item.get("labels") or []
    return IssueIndexEntry(
        repo=repo,
        number=int(item["number"]),
        is_pull_request=True,
        title=str(item.get("title") or ""),
        body=str(item.get("body") or ""),
        state=str(item.get("state") or "open"),
        state_reason="",
        merged_at=str(item.get("merged_at") or ""),
        author=str(user.get("login") or ""),
        labels=tuple(str(lbl["name"]) if isinstance(lbl, dict) else str(lbl) for lbl in labels_raw),
        comments=int(item.get("comments") or 0),
        created_at=str(item.get("created_at") or ""),
        updated_at=str(item.get("updated_at") or ""),
        html_url=str(item.get("html_url") or ""),
    )


def _pr_file_from_payload(data: Mapping[str, Any]) -> PullRequestFileInfo:
    return PullRequestFileInfo(
        path=str(data.get("filename") or data.get("path") or ""),
        status=str(data.get("status") or ""),
        additions=int(data.get("additions") or 0),
        deletions=int(data.get("deletions") or 0),
        patch=str(data.get("patch") or ""),
    )


def _pr_from_payload(repo: str, data: Mapping[str, Any]) -> PullRequestInfo:
    head = data.get("head") or {}
    base = data.get("base") or {}
    user = data.get("user") or {}
    head_repo = head.get("repo") if isinstance(head, Mapping) else None
    return PullRequestInfo(
        repo=repo,
        number=int(data["number"]),
        html_url=str(data["html_url"]),
        head_ref=str(head.get("ref") or "") if isinstance(head, Mapping) else "",
        base_ref=str(base.get("ref") or "") if isinstance(base, Mapping) else "",
        state=str(data.get("state") or "open"),
        author=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        head_repo=str(head_repo.get("full_name") or "") if isinstance(head_repo, Mapping) else "",
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
        head_sha=str(head.get("sha") or "") if isinstance(head, Mapping) else "",
    )


def _comment_from_payload(data: Mapping[str, Any]) -> CommentInfo:
    user = data.get("user") or {}
    return CommentInfo(
        id=int(data["id"]),
        author=str(user.get("login") or ""),
        body=str(data.get("body") or ""),
        created_at=str(data.get("created_at") or ""),
    )


def _reaction_from_payload(data: Mapping[str, Any]) -> ReactionInfo:
    user = data.get("user") or {}
    return ReactionInfo(
        content=str(data.get("content") or ""),
        user_login=str(user.get("login") or "") if isinstance(user, Mapping) else "",
        user_type=str(user.get("type") or "") if isinstance(user, Mapping) else "",
    )


def parse_issue_payload(payload: Mapping[str, Any]) -> tuple[RepoInfo, IssueInfo]:
    """Build typed records from a webhook payload (issues.opened, etc.)."""
    repo_payload = payload["repository"]
    repo = _repo_from_payload(repo_payload)
    issue = _issue_from_payload(repo.full_name, payload["issue"])
    return repo, issue


__all__ = [
    "ACCEPT",
    "API_VERSION",
    "CommentInfo",
    "GitHubClient",
    "GitHubError",
    "IssueIndexEntry",
    "IssueInfo",
    "IssueSummary",
    "ReleaseInfo",
    "PullRequestFileInfo",
    "PullRequestInfo",
    "PullRequestReviewInfo",
    "ReactionInfo",
    "RepoInfo",
    "ReviewCommentInfo",
    "WorkflowJobInfo",
    "WorkflowRunInfo",
    "index_entry_from_issue_object",
    "index_entry_from_pr_object",
    "parse_issue_payload",
]
