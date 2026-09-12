"""Coverage for `GitHubProxyClient` + `ProxyGitTransport` against an
ASGI-wrapped proxy app and a hand-rolled `httpx.MockTransport`."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from robomp.config import Settings
from robomp.git_ops import HeadDriftError
from robomp.github_client import (
    CommentInfo,
    GitHubClient,
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
from robomp.proxy.server import create_proxy_app
from robomp.proxy_client import GitHubProxyClient, ProxyGitTransport
from robomp.proxy_hmac import HEADER_SIGNATURE, HEADER_TIMESTAMP, sign, verify
from robomp.sandbox import workspace_key

_HMAC = "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
_HMAC_BYTES = _HMAC.encode("utf-8")
_TOKEN = "ghp_test_token_value"


# ---------- shared helpers ----------


def _build_settings(tmp_path: Path) -> Settings:
    cfg = Settings.model_construct(
        github_token=SecretStr(_TOKEN),
        github_webhook_secret=SecretStr("webhook-secret"),
        bot_login="robomp-bot",
        git_author_email="robomp-bot@example.invalid",
        repo_allowlist_raw="octo/widget",
        gh_proxy_url=None,
        gh_proxy_hmac_key=SecretStr(_HMAC),
        gh_proxy_bind_host="0.0.0.0",
        gh_proxy_bind_port=8081,
        workspace_root=tmp_path / "workspaces",
        sqlite_path=tmp_path / "robomp.sqlite",
        log_dir=tmp_path / "logs",
    )
    cfg.ensure_paths()
    return cfg


@pytest.fixture
def proxy_settings(tmp_path: Path) -> Settings:
    return _build_settings(tmp_path)


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
        env=os.environ
        | {
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
        },
    )


@pytest.fixture
def upstream_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "upstream.git"
    repo.mkdir()
    _git(["init", "--initial-branch=main", "--bare", str(repo)], tmp_path)
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(["init", "--initial-branch=main", str(seed)], tmp_path)
    (seed / "README.md").write_text("hello\n", encoding="utf-8")
    _git(["-C", str(seed), "add", "."], tmp_path)
    _git(["-C", str(seed), "commit", "-m", "init"], tmp_path)
    _git(["-C", str(seed), "remote", "add", "origin", str(repo)], tmp_path)
    _git(["-C", str(seed), "push", "origin", "main"], tmp_path)
    return repo


def _stage_workspace(cfg: Settings, upstream: Path, repo: str, number: int, branch: str) -> tuple[Path, str]:
    ws_dir = Path(cfg.workspace_root) / workspace_key(repo, number)
    ws_dir.mkdir(parents=True, exist_ok=True)
    repo_dir = ws_dir / "repo"
    _git(["clone", str(upstream), str(repo_dir)], ws_dir)
    _git(["-C", str(repo_dir), "config", "user.email", "t@t"], ws_dir)
    _git(["-C", str(repo_dir), "config", "user.name", "t"], ws_dir)
    _git(["-C", str(repo_dir), "checkout", "-b", branch], ws_dir)
    (repo_dir / "x.txt").write_text("x", encoding="utf-8")
    _git(["-C", str(repo_dir), "add", "."], ws_dir)
    _git(["-C", str(repo_dir), "commit", "-m", "x"], ws_dir)
    proc = _git(["-C", str(repo_dir), "rev-parse", "HEAD"], ws_dir)
    return repo_dir, proc.stdout.strip()


def _bare_has_branch(bare: Path, branch: str) -> bool:
    proc = subprocess.run(
        ["git", "-C", str(bare), "branch", "--list", branch],
        capture_output=True,
        text=True,
        check=False,
    )
    return bool(proc.stdout.strip())


def _attach_gh(app, handler: Callable[[httpx.Request], httpx.Response]) -> None:
    app.state.github = GitHubClient(_TOKEN, transport=httpx.MockTransport(handler))


# Sync httpx.Client cannot accept httpx.ASGITransport (which is async-only).
# Bridge by running the async transport inside a one-shot event loop per call.
class _SyncASGIBridge(httpx.BaseTransport):
    def __init__(self, app) -> None:
        self._async = httpx.ASGITransport(app=app)

    def handle_request(self, request: httpx.Request) -> httpx.Response:  # type: ignore[override]
        async def _drain() -> tuple[int, httpx.Headers, bytes]:
            async_resp = await self._async.handle_async_request(request)
            body = await async_resp.aread()
            await async_resp.aclose()
            return async_resp.status_code, async_resp.headers, body

        status, headers, body = asyncio.run(_drain())
        # Wrap the bytes in a fresh sync Response so httpx.Client's
        # `isinstance(response.stream, SyncByteStream)` assertion holds.
        return httpx.Response(
            status_code=status,
            headers=headers,
            content=body,
            request=request,
        )


# ============================================================================
# 1. HMAC headers + signature verify
# ============================================================================


async def test_signed_headers_present_and_verify() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        # Echo a minimal valid payload for whichever endpoint was hit.
        return httpx.Response(
            200,
            json={
                "full_name": "octo/widget",
                "default_branch": "main",
                "clone_url": "https://example/octo/widget.git",
                "private": False,
            },
        )

    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
    )
    info = await client.get_repo("octo/widget")
    assert isinstance(info, RepoInfo)
    assert len(captured) == 1
    req = captured[0]
    ts = req.headers.get(HEADER_TIMESTAMP)
    sig = req.headers.get(HEADER_SIGNATURE)
    assert ts is not None and sig is not None
    raw_query = req.url.query.decode("ascii")
    target = f"{req.url.path}?{raw_query}" if raw_query else req.url.path
    result = verify(
        method=req.method,
        path=target,
        body=req.content or b"",
        timestamp=ts,
        signature=sig,
        key=_HMAC_BYTES,
    )
    assert result.ok, result.reason


async def test_forgejo_platform_param_included_in_signing_target() -> None:
    """On the forgejo path the `platform` query param is merged into the request
    AND covered by the HMAC signature target, so gh-proxy can route + verify."""
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "full_name": "octo/widget",
                "default_branch": "main",
                "clone_url": "https://example/octo/widget.git",
                "private": False,
            },
        )

    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
        platform="forgejo",
    )
    info = await client.get_repo("octo/widget")

    assert isinstance(info, RepoInfo)
    req = captured[0]
    assert req.url.params.get("platform") == "forgejo"
    raw_query = req.url.query.decode("ascii")
    target = f"{req.url.path}?{raw_query}" if raw_query else req.url.path
    assert "platform=forgejo" in target
    result = verify(
        method=req.method,
        path=target,
        body=req.content or b"",
        timestamp=req.headers[HEADER_TIMESTAMP],
        signature=req.headers[HEADER_SIGNATURE],
        key=_HMAC_BYTES,
    )
    assert result.ok, result.reason


async def test_github_platform_omits_platform_param() -> None:
    """The default github platform must NOT pollute the query with a platform param."""
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "full_name": "octo/widget",
                "default_branch": "main",
                "clone_url": "https://example/octo/widget.git",
                "private": False,
            },
        )

    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
        platform="github",
    )
    await client.get_repo("octo/widget")

    req = captured[0]
    assert "platform" not in req.url.params
    assert "platform=" not in req.url.query.decode("ascii")


def test_proxy_git_transport_forgejo_platform_in_signing_target() -> None:
    """ProxyGitTransport folds `platform=forgejo` into the query the HMAC covers."""
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={})

    transport = ProxyGitTransport(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
        platform="forgejo",
    )
    transport.clone_pool(
        repo="octo/widget",
        clone_url="https://example/widget.git",
        default_branch="main",
        target=Path("/tmp/unused"),
    )

    assert len(captured) == 1
    req = captured[0]
    raw_query = req.url.query.decode("ascii")
    assert "platform=forgejo" in raw_query
    target = f"{req.url.path}?{raw_query}"
    result = verify(
        method="POST",
        path=target,
        body=req.content or b"",
        timestamp=req.headers[HEADER_TIMESTAMP],
        signature=req.headers[HEADER_SIGNATURE],
        key=_HMAC_BYTES,
    )
    assert result.ok, result.reason


# ============================================================================
# 2. Round-trip via ASGI against a real proxy app
# ============================================================================


@pytest.fixture
def round_trip_app(proxy_settings: Settings):
    """A proxy app whose GitHub-side `app.state.github` answers every GH
    endpoint the GitHubProxyClient exercises in the round-trip test."""
    app = create_proxy_app(proxy_settings)
    app.state.settings = proxy_settings

    def gh(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/repos/octo/widget":
            return httpx.Response(
                200,
                json={
                    "full_name": "octo/widget",
                    "default_branch": "main",
                    "clone_url": "https://example/octo/widget.git",
                    "private": False,
                },
            )
        if path == "/repos/octo/widget/issues/1" and req.method == "GET":
            return httpx.Response(
                200,
                json={
                    "number": 1,
                    "title": "T",
                    "body": "B",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [{"name": "bug"}],
                },
            )
        if path == "/repos/octo/widget/issues" and req.method == "GET":
            return httpx.Response(
                200,
                json=[
                    {
                        "number": 1,
                        "title": "first",
                        "state": "open",
                        "user": {"login": "alice"},
                        "labels": [],
                        "comments": 0,
                        "updated_at": "2026-01-01T00:00:00Z",
                        "created_at": "2026-01-01T00:00:00Z",
                        "html_url": "https://example/1",
                    }
                ],
            )
        if path == "/search/issues" and req.method == "GET":
            assert req.url.params["q"].startswith("repo:octo/widget ")
            return httpx.Response(
                200,
                json={
                    "total_count": 1,
                    "items": [
                        {
                            "number": 9,
                            "title": "fixed it",
                            "state": "closed",
                            "state_reason": "completed",
                            "user": {"login": "bob"},
                            "labels": [{"name": "bug"}],
                            "comments": 2,
                            "updated_at": "2026-02-01T00:00:00Z",
                            "created_at": "2026-01-15T00:00:00Z",
                            "html_url": "https://example/9",
                            "pull_request": {"url": "https://example/pull/9"},
                        }
                    ],
                },
            )
        if path == "/repos/octo/widget/issues/1/comments" and req.method == "GET":
            return httpx.Response(
                200,
                json=[
                    {"id": 7, "user": {"login": "u"}, "body": "hi", "created_at": "2026-01-01T00:00:00Z"},
                ],
            )
        if path == "/repos/octo/widget/issues/1/comments" and req.method == "POST":
            return httpx.Response(
                201,
                json={"id": 11, "user": {"login": "bot"}, "body": "posted", "created_at": "2026-01-01T00:00:00Z"},
            )
        if path == "/repos/octo/widget/pulls/2/comments":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 9,
                        "user": {"login": "rev"},
                        "body": "nit",
                        "path": "a.py",
                        "line": 5,
                        "created_at": "2026-01-01T00:00:00Z",
                    }
                ],
            )
        if path == "/repos/octo/widget/pulls/2/reviews" and req.method == "GET":
            return httpx.Response(
                200,
                json=[
                    {
                        "id": 12,
                        "user": {"login": "rev"},
                        "body": "approved",
                        "state": "APPROVED",
                        "submitted_at": "2026-01-01T00:00:00Z",
                    }
                ],
            )
        if path == "/repos/octo/widget/pulls/2/files":
            return httpx.Response(
                200,
                json=[
                    {
                        "filename": "src/app.py",
                        "status": "modified",
                        "additions": 2,
                        "deletions": 1,
                        "patch": "@@ -8,5 +8,6 @@\n ctx\n-old\n+new\n",
                    }
                ],
            )
        if path == "/repos/octo/widget/pulls/2/reviews" and req.method == "POST":
            body = json.loads(req.content)
            assert body["event"] == "COMMENT"
            assert body["comments"] == [{"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"}]
            return httpx.Response(
                200,
                json={
                    "id": 55,
                    "user": {"login": "robomp-bot"},
                    "body": body["body"],
                    "state": "COMMENTED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                },
            )
        if path == "/user":
            return httpx.Response(200, json={"login": "robomp-bot"})
        if path == "/repos/octo/widget/pulls/4" and req.method == "GET":
            return httpx.Response(
                200,
                json={
                    "number": 4,
                    "html_url": "https://example/4",
                    "head": {
                        "ref": "feat",
                        "sha": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
                        "repo": {"full_name": "octo/widget"},
                    },
                    "base": {"ref": "main"},
                    "state": "open",
                    "user": {"login": "robomp-bot"},
                },
            )
        if path == "/repos/octo/widget/pulls" and req.method == "POST":
            return httpx.Response(
                201,
                json={
                    "number": 4,
                    "html_url": "https://example/4",
                    "head": {"ref": "feat"},
                    "base": {"ref": "main"},
                    "state": "open",
                },
            )
        if path == "/repos/octo/widget/pulls/4/requested_reviewers":
            return httpx.Response(201, json={})
        if path == "/repos/octo/widget/issues/1/labels":
            return httpx.Response(200, json=[{"name": "triage"}])
        if path == "/repos/octo/widget/issues/1/labels/needs-info" and req.method == "DELETE":
            return httpx.Response(200, json={})
        if path == "/repos/octo/widget/issues/1/assignees":
            return httpx.Response(201, json={})
        return httpx.Response(404, json={"message": f"unrouted {req.method} {path}"})

    _attach_gh(app, gh)
    return app


async def test_round_trip_all_endpoints(round_trip_app) -> None:
    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.ASGITransport(app=round_trip_app),
    )
    repo = await client.get_repo("octo/widget")
    assert isinstance(repo, RepoInfo)
    assert repo.full_name == "octo/widget"

    issue = await client.get_issue("octo/widget", 1)
    assert isinstance(issue, IssueInfo)
    assert issue.labels == ("bug",)

    issues = await client.list_issues("octo/widget")
    assert len(issues) == 1 and isinstance(issues[0], IssueSummary)

    found = await client.search_issues("octo/widget", "colon selector is:pr")
    assert len(found) == 1 and isinstance(found[0], IssueSummary)
    assert found[0].is_pull_request and found[0].state_reason == "completed"

    comments = await client.list_comments("octo/widget", 1)
    assert len(comments) == 1 and isinstance(comments[0], CommentInfo)

    rcs = await client.list_review_comments("octo/widget", 2)
    assert len(rcs) == 1 and isinstance(rcs[0], ReviewCommentInfo)
    assert rcs[0].line == 5

    prs = await client.list_pr_reviews("octo/widget", 2)
    assert len(prs) == 1 and isinstance(prs[0], PullRequestReviewInfo)

    files = await client.list_pr_files("octo/widget", 2)
    assert len(files) == 1 and isinstance(files[0], PullRequestFileInfo)
    assert files[0].path == "src/app.py"
    assert files[0].patch == "@@ -8,5 +8,6 @@\n ctx\n-old\n+new\n"

    submitted = await client.submit_pr_review(
        repo="octo/widget",
        pr_number=2,
        body="summary",
        event="COMMENT",
        comments=[{"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"}],
    )
    assert submitted.id == 55

    assert await client.get_authenticated_login() == "robomp-bot"

    existing_pr = await client.get_pull_request("octo/widget", 4)
    assert isinstance(existing_pr, PullRequestInfo)
    assert existing_pr.head_ref == "feat"
    assert existing_pr.head_sha == "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    assert existing_pr.author == "robomp-bot"

    posted = await client.post_comment("octo/widget", 1, "hi")
    assert isinstance(posted, CommentInfo)
    assert posted.id == 11

    pr = await client.open_pull_request(repo="octo/widget", head="feat", base="main", title="t", body="b")
    assert isinstance(pr, PullRequestInfo)
    assert pr.number == 4

    # request_reviewers returns None on success.
    assert await client.request_reviewers(repo="octo/widget", pr_number=4, reviewers=["alice"]) is None

    labels = await client.add_issue_labels("octo/widget", 1, ["triage"])
    assert await client.remove_issue_label("octo/widget", 1, "needs-info") is None
    assert labels == ("triage",)

    assert await client.add_assignees("octo/widget", 1, ["alice"]) is None


async def test_list_comment_reactions_round_trip(proxy_settings: Settings) -> None:
    app = create_proxy_app(proxy_settings)
    app.state.settings = proxy_settings

    def gh(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/repos/octo/widget/issues/comments/999/reactions":
            assert req.url.params.get("content") == "-1"
            return httpx.Response(
                200,
                json=[
                    {"content": "-1", "user": {"login": "alice", "type": "User"}},
                ],
            )
        return httpx.Response(404, json={"message": "unrouted"})

    _attach_gh(app, gh)
    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.ASGITransport(app=app),
    )
    reactions = await client.list_comment_reactions("octo/widget", 999)
    assert reactions == (ReactionInfo(content="-1", user_login="alice", user_type="User"),)


async def test_close_issue_round_trip(proxy_settings: Settings) -> None:
    captured: dict[str, object] = {}
    app = create_proxy_app(proxy_settings)
    app.state.settings = proxy_settings

    def gh(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/repos/octo/widget/issues/7" and req.method == "PATCH":
            captured["body"] = json.loads(req.content)
            return httpx.Response(200, json={})
        return httpx.Response(404, json={"message": "unrouted"})

    _attach_gh(app, gh)
    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.ASGITransport(app=app),
    )
    assert await client.close_issue("octo/widget", 7) is None
    assert captured["body"] == {"state": "closed", "state_reason": "completed"}


def _capturing_app(app, path: str) -> tuple[Callable, list[dict[str, object]]]:
    """ASGI wrapper recording raw JSON bodies POSTed to `path`."""
    bodies: list[dict[str, object]] = []

    async def middleware(scope, receive, send):
        if scope["type"] == "http" and scope.get("path") == path:
            raw = b""
            while True:
                message = await receive()
                raw += message.get("body", b"")
                if not message.get("more_body", False):
                    break
            bodies.append(json.loads(raw))

            async def replay() -> dict[str, object]:
                return {"type": "http.request", "body": raw, "more_body": False}

            return await app(scope, replay, send)
        return await app(scope, receive, send)

    return middleware, bodies


async def test_submit_pr_review_commit_id_reaches_wire(proxy_settings: Settings) -> None:
    """commit_id must appear in the /gh/v1/submit_pr_review wire body the
    proxy client POSTs, and the server must forward it to the direct client."""
    app = create_proxy_app(proxy_settings)
    app.state.settings = proxy_settings
    upstream: dict[str, object] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/repos/octo/widget/pulls/2/reviews" and req.method == "POST":
            upstream["body"] = json.loads(req.content)
            return httpx.Response(
                200,
                json={
                    "id": 55,
                    "user": {"login": "robomp-bot"},
                    "body": "summary",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    _attach_gh(app, gh)
    middleware, wire_bodies = _capturing_app(app, "/gh/v1/submit_pr_review")
    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.ASGITransport(app=middleware),
    )
    review = await client.submit_pr_review(
        repo="octo/widget",
        pr_number=2,
        body="summary",
        event="COMMENT",
        comments=[{"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"}],
        commit_id="abc123",
    )
    assert review.id == 55
    assert wire_bodies == [
        {
            "repo": "octo/widget",
            "pr_number": 2,
            "body": "summary",
            "event": "COMMENT",
            "comments": [{"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "finding"}],
            "commit_id": "abc123",
        }
    ]
    # Server forwarded it to the direct client, which put it on the GitHub wire.
    assert upstream["body"]["commit_id"] == "abc123"

    # Without commit_id the key is omitted from the proxy wire body.
    await client.submit_pr_review(
        repo="octo/widget",
        pr_number=2,
        body="summary",
        event="COMMENT",
        comments=[],
    )
    assert "commit_id" not in wire_bodies[1]


@pytest.mark.parametrize("bad_commit_id", [12345, ""])
async def test_submit_pr_review_rejects_non_string_commit_id(proxy_settings: Settings, bad_commit_id: object) -> None:
    """The proxy server must not forward a non-string or empty commit_id
    upstream: a raw POST bypasses the proxy client, so assert on the
    upstream-captured reviews body — the key must be absent and the request
    still succeeds."""
    app = create_proxy_app(proxy_settings)
    app.state.settings = proxy_settings
    upstream: dict[str, object] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/repos/octo/widget/pulls/3/reviews" and req.method == "POST":
            upstream["body"] = json.loads(req.content)
            return httpx.Response(
                200,
                json={
                    "id": 56,
                    "user": {"login": "robomp-bot"},
                    "body": "summary",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    app.state.github = GitHubClient(_TOKEN, transport=httpx.MockTransport(gh))
    payload = {
        "repo": "octo/widget",
        "pr_number": 3,
        "body": "summary",
        "event": "COMMENT",
        "comments": [],
        "commit_id": bad_commit_id,
    }
    body = json.dumps(payload).encode()
    timestamp, sig = sign(method="POST", path="/gh/v1/submit_pr_review", body=body, key=_HMAC_BYTES)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://proxy.test",
    ) as client:
        resp = await client.post(
            "/gh/v1/submit_pr_review",
            content=body,
            headers={
                HEADER_TIMESTAMP: timestamp,
                HEADER_SIGNATURE: sig,
                "Content-Type": "application/json",
            },
        )
    assert resp.status_code == 200, resp.text
    assert "commit_id" not in upstream["body"]


# ============================================================================
# 3. Error decode
# ============================================================================


async def test_error_decode_github_422() -> None:
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            422,
            json={"error": {"kind": "github", "status": 422, "message": "x"}},
        )

    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(GitHubError) as exc:
        await client.post_comment("octo/widget", 1, "hi")
    assert exc.value.status == 422
    assert exc.value.message == "x"


# ============================================================================
# 4 + 5. ProxyGitTransport push (happy + HEAD drift)
# ============================================================================


def test_proxy_git_transport_push_happy(proxy_settings: Settings, upstream_repo: Path) -> None:
    branch = "farm/abc/feat"
    _, head = _stage_workspace(proxy_settings, upstream_repo, "octo/widget", 1, branch)
    app = create_proxy_app(proxy_settings)
    app.state.settings = proxy_settings
    _attach_gh(app, lambda _: httpx.Response(500, json={"message": "should not be hit"}))

    transport = ProxyGitTransport(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=_SyncASGIBridge(app),
    )
    result = transport.push_branch(
        repo="octo/widget",
        workspace_key=workspace_key("octo/widget", 1),
        repo_dir=Path(proxy_settings.workspace_root) / workspace_key("octo/widget", 1) / "repo",
        branch=branch,
        expected_head=head,
    )
    assert result.head == head
    assert result.branch == branch
    assert _bare_has_branch(upstream_repo, branch)


def test_proxy_git_transport_push_head_drift(proxy_settings: Settings, upstream_repo: Path) -> None:
    branch = "farm/abc/drift"
    _, _ = _stage_workspace(proxy_settings, upstream_repo, "octo/widget", 1, branch)
    app = create_proxy_app(proxy_settings)
    app.state.settings = proxy_settings
    _attach_gh(app, lambda _: httpx.Response(500, json={"message": "should not be hit"}))

    transport = ProxyGitTransport(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=_SyncASGIBridge(app),
    )
    with pytest.raises(HeadDriftError):
        transport.push_branch(
            repo="octo/widget",
            workspace_key=workspace_key("octo/widget", 1),
            repo_dir=Path(proxy_settings.workspace_root) / workspace_key("octo/widget", 1) / "repo",
            branch=branch,
            expected_head="0" * 40,
        )
    assert not _bare_has_branch(upstream_repo, branch)


def test_proxy_git_transport_push_slot_uid_body() -> None:
    captured: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(200, json={"head": "abc123", "branch": "farm/abc/feat"})

    transport = ProxyGitTransport(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
    )
    transport.push_branch(
        repo="octo/widget",
        workspace_key="octo__widget__1",
        repo_dir=Path("/unused"),
        branch="farm/abc/feat",
        expected_head="abc123",
        slot_uid=2001,
    )
    transport.push_branch(
        repo="octo/widget",
        workspace_key="octo__widget__1",
        repo_dir=Path("/unused"),
        branch="farm/abc/feat",
        expected_head="abc123",
    )

    assert captured[0]["slot_uid"] == 2001
    assert "slot_uid" not in captured[1]


def test_proxy_git_transport_push_release_body() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"head": "abc123", "branch": "main", "tag": "v1.2.3"})

    transport = ProxyGitTransport(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
    )
    result = transport.push_release(
        repo="octo/widget",
        workspace_key="octo__widget__release",
        repo_dir=Path("/unused"),
        branch="main",
        tag="v1.2.3",
        expected_head="abc123",
        slot_uid=2001,
    )

    assert result.head == "abc123"
    assert captured[0].url.path == "/gh/v1/git/push_release"
    assert json.loads(captured[0].content) == {
        "repo": "octo/widget",
        "workspace_key": "octo__widget__release",
        "branch": "main",
        "tag": "v1.2.3",
        "expected_head": "abc123",
        "slot_uid": 2001,
    }


# Sanity: signed POST headers from ProxyGitTransport._post verify cleanly.
def test_proxy_git_transport_post_headers_verify() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"pool_dir": "/tmp/x"})

    transport = ProxyGitTransport(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
    )
    transport.clone_pool(
        repo="octo/widget",
        clone_url="https://example/widget.git",
        default_branch="main",
        target=Path("/tmp/unused"),
    )
    assert len(captured) == 1
    req = captured[0]
    ts = req.headers.get(HEADER_TIMESTAMP)
    sig = req.headers.get(HEADER_SIGNATURE)
    assert ts and sig
    result = verify(
        method="POST",
        path="/gh/v1/git/clone",
        body=req.content or b"",
        timestamp=ts,
        signature=sig,
        key=_HMAC_BYTES,
    )
    assert result.ok, result.reason
    assert json.loads(req.content)["repo"] == "octo/widget"


async def test_release_read_payloads_deserialize() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/gh/v1/workflow_runs":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": 1,
                            "name": "CI",
                            "event": "push",
                            "status": "completed",
                            "conclusion": "failure",
                            "head_branch": "main",
                            "head_sha": "abc",
                            "html_url": "https://example/run",
                            "run_attempt": 1,
                        }
                    ]
                },
            )
        if path == "/gh/v1/workflow_jobs":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": 2,
                            "run_id": 1,
                            "name": "test",
                            "status": "completed",
                            "conclusion": "failure",
                            "html_url": "https://example/job",
                            "failed_steps": ["tests"],
                        }
                    ]
                },
            )
        if path == "/gh/v1/job_log_tail":
            return httpx.Response(200, json={"text": "failure"})
        if path == "/gh/v1/tag_ref":
            return httpx.Response(200, json={"sha": "abc"})
        assert path == "/gh/v1/release_by_tag"
        return httpx.Response(
            200,
            json={
                "tag": "v1.2.3",
                "name": "1.2.3",
                "draft": False,
                "prerelease": False,
                "html_url": "https://example/release",
                "asset_names": ["omp.tar.gz"],
            },
        )

    client = GitHubProxyClient(
        base_url="http://proxy.test",
        hmac_key=_HMAC,
        transport=httpx.MockTransport(handler),
    )
    runs = await client.list_workflow_runs("octo/widget", head_sha="abc")
    jobs = await client.list_workflow_jobs("octo/widget", 1)
    log_tail = await client.get_job_log_tail("octo/widget", 2, tail_lines=120)
    tag_sha = await client.get_tag_sha("octo/widget", "v1.2.3")
    release = await client.get_release_by_tag("octo/widget", "v1.2.3")
    assert runs[0].head_sha == "abc"
    assert jobs[0].failed_steps == ("tests",)
    assert log_tail == "failure"
    assert tag_sha == "abc"
    assert release is not None and release.asset_names == ("omp.tar.gz",)
