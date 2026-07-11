"""Client half of the roboomp ↔ gh-proxy channel.

`GitHubProxyClient` implements `GitHubBackend` by HMAC-signing each request
and forwarding to gh-proxy. `ProxyGitTransport` implements `GitTransport` by
routing clone/fetch/push through the proxy too — roboomp never holds the PAT.

Both classes share an `httpx.AsyncClient` + `httpx.Client` against the proxy.
Tests can inject a custom transport (`httpx.MockTransport` or `ASGITransport`)
to short-circuit the network.
"""

from __future__ import annotations

import json
import asyncio
import time
import logging
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import httpx

from robomp.git_ops import GitCommandError, HeadDriftError, PushResult
from robomp.github_client import (
    CommentInfo,
    GitHubError,
    IssueInfo,
    IssueSummary,
    PullRequestFileInfo,
    PullRequestInfo,
    PullRequestReviewInfo,
    ReactionInfo,
    RepoInfo,
    ReviewCommentInfo,
)
from robomp.proxy_hmac import HEADER_SIGNATURE, HEADER_TIMESTAMP, sign

log = logging.getLogger(__name__)


# ---------- error decoding ----------


def _decode_error(resp: httpx.Response) -> Exception:
    """Map a non-2xx response from gh-proxy back to a domain exception.

    Proxy errors wrap the GitHub or git failure in `{"error": {...}}`.
    Anything else is collapsed to a generic GitHubError-shaped exception
    so callers see a consistent surface.
    """
    body: Any
    try:
        body = resp.json()
    except Exception:
        body = None
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        err = body["error"]
        kind = err.get("kind")
        if kind == "github":
            return GitHubError(
                int(err.get("status") or resp.status_code),
                str(err.get("message") or "github error"),
                retry_after=err.get("retry_after"),
            )
        if kind in ("git", "head_drift"):
            cmd = err.get("cmd") or ["git"]
            stdout = str(err.get("stdout") or "")
            stderr = str(err.get("stderr") or "")
            returncode = int(err.get("returncode") or 1)
            klass = HeadDriftError if kind == "head_drift" else GitCommandError
            return klass(list(cmd), returncode, stdout, stderr)
    return GitHubError(resp.status_code, resp.text or "proxy error")


# ---------- signing helpers ----------


def _signed_headers(method: str, target: str, body: bytes, key: bytes) -> dict[str, str]:
    """Return signing headers for an already-canonicalized request target.

    `target` is `path` for query-less requests and `path?query` for GETs
    that carry parameters. It MUST byte-for-byte match the server-side
    `_request_target(request)` so HMAC verification succeeds — that's why
    the async path below builds an `httpx.Request` first and reads the
    encoded URL back out rather than re-encoding params here.
    """
    ts, sig = sign(method=method, path=target, body=body, key=key)
    return {HEADER_TIMESTAMP: ts, HEADER_SIGNATURE: sig}


# ---------- GitHubProxyClient ----------


class GitHubProxyClient:
    """HMAC-signed REST client speaking to a `robomp.proxy.server` instance.

    Implements `GitHubBackend` (duck-typed). Returns the same typed
    dataclasses as the in-process `GitHubClient`, so call sites in worker,
    tasks, host_tools, server, and CLI work unchanged.
    """

    def __init__(
        self,
        *,
        base_url: str,
        hmac_key: str | bytes,
        transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._key = hmac_key.encode("utf-8") if isinstance(hmac_key, str) else hmac_key
        self._transport = transport
        self._timeout = httpx.Timeout(timeout, connect=10.0)

    def _async_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self._base_url,
            transport=self._transport,  # type: ignore[arg-type]
            timeout=self._timeout,
        )

    _TRANSIENT_RETRY_DELAYS = (1.0, 3.0, 10.0)

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json_body: Mapping[str, Any] | None = None,
    ) -> Any:
        body_bytes = b"" if json_body is None else json.dumps(json_body).encode("utf-8")
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                async with self._async_client() as client:
                    req = client.build_request(
                        method,
                        path,
                        params=params,
                        content=body_bytes if json_body is not None else None,
                    )
                    target = req.url.path
                    if req.url.query:
                        target = f"{target}?{req.url.query.decode('ascii')}"
                    req.headers.update(_signed_headers(method, target, body_bytes, self._key))
                    if json_body is not None:
                        req.headers["Content-Type"] = "application/json"
                    resp = await client.send(req)
                if resp.status_code >= 400:
                    raise _decode_error(resp)
                if resp.status_code == 204 or not resp.content:
                    return None
                return resp.json()
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "proxy client transient error, retrying",
                    extra={"method": method, "path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                await asyncio.sleep(delay)
        raise last_exc  # type: ignore[misc]

    # ---- reads ----
    async def get_repo(self, repo: str) -> RepoInfo:
        data = await self._request("GET", "/gh/v1/repo", params={"repo": repo})
        return _repo_from(data)

    async def get_issue(self, repo: str, number: int) -> IssueInfo:
        data = await self._request("GET", "/gh/v1/issue", params={"repo": repo, "number": number})
        return _issue_from(data)

    async def list_closing_pull_requests(self, repo: str, number: int) -> tuple[int, ...]:
        data = await self._request("GET", "/gh/v1/closing_prs", params={"repo": repo, "number": number})
        items = data.get("pr_numbers") if isinstance(data, dict) else None
        return tuple(int(n) for n in items or () if isinstance(n, int))

    async def get_pull_request(self, repo: str, number: int) -> PullRequestInfo:
        data = await self._request("GET", "/gh/v1/pull_request", params={"repo": repo, "number": number})
        return _pr_from(data)

    async def list_pr_files(self, repo: str, pr_number: int) -> list[PullRequestFileInfo]:
        data = await self._request(
            "GET",
            "/gh/v1/pr_files",
            params={"repo": repo, "pr_number": pr_number},
        )
        return [_pr_file_from(item) for item in (data.get("items") if isinstance(data, dict) else None) or []]

    async def list_issues(
        self,
        repo: str,
        *,
        state: str = "open",
        limit: int = 30,
    ) -> list[IssueSummary]:
        data = await self._request(
            "GET",
            "/gh/v1/issues",
            params={"repo": repo, "state": state, "limit": limit},
        )
        return [_issue_summary_from(item) for item in (data.get("items") if isinstance(data, dict) else None) or []]

    async def list_comments(self, repo: str, number: int) -> list[CommentInfo]:
        data = await self._request("GET", "/gh/v1/comments", params={"repo": repo, "number": number})
        return [_comment_from(item) for item in (data.get("items") if isinstance(data, dict) else None) or []]

    async def list_review_comments(self, repo: str, pr_number: int) -> list[ReviewCommentInfo]:
        data = await self._request(
            "GET",
            "/gh/v1/review_comments",
            params={"repo": repo, "pr_number": pr_number},
        )
        return [_review_comment_from(item) for item in (data.get("items") if isinstance(data, dict) else None) or []]

    async def list_pr_reviews(self, repo: str, pr_number: int) -> list[PullRequestReviewInfo]:
        data = await self._request(
            "GET",
            "/gh/v1/pr_reviews",
            params={"repo": repo, "pr_number": pr_number},
        )
        return [_pr_review_from(item) for item in (data.get("items") if isinstance(data, dict) else None) or []]

    async def get_authenticated_login(self) -> str:
        data = await self._request("GET", "/gh/v1/authenticated_login")
        return str(data["login"]) if isinstance(data, dict) else ""

    # ---- writes ----
    async def post_comment(self, repo: str, number: int, body: str) -> CommentInfo:
        data = await self._request(
            "POST",
            "/gh/v1/post_comment",
            json_body={"repo": repo, "number": number, "body": body},
        )
        return _comment_from(data)

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
        data = await self._request(
            "POST",
            "/gh/v1/open_pull_request",
            json_body={
                "repo": repo,
                "head": head,
                "base": base,
                "title": title,
                "body": body,
                "draft": draft,
                "maintainer_can_modify": maintainer_can_modify,
            },
        )
        return _pr_from(data)

    async def request_reviewers(
        self,
        *,
        repo: str,
        pr_number: int,
        reviewers: list[str] | None = None,
        team_reviewers: list[str] | None = None,
    ) -> None:
        if not reviewers and not team_reviewers:
            return
        await self._request(
            "POST",
            "/gh/v1/request_reviewers",
            json_body={
                "repo": repo,
                "pr_number": pr_number,
                "reviewers": reviewers,
                "team_reviewers": team_reviewers,
            },
        )

    async def add_issue_labels(self, repo: str, number: int, labels: list[str]) -> tuple[str, ...]:
        if not labels:
            return ()
        data = await self._request(
            "POST",
            "/gh/v1/add_issue_labels",
            json_body={"repo": repo, "number": number, "labels": labels},
        )
        return tuple(str(lbl) for lbl in (data.get("labels") if isinstance(data, dict) else None) or [])

    async def remove_issue_label(self, repo: str, number: int, label: str) -> None:
        if not label:
            return
        await self._request(
            "POST",
            "/gh/v1/remove_issue_label",
            json_body={"repo": repo, "number": number, "label": label},
        )

    async def submit_pr_review(
        self,
        *,
        repo: str,
        pr_number: int,
        body: str,
        event: str,
        comments: list[Mapping[str, Any]],
    ) -> PullRequestReviewInfo:
        data = await self._request(
            "POST",
            "/gh/v1/submit_pr_review",
            json_body={
                "repo": repo,
                "pr_number": pr_number,
                "body": body,
                "event": event,
                "comments": comments,
            },
        )
        return _pr_review_from(data)

    async def add_assignees(self, repo: str, number: int, assignees: list[str]) -> None:
        if not assignees:
            return
        await self._request(
            "POST",
            "/gh/v1/add_assignees",
            json_body={"repo": repo, "number": number, "assignees": assignees},
        )

    async def list_comment_reactions(self, repo: str, comment_id: int) -> tuple[ReactionInfo, ...]:
        data = await self._request(
            "GET",
            "/gh/v1/comment_reactions",
            params={"repo": repo, "comment_id": comment_id},
        )
        items = data.get("items") if isinstance(data, dict) else None
        return tuple(_reaction_from(item) for item in items or ())

    async def close_issue(self, repo: str, number: int, *, reason: str = "completed") -> None:
        await self._request(
            "POST",
            "/gh/v1/close_issue",
            json_body={"repo": repo, "number": number, "reason": reason},
        )


# ---------- ProxyGitTransport ----------


class ProxyGitTransport:
    """Routes clone/fetch/push to gh-proxy over the same HMAC channel.

    Uses a synchronous httpx client because the SandboxManager call sites
    are synchronous; the proxy itself is asynchronous internally but we
    bridge with a one-shot sync request per call.
    """

    __slots__ = ("_base_url", "_key", "_transport", "_timeout")

    def __init__(
        self,
        *,
        base_url: str,
        hmac_key: str | bytes,
        transport: httpx.BaseTransport | None = None,
        timeout: float = 120.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._key = hmac_key.encode("utf-8") if isinstance(hmac_key, str) else hmac_key
        self._transport = transport
        self._timeout = httpx.Timeout(timeout, connect=10.0)

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=self._base_url,
            transport=self._transport,
            timeout=self._timeout,
        )

    _TRANSIENT_RETRY_DELAYS = (2.0, 5.0, 15.0)

    def _post(self, path: str, body: Mapping[str, Any]) -> Mapping[str, Any]:
        body_bytes = json.dumps(body).encode("utf-8")
        last_exc: Exception | None = None
        for attempt, delay in enumerate((*self._TRANSIENT_RETRY_DELAYS, None)):
            try:
                headers = _signed_headers("POST", path, body_bytes, self._key)
                headers["Content-Type"] = "application/json"
                with self._client() as client:
                    resp = client.request("POST", path, content=body_bytes, headers=headers)
                if resp.status_code >= 400:
                    raise _decode_error(resp)
                if resp.status_code == 204 or not resp.content:
                    return {}
                data = resp.json()
                return data if isinstance(data, dict) else {}
            except (httpx.ConnectError, httpx.TimeoutException) as exc:
                last_exc = exc
                if delay is None:
                    break
                log.warning(
                    "proxy transport transient error, retrying",
                    extra={"path": path, "attempt": attempt + 1, "delay": delay, "error": str(exc)},
                )
                time.sleep(delay)
        raise last_exc  # type: ignore[misc]

    def clone_pool(self, *, repo: str, clone_url: str, default_branch: str, target: Path) -> None:
        del target  # remote-resolved on the proxy side from `repo`
        self._post(
            "/gh/v1/git/clone",
            {"repo": repo, "clone_url": clone_url, "default_branch": default_branch},
        )

    def fetch_pool(self, *, repo: str, pool_dir: Path) -> None:
        del pool_dir
        self._post("/gh/v1/git/fetch", {"repo": repo})

    def fetch_base_ref(self, *, repo: str, pool_dir: Path, ref: str) -> None:
        del pool_dir
        self._post("/gh/v1/git/fetch_ref", {"repo": repo, "ref": ref})

    def fetch_pr_head(self, *, repo: str, pool_dir: Path, pr_number: int) -> None:
        del pool_dir
        self._post("/gh/v1/git/fetch_pr_head", {"repo": repo, "pr_number": pr_number})

    def push_branch(
        self,
        *,
        repo: str,
        workspace_key: str,
        repo_dir: Path,
        branch: str,
        expected_head: str,
        slot_uid: int | None = None,
    ) -> PushResult:
        del repo_dir
        body: dict[str, Any] = {
            "repo": repo,
            "workspace_key": workspace_key,
            "branch": branch,
            "expected_head": expected_head,
        }
        if slot_uid is not None:
            body["slot_uid"] = slot_uid
        data = self._post("/gh/v1/git/push", body)
        return PushResult(head=str(data.get("head") or expected_head), branch=str(data.get("branch") or branch))


# ---------- payload helpers ----------


def _repo_from(data: Any) -> RepoInfo:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed repo payload")
    return RepoInfo(
        full_name=str(data["full_name"]),
        default_branch=str(data["default_branch"]),
        clone_url=str(data["clone_url"]),
        private=bool(data.get("private", False)),
    )


def _issue_from(data: Any) -> IssueInfo:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed issue payload")
    labels = data.get("labels") or []
    return IssueInfo(
        repo=str(data["repo"]),
        number=int(data["number"]),
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
        state=str(data.get("state") or "open"),
        author=str(data.get("author") or ""),
        labels=tuple(str(x) for x in labels),
        is_pull_request=bool(data.get("is_pull_request", False)),
    )


def _issue_summary_from(data: Any) -> IssueSummary:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed issue summary payload")
    return IssueSummary(
        repo=str(data["repo"]),
        number=int(data["number"]),
        title=str(data.get("title") or ""),
        state=str(data.get("state") or ""),
        author=str(data.get("author") or ""),
        labels=tuple(str(x) for x in (data.get("labels") or [])),
        comments=int(data.get("comments") or 0),
        updated_at=str(data.get("updated_at") or ""),
        created_at=str(data.get("created_at") or ""),
        html_url=str(data.get("html_url") or ""),
    )


def _comment_from(data: Any) -> CommentInfo:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed comment payload")
    return CommentInfo(
        id=int(data["id"]),
        author=str(data.get("author") or ""),
        body=str(data.get("body") or ""),
        created_at=str(data.get("created_at") or ""),
    )


def _reaction_from(data: Any) -> ReactionInfo:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed reaction payload")
    return ReactionInfo(
        content=str(data.get("content") or ""),
        user_login=str(data.get("user_login") or ""),
        user_type=str(data.get("user_type") or ""),
    )


def _review_comment_from(data: Any) -> ReviewCommentInfo:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed review_comment payload")
    line = data.get("line")
    return ReviewCommentInfo(
        id=int(data.get("id") or 0),
        author=str(data.get("author") or ""),
        body=str(data.get("body") or ""),
        path=str(data.get("path") or ""),
        line=line if isinstance(line, int) else None,
        created_at=str(data.get("created_at") or ""),
    )


def _pr_review_from(data: Any) -> PullRequestReviewInfo:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed pr_review payload")
    return PullRequestReviewInfo(
        id=int(data.get("id") or 0),
        author=str(data.get("author") or ""),
        body=str(data.get("body") or ""),
        state=str(data.get("state") or ""),
        submitted_at=str(data.get("submitted_at") or ""),
    )


def _pr_file_from(data: Any) -> PullRequestFileInfo:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed pr_file payload")
    return PullRequestFileInfo(
        path=str(data.get("path") or ""),
        status=str(data.get("status") or ""),
        additions=int(data.get("additions") or 0),
        deletions=int(data.get("deletions") or 0),
    )


def _pr_from(data: Any) -> PullRequestInfo:
    if not isinstance(data, dict):
        raise GitHubError(500, "proxy returned malformed pr payload")
    return PullRequestInfo(
        repo=str(data["repo"]),
        number=int(data["number"]),
        html_url=str(data["html_url"]),
        head_ref=str(data.get("head_ref") or ""),
        base_ref=str(data.get("base_ref") or ""),
        state=str(data.get("state") or "open"),
        author=str(data.get("author") or ""),
        head_repo=str(data.get("head_repo") or ""),
        title=str(data.get("title") or ""),
        body=str(data.get("body") or ""),
    )


__all__ = ["GitHubProxyClient", "ProxyGitTransport"]
