"""HMAC + endpoint coverage for the gh-proxy FastAPI app."""

from __future__ import annotations

import json
import os
import platform
import subprocess
import time
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from robomp.config import Settings
from robomp.github_client import GitHubClient
from robomp.proxy.server import create_proxy_app
from robomp.proxy_hmac import HEADER_SIGNATURE, HEADER_TIMESTAMP, sign
from robomp.sandbox import workspace_key

_HMAC = "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
_TOKEN = "ghp_test_token_value"


# ---------- shared fixtures ----------


def _build_settings(tmp_path: Path) -> Settings:
    """Construct a Settings object for the proxy side without going through
    the orchestrator-mode mutual-exclusion validator (the proxy reads token +
    hmac key directly; the validator is geared at orchestrator deployments)."""
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
    """Bare local repo with one commit on `main`."""
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
    """Pre-stage a workspace clone with one new commit on `branch`."""
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


def _stage_pool(cfg: Settings, upstream: Path, repo: str = "octo/widget") -> Path:
    """Pre-stage the shared pool clone that the fetch endpoints operate on."""
    pool_dir = Path(cfg.workspace_root) / "_pool" / repo.replace("/", "__")
    pool_dir.parent.mkdir(parents=True, exist_ok=True)
    _git(["clone", "--filter=blob:none", str(upstream), str(pool_dir)], Path(cfg.workspace_root))
    return pool_dir


def _bare_has_branch(bare: Path, branch: str) -> bool:
    proc = subprocess.run(
        ["git", "-C", str(bare), "branch", "--list", branch],
        capture_output=True,
        text=True,
        check=False,
    )
    return bool(proc.stdout.strip())


# ---------- HMAC + signed request helpers ----------


def _signed(
    method: str,
    path: str,
    body: bytes = b"",
    *,
    params: dict[str, object] | None = None,
    ts: str | None = None,
    key: bytes | None = None,
) -> dict[str, str]:
    """Build signed headers.

    When `params` is supplied, the canonical signing target becomes
    `path?<query>` (matching the verifier's request-target reconstruction),
    so signed requests with query strings stay verifiable AND mutating any
    query parameter post-sign produces a 401.
    """
    if params:
        url = httpx.URL(path, params=params)
        query = url.query.decode("ascii") if url.query else ""
        target = f"{path}?{query}" if query else path
    else:
        target = path
    timestamp, sig = sign(method=method, path=target, body=body, key=key or _HMAC.encode(), timestamp=ts)
    return {HEADER_TIMESTAMP: timestamp, HEADER_SIGNATURE: sig}


def _build_app(cfg: Settings, gh_handler: Callable[[httpx.Request], httpx.Response] | None = None):
    app = create_proxy_app(cfg)
    transport = httpx.MockTransport(gh_handler) if gh_handler is not None else None
    app.state.github = GitHubClient(_TOKEN, transport=transport)
    app.state.settings = cfg
    return app


async def _async_client(app) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://proxy.test",
    )


def test_read_remote_urls_uses_safe_directory_and_slot_identity(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from robomp.proxy import server as proxy_server

    captured: dict[str, object] = {}
    repo_dir = tmp_path / "repo"
    monkeypatch.setenv("GITHUB_TOKEN", "parent-token")
    monkeypatch.setenv("ROBOMP_GIT_HTTP_AUTH", "parent-auth")

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["cmd"] = cmd
        captured.update(kwargs)
        return subprocess.CompletedProcess(cmd, 0, "https://github.com/octo/widget.git\n", "")

    monkeypatch.setattr("robomp.proxy.server.subprocess.run", fake_run)
    monkeypatch.setattr(
        "robomp.proxy.server._slot_subprocess_kwargs",
        lambda uid: {"user": uid, "group": uid, "extra_groups": [2000], "umask": 0o002},
    )

    result = proxy_server._read_remote_urls(repo_dir, slot_uid=2001)
    assert "https://github.com/octo/widget.git" in result

    env = captured["env"]
    assert isinstance(env, dict)
    assert env["GIT_CONFIG_COUNT"] == "1"
    assert env["GIT_CONFIG_KEY_0"] == "safe.directory"
    assert env["GIT_CONFIG_VALUE_0"] == str(repo_dir)
    assert "GITHUB_TOKEN" not in env
    assert "ROBOMP_GIT_HTTP_AUTH" not in env
    assert captured["user"] == 2001
    assert captured["group"] == 2001
    assert captured["extra_groups"] == [2000]
    assert captured["umask"] == 0o002


# ============================================================================
# HMAC behavior
# ============================================================================


async def test_hmac_accept_post_comment_round_trip(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(
            201,
            json={
                "id": 42,
                "user": {"login": "robomp-bot"},
                "body": "hello",
                "created_at": "2026-01-01T00:00:00Z",
            },
        )

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","number":1,"body":"hello"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/post_comment",
            content=body,
            headers={**_signed("POST", "/gh/v1/post_comment", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"id": 42, "author": "robomp-bot", "body": "hello", "created_at": "2026-01-01T00:00:00Z"}
    assert captured["req"].url.path == "/repos/octo/widget/issues/1/comments"


async def test_hmac_reject_missing_headers(proxy_settings: Settings) -> None:
    app = _build_app(proxy_settings, lambda _: httpx.Response(200, json={}))
    async with await _async_client(app) as client:
        resp = await client.get("/gh/v1/repo", params={"repo": "octo/widget"})
    assert resp.status_code == 401


async def test_hmac_reject_bad_signature(proxy_settings: Settings) -> None:
    app = _build_app(proxy_settings, lambda _: httpx.Response(200, json={}))
    async with await _async_client(app) as client:
        resp = await client.get(
            "/gh/v1/repo",
            params={"repo": "octo/widget"},
            headers={HEADER_TIMESTAMP: str(int(time.time())), HEADER_SIGNATURE: "0" * 64},
        )
    assert resp.status_code == 401


async def test_hmac_reject_stale_timestamp(proxy_settings: Settings) -> None:
    app = _build_app(proxy_settings, lambda _: httpx.Response(200, json={}))
    stale = str(int(time.time()) - 120)
    headers = _signed("GET", "/gh/v1/repo", ts=stale)
    async with await _async_client(app) as client:
        resp = await client.get("/gh/v1/repo", params={"repo": "octo/widget"}, headers=headers)
    assert resp.status_code == 401


# ============================================================================
# GET endpoints
# ============================================================================


async def test_get_repo(proxy_settings: Settings) -> None:
    def gh(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/repos/octo/widget"
        return httpx.Response(
            200,
            json={
                "full_name": "octo/widget",
                "default_branch": "main",
                "clone_url": "https://github.com/octo/widget.git",
                "private": False,
            },
        )

    app = _build_app(proxy_settings, gh)
    async with await _async_client(app) as client:
        resp = await client.get(
            "/gh/v1/repo",
            params={"repo": "octo/widget"},
            headers=_signed("GET", "/gh/v1/repo", params={"repo": "octo/widget"}),
        )
    assert resp.status_code == 200
    assert resp.json() == {
        "full_name": "octo/widget",
        "default_branch": "main",
        "clone_url": "https://github.com/octo/widget.git",
        "private": False,
    }


async def test_get_issue(proxy_settings: Settings) -> None:
    def gh(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/repos/octo/widget/issues/1"
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

    app = _build_app(proxy_settings, gh)
    async with await _async_client(app) as client:
        resp = await client.get(
            "/gh/v1/issue",
            params={"repo": "octo/widget", "number": 1},
            headers=_signed("GET", "/gh/v1/issue", params={"repo": "octo/widget", "number": 1}),
        )
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["repo"] == "octo/widget"
    assert payload["number"] == 1
    assert payload["labels"] == ["bug"]
    assert payload["is_pull_request"] is False


async def test_list_issues(proxy_settings: Settings) -> None:
    def gh(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/repos/octo/widget/issues"
        return httpx.Response(
            200,
            json=[
                {
                    "number": 1,
                    "title": "first",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [{"name": "bug"}],
                    "comments": 0,
                    "updated_at": "2026-01-01T00:00:00Z",
                    "created_at": "2026-01-01T00:00:00Z",
                    "html_url": "https://example/1",
                },
                # A PR — must be filtered out.
                {
                    "number": 2,
                    "title": "pr",
                    "pull_request": {"url": "x"},
                    "user": {"login": "alice"},
                },
            ],
        )

    app = _build_app(proxy_settings, gh)
    async with await _async_client(app) as client:
        resp = await client.get(
            "/gh/v1/issues",
            params={"repo": "octo/widget"},
            headers=_signed("GET", "/gh/v1/issues", params={"repo": "octo/widget"}),
        )
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 1
    assert items[0]["number"] == 1


async def test_list_comments(proxy_settings: Settings) -> None:
    def gh(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/repos/octo/widget/issues/1/comments"
        return httpx.Response(
            200,
            json=[
                {"id": 1, "user": {"login": "u"}, "body": "hi", "created_at": "2026-01-01T00:00:00Z"},
            ],
        )

    app = _build_app(proxy_settings, gh)
    async with await _async_client(app) as client:
        resp = await client.get(
            "/gh/v1/comments",
            params={"repo": "octo/widget", "number": 1},
            headers=_signed("GET", "/gh/v1/comments", params={"repo": "octo/widget", "number": 1}),
        )
    assert resp.status_code == 200
    assert resp.json() == {
        "items": [{"id": 1, "author": "u", "body": "hi", "created_at": "2026-01-01T00:00:00Z"}],
    }


async def test_list_review_comments(proxy_settings: Settings) -> None:
    def gh(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/repos/octo/widget/pulls/1/comments"
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

    app = _build_app(proxy_settings, gh)
    async with await _async_client(app) as client:
        resp = await client.get(
            "/gh/v1/review_comments",
            params={"repo": "octo/widget", "pr_number": 1},
            headers=_signed("GET", "/gh/v1/review_comments", params={"repo": "octo/widget", "pr_number": 1}),
        )
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert items[0]["path"] == "a.py"
    assert items[0]["line"] == 5


async def test_list_pr_reviews(proxy_settings: Settings) -> None:
    def gh(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/repos/octo/widget/pulls/1/reviews"
        return httpx.Response(
            200,
            json=[
                {
                    "id": 11,
                    "user": {"login": "rev"},
                    "body": "looks good",
                    "state": "APPROVED",
                    "submitted_at": "2026-01-01T00:00:00Z",
                },
                # Empty body — must be filtered out by GitHubClient.
                {"id": 12, "user": {"login": "rev"}, "body": "  ", "state": "COMMENTED"},
            ],
        )

    app = _build_app(proxy_settings, gh)
    async with await _async_client(app) as client:
        resp = await client.get(
            "/gh/v1/pr_reviews",
            params={"repo": "octo/widget", "pr_number": 1},
            headers=_signed("GET", "/gh/v1/pr_reviews", params={"repo": "octo/widget", "pr_number": 1}),
        )
    assert resp.status_code == 200
    items = resp.json()["items"]
    assert len(items) == 1
    assert items[0]["state"] == "APPROVED"


async def test_authenticated_login(proxy_settings: Settings) -> None:
    def gh(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/user"
        return httpx.Response(200, json={"login": "robomp-bot"})

    app = _build_app(proxy_settings, gh)
    async with await _async_client(app) as client:
        resp = await client.get(
            "/gh/v1/authenticated_login",
            headers=_signed("GET", "/gh/v1/authenticated_login"),
        )
    assert resp.status_code == 200
    assert resp.json() == {"login": "robomp-bot"}


# ============================================================================
# POST endpoints
# ============================================================================


async def test_post_comment_forwards_body(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(
            201,
            json={"id": 7, "user": {"login": "b"}, "body": "hi", "created_at": "2026-01-01T00:00:00Z"},
        )

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","number":1,"body":"hi"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/post_comment",
            content=body,
            headers={**_signed("POST", "/gh/v1/post_comment", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    req = captured["req"]
    assert req.method == "POST"
    assert req.url.path == "/repos/octo/widget/issues/1/comments"
    import json

    assert json.loads(req.content) == {"body": "hi"}


async def test_add_issue_labels(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(200, json=[{"name": "triage"}, {"name": "bug"}])

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","number":1,"labels":["triage","bug"]}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/add_issue_labels",
            content=body,
            headers={**_signed("POST", "/gh/v1/add_issue_labels", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"labels": ["triage", "bug"]}
    assert captured["req"].url.path == "/repos/octo/widget/issues/1/labels"
    import json

    assert json.loads(captured["req"].content) == {"labels": ["triage", "bug"]}


async def test_remove_issue_label(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(200, json={})

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","number":1,"label":"needs-info"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/remove_issue_label",
            content=body,
            headers={**_signed("POST", "/gh/v1/remove_issue_label", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert captured["req"].method == "DELETE"
    assert captured["req"].url.path == "/repos/octo/widget/issues/1/labels/needs-info"


async def test_add_assignees(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(201, json={})

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","number":1,"assignees":["alice"]}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/add_assignees",
            content=body,
            headers={**_signed("POST", "/gh/v1/add_assignees", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert captured["req"].url.path == "/repos/octo/widget/issues/1/assignees"
    import json

    assert json.loads(captured["req"].content) == {"assignees": ["alice"]}


async def test_comment_reactions(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(
            200,
            json=[
                {"content": "-1", "user": {"login": "alice", "type": "User"}},
            ],
        )

    app = _build_app(proxy_settings, gh)
    target = "/gh/v1/comment_reactions?repo=octo%2Fwidget&comment_id=999"
    async with await _async_client(app) as client:
        resp = await client.get(target, headers=_signed("GET", target))
    assert resp.status_code == 200
    assert resp.json() == {
        "items": [{"content": "-1", "user_login": "alice", "user_type": "User"}],
    }
    req = captured["req"]
    assert req.method == "GET"
    assert req.url.path == "/repos/octo/widget/issues/comments/999/reactions"
    assert req.url.params.get("content") == "-1"


async def test_close_issue(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(200, json={})

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","number":7,"reason":"completed"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/close_issue",
            content=body,
            headers={**_signed("POST", "/gh/v1/close_issue", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    req = captured["req"]
    assert req.method == "PATCH"
    assert req.url.path == "/repos/octo/widget/issues/7"
    import json

    assert json.loads(req.content) == {"state": "closed", "state_reason": "completed"}


async def test_close_issue_defaults_reason_to_completed(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(200, json={})

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","number":7}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/close_issue",
            content=body,
            headers={**_signed("POST", "/gh/v1/close_issue", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    import json

    assert json.loads(captured["req"].content) == {"state": "closed", "state_reason": "completed"}


async def test_open_pull_request(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(
            201,
            json={
                "number": 4,
                "html_url": "https://example/4",
                "head": {"ref": "feature"},
                "base": {"ref": "main"},
                "state": "open",
            },
        )

    app = _build_app(proxy_settings, gh)
    body = (
        b'{"repo":"octo/widget","head":"feature","base":"main",'
        b'"title":"t","body":"b","draft":false,"maintainer_can_modify":true}'
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/open_pull_request",
            content=body,
            headers={**_signed("POST", "/gh/v1/open_pull_request", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    assert resp.json()["number"] == 4
    assert captured["req"].url.path == "/repos/octo/widget/pulls"
    import json

    sent = json.loads(captured["req"].content)
    assert sent["head"] == "feature"
    assert sent["base"] == "main"
    assert sent["title"] == "t"


async def test_request_reviewers(proxy_settings: Settings) -> None:
    captured: dict[str, httpx.Request] = {}

    def gh(req: httpx.Request) -> httpx.Response:
        captured["req"] = req
        return httpx.Response(201, json={})

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","pr_number":4,"reviewers":["alice"],"team_reviewers":null}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/request_reviewers",
            content=body,
            headers={**_signed("POST", "/gh/v1/request_reviewers", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    assert captured["req"].url.path == "/repos/octo/widget/pulls/4/requested_reviewers"
    import json

    assert json.loads(captured["req"].content) == {"reviewers": ["alice"]}


# ============================================================================
# GitHub error passthrough
# ============================================================================


async def test_github_error_passthrough_422(proxy_settings: Settings) -> None:
    def gh(_: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"message": "validation failed"})

    app = _build_app(proxy_settings, gh)
    body = b'{"repo":"octo/widget","number":1,"body":"hi"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/post_comment",
            content=body,
            headers={**_signed("POST", "/gh/v1/post_comment", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 422
    err = resp.json()["error"]
    assert err["kind"] == "github"
    assert err["status"] == 422
    assert err["message"] == "validation failed"


# ============================================================================
# git transport endpoints
# ============================================================================


async def test_git_clone_creates_pool_dir(proxy_settings: Settings, upstream_repo: Path) -> None:
    app = _build_app(proxy_settings)
    body = b'{"repo":"octo/widget","clone_url":"' + str(upstream_repo).encode() + b'","default_branch":"main"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/clone",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/clone", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200
    pool_dir = Path(resp.json()["pool_dir"])
    assert pool_dir.is_dir()
    assert pool_dir == Path(proxy_settings.workspace_root) / "_pool" / "octo__widget"
    assert (pool_dir / "HEAD").exists() or (pool_dir / ".git" / "HEAD").exists()


async def test_git_clone_github_url_passes_scoped_token(
    proxy_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}

    def fake_git_clone(target: Path, **kwargs: object) -> None:
        captured["target"] = target
        captured.update(kwargs)

    monkeypatch.setattr("robomp.proxy.server.git_clone", fake_git_clone)
    app = _build_app(proxy_settings)
    body = b'{"repo":"octo/widget","clone_url":"https://github.com/octo/widget","default_branch":"main"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/clone",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/clone", body), "Content-Type": "application/json"},
        )

    assert resp.status_code == 200, resp.text
    assert captured["clone_url"] == "https://github.com/octo/widget.git"
    assert captured["token"] == _TOKEN
    assert captured["auth_url"] == "https://github.com/octo/widget.git"


async def test_git_fetch_repairs_missing_alternate_and_bad_ref(proxy_settings: Settings, upstream_repo: Path) -> None:
    pool_dir = Path(proxy_settings.workspace_root) / "_pool" / "octo__widget"
    pool_dir.parent.mkdir(parents=True, exist_ok=True)
    _git(["clone", "--filter=blob:none", str(upstream_repo), str(pool_dir)], Path(proxy_settings.workspace_root))

    bad_ref = pool_dir / ".git" / "refs" / "heads" / "farm" / "bad"
    bad_ref.parent.mkdir(parents=True, exist_ok=True)
    bad_ref.write_text("0123456789012345678901234567890123456789\n", encoding="ascii")

    alternates = pool_dir / ".git" / "objects" / "info" / "alternates"
    alternates.write_text(str(Path(proxy_settings.workspace_root) / "missing-objects") + "\n", encoding="utf-8")

    app = _build_app(proxy_settings)
    body = b'{"repo":"octo/widget"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/fetch",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/fetch", body), "Content-Type": "application/json"},
        )

    assert resp.status_code == 200, resp.text
    assert Path(resp.json()["pool_dir"]) == pool_dir
    assert not bad_ref.exists()
    assert not alternates.exists()


async def test_git_fetch_github_origin_uses_explicit_scoped_remote(
    proxy_settings: Settings, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pool_dir = _stage_pool(proxy_settings, upstream_repo)
    _git(["-C", str(pool_dir), "remote", "set-url", "origin", "https://github.com/octo/widget"], pool_dir)
    captured: dict[str, object] = {}

    def fake_fetch_prune(path: Path, **kwargs: object) -> None:
        _git(["-C", str(path), "remote", "set-url", "origin", "ext::sh -c env"], path)
        captured["path"] = path
        captured.update(kwargs)

    monkeypatch.setattr("robomp.proxy.server.git_fetch_prune", fake_fetch_prune)
    app = _build_app(proxy_settings)
    body = b'{"repo":"octo/widget"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/fetch",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/fetch", body), "Content-Type": "application/json"},
        )

    assert resp.status_code == 200, resp.text
    assert captured["path"] == pool_dir
    assert captured["remote_url"] == "https://github.com/octo/widget.git"
    assert captured["token"] == _TOKEN
    assert captured["auth_url"] == "https://github.com/octo/widget.git"


async def test_git_push_happy_path(proxy_settings: Settings, upstream_repo: Path) -> None:
    branch = "farm/abc/feature"
    _, head = _stage_workspace(proxy_settings, upstream_repo, "octo/widget", 1, branch)
    # Rewire origin to the bare upstream so the proxy's push lands there.
    app = _build_app(proxy_settings)
    body = (
        b'{"repo":"octo/widget","workspace_key":"octo__widget__1","branch":"'
        + branch.encode()
        + b'","expected_head":"'
        + head.encode()
        + b'"}'
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/push",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/push", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"head": head, "branch": branch}
    assert _bare_has_branch(upstream_repo, branch)


async def test_git_push_passes_slot_uid_to_git_push(
    proxy_settings: Settings, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from robomp.git_ops import PushResult

    branch = "farm/abc/slot"
    repo_dir, head = _stage_workspace(proxy_settings, upstream_repo, "octo/widget", 1, branch)
    # The push handler reads the origin URL as the slot uid. On Linux+root
    # the staged workspace is root-owned; hand it to slot 2001 so the
    # subprocess can stat it. On macOS dev this is a no-op (slot identity
    # is never activated).
    if platform.system() == "Linux" and os.geteuid() == 0:
        for path in [repo_dir.parent, repo_dir, *repo_dir.rglob("*")]:
            os.chown(path, 2001, 2001, follow_symlinks=False)
    captured: dict[str, object] = {}

    def fake_git_push(path: Path, **kwargs: object) -> PushResult:
        captured["path"] = path
        captured.update(kwargs)
        return PushResult(head=head, branch=branch)

    monkeypatch.setattr("robomp.proxy.server.git_push", fake_git_push)
    app = _build_app(proxy_settings)
    body = (
        b'{"repo":"octo/widget","workspace_key":"octo__widget__1","branch":"'
        + branch.encode()
        + b'","expected_head":"'
        + head.encode()
        + b'","slot_uid":2001}'
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/push",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/push", body), "Content-Type": "application/json"},
        )

    assert resp.status_code == 200, resp.text
    assert captured["path"] == repo_dir
    assert captured["slot_uid"] == 2001


@pytest.mark.parametrize("slot_uid", [0, -1, 65536])
async def test_git_push_rejects_invalid_slot_uid(proxy_settings: Settings, slot_uid: int) -> None:
    app = _build_app(proxy_settings)
    body = (
        b'{"repo":"octo/widget","workspace_key":"octo__widget__1","branch":"x","expected_head":"'
        + (b"0" * 40)
        + b'","slot_uid":'
        + str(slot_uid).encode()
        + b"}"
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/push",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/push", body), "Content-Type": "application/json"},
        )

    assert resp.status_code == 400
    assert "slot_uid" in resp.text


async def test_git_push_head_drift(proxy_settings: Settings, upstream_repo: Path) -> None:
    branch = "farm/abc/drift"
    _, _ = _stage_workspace(proxy_settings, upstream_repo, "octo/widget", 1, branch)
    app = _build_app(proxy_settings)
    fake_head = "0" * 40
    body = (
        b'{"repo":"octo/widget","workspace_key":"octo__widget__1","branch":"'
        + branch.encode()
        + b'","expected_head":"'
        + fake_head.encode()
        + b'"}'
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/push",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/push", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 409, resp.text
    assert resp.json()["error"]["kind"] == "head_drift"
    assert not _bare_has_branch(upstream_repo, branch)


async def test_git_push_workspace_key_mismatch(proxy_settings: Settings) -> None:
    app = _build_app(proxy_settings)
    body = (
        b'{"repo":"octo/widget","workspace_key":"other__repo__1","branch":"x","expected_head":"' + (b"0" * 40) + b'"}'
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/push",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/push", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 400
    assert "workspace_key" in resp.text


# ============================================================================
# Finding 2 — HMAC must bind the raw query string
# ============================================================================


async def test_hmac_rejects_query_mutation(proxy_settings: Settings) -> None:
    """Sign `/gh/v1/issue?repo=octo/widget&number=1`, replay with number=2.

    The verifier MUST notice the mutated query and 401. Without binding the
    query into the canonical string this request would sail through with an
    attacker-chosen target issue.
    """
    captured: list[httpx.Request] = []

    def gh(req: httpx.Request) -> httpx.Response:
        captured.append(req)
        return httpx.Response(
            200,
            json={
                "number": int(req.url.params["number"]),
                "title": "T",
                "body": "B",
                "state": "open",
                "user": {"login": "x"},
                "labels": [],
            },
        )

    app = _build_app(proxy_settings, gh)
    legit_params = {"repo": "octo/widget", "number": 1}
    headers = _signed("GET", "/gh/v1/issue", params=legit_params)
    mutated = {"repo": "octo/widget", "number": 2}
    async with await _async_client(app) as client:
        resp = await client.get("/gh/v1/issue", params=mutated, headers=headers)
    assert resp.status_code == 401, resp.text
    # Upstream GitHub mock MUST NOT have been called — auth failed first.
    assert captured == []


# ============================================================================
# Finding 3 — body must be size-capped BEFORE auth / before full buffer
# ============================================================================


async def test_oversized_content_length_rejected_with_413(proxy_settings: Settings) -> None:
    """Setting Content-Length above the cap is rejected at 413 cheaply.

    With the fix in place the proxy never reads the (huge) body into memory:
    we declare CL > max_bytes and the handler aborts immediately. We force
    a tiny cap so the test stays fast; the production default is 1 MiB.
    """
    proxy_settings.gh_proxy_max_body_bytes = 256  # type: ignore[misc]
    app = _build_app(proxy_settings, lambda _: httpx.Response(500, json={}))
    payload = b"x" * 1024
    headers = {
        **_signed("POST", "/gh/v1/post_comment", payload),
        "Content-Type": "application/json",
        # Lie about CL to prove the early-reject path doesn't read content.
        "Content-Length": str(1024 * 1024 * 64),
    }
    async with await _async_client(app) as client:
        resp = await client.post("/gh/v1/post_comment", content=payload, headers=headers)
    assert resp.status_code == 413, resp.text


async def test_streamed_body_above_cap_rejected_with_413(proxy_settings: Settings) -> None:
    """When Content-Length is honest but > cap, we still 413."""
    proxy_settings.gh_proxy_max_body_bytes = 64  # type: ignore[misc]
    app = _build_app(proxy_settings, lambda _: httpx.Response(500, json={}))
    payload = b'{"repo":"octo/widget","number":1,"body":"' + (b"y" * 200) + b'"}'
    headers = {
        **_signed("POST", "/gh/v1/post_comment", payload),
        "Content-Type": "application/json",
    }
    async with await _async_client(app) as client:
        resp = await client.post("/gh/v1/post_comment", content=payload, headers=headers)
    assert resp.status_code == 413


# ============================================================================
# Finding 5 — push refuses attacker-controlled origin (PAT exfil guard)
# ============================================================================


async def test_git_push_rejects_attacker_origin(proxy_settings: Settings, upstream_repo: Path) -> None:
    """If the worktree's origin is rewritten to a non-github HTTPS URL,
    the push endpoint MUST refuse with 400 BEFORE invoking `git push` (which
    would carry the PAT to the attacker's host)."""
    branch = "farm/abc/evil"
    repo_dir, head = _stage_workspace(proxy_settings, upstream_repo, "octo/widget", 1, branch)
    # Simulate the agent rewriting origin inside its sandbox worktree.
    _git(["-C", str(repo_dir), "remote", "set-url", "origin", "https://evil.example.com/octo/widget.git"], repo_dir)

    app = _build_app(proxy_settings)
    body = (
        b'{"repo":"octo/widget","workspace_key":"octo__widget__1","branch":"'
        + branch.encode()
        + b'","expected_head":"'
        + head.encode()
        + b'"}'
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/push",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/push", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 400, resp.text
    # The legit upstream never received the branch — proves push wasn't run.
    assert not _bare_has_branch(upstream_repo, branch)


async def test_git_push_rejects_origin_with_wrong_repo(proxy_settings: Settings, upstream_repo: Path) -> None:
    """github.com host is not enough — owner/repo MUST match the request."""
    branch = "farm/abc/mismatch"
    repo_dir, head = _stage_workspace(proxy_settings, upstream_repo, "octo/widget", 1, branch)
    _git(["-C", str(repo_dir), "remote", "set-url", "origin", "https://github.com/attacker/other.git"], repo_dir)

    app = _build_app(proxy_settings)
    body = (
        b'{"repo":"octo/widget","workspace_key":"octo__widget__1","branch":"'
        + branch.encode()
        + b'","expected_head":"'
        + head.encode()
        + b'"}'
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/push",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/push", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 400, resp.text
    assert not _bare_has_branch(upstream_repo, branch)


# ============================================================================
# Finding 6 — fetch + clone refuse attacker-controlled origin (PAT exfil guard)
# ============================================================================


@pytest.mark.parametrize(
    ("endpoint", "body"),
    [
        ("/gh/v1/git/fetch", b'{"repo":"octo/widget"}'),
        ("/gh/v1/git/fetch_ref", b'{"repo":"octo/widget","ref":"refs/heads/main"}'),
        ("/gh/v1/git/fetch_pr_head", b'{"repo":"octo/widget","pr_number":1}'),
    ],
)
async def test_git_fetch_endpoints_reject_attacker_origin(
    proxy_settings: Settings, upstream_repo: Path, endpoint: str, body: bytes
) -> None:
    """An agent with group write to the shared pool can rewrite its `origin`;
    every token-bearing fetch MUST refuse with 400 before git carries the PAT
    to that host."""
    pool_dir = _stage_pool(proxy_settings, upstream_repo)
    _git(["-C", str(pool_dir), "remote", "set-url", "origin", "https://evil.example.com/octo/widget.git"], pool_dir)

    app = _build_app(proxy_settings)
    async with await _async_client(app) as client:
        resp = await client.post(
            endpoint,
            content=body,
            headers={**_signed("POST", endpoint, body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 400, resp.text


async def test_git_fetch_rejects_ext_remote_helper(proxy_settings: Settings, upstream_repo: Path) -> None:
    pool_dir = _stage_pool(proxy_settings, upstream_repo)
    _git(["-C", str(pool_dir), "remote", "set-url", "origin", "ext::sh -c env"], pool_dir)

    app = _build_app(proxy_settings)
    body = b'{"repo":"octo/widget"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/fetch",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/fetch", body), "Content-Type": "application/json"},
        )

    assert resp.status_code == 400, resp.text


async def test_git_fetch_rejects_option_shaped_origin(proxy_settings: Settings, upstream_repo: Path) -> None:
    pool_dir = _stage_pool(proxy_settings, upstream_repo)
    config_path = pool_dir / ".git" / "config"
    config_text = config_path.read_text(encoding="utf-8")
    config_path.write_text(config_text.replace(f"\turl = {upstream_repo}\n", "\turl = --upload-pack=env\n"), encoding="utf-8")

    app = _build_app(proxy_settings)
    body = b'{"repo":"octo/widget"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/fetch",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/fetch", body), "Content-Type": "application/json"},
        )

    assert resp.status_code == 400, resp.text




@pytest.mark.parametrize(
    "clone_url",
    [
        "https://evil.example.com/octo/widget.git",  # wrong host
        "https://github.com/attacker/other.git",  # wrong repo
        "https://user:pass@github.com/octo/widget.git",  # embedded credentials
        "http://github.com/octo/widget.git",  # plain http would ship the PAT in cleartext
        "https://github.com/octo/widget.git%0dhost=evil.example",  # credential-protocol injection
        "ext::sh -c env",  # remote helper transports can execute code
        "--upload-pack=env",  # leading dash would be parsed as a git option
    ],
)
async def test_git_clone_rejects_unsafe_url(proxy_settings: Settings, clone_url: str) -> None:
    """`clone_url` is caller-supplied; an HTTP(S) URL that doesn't resolve to
    github.com/<repo> MUST be refused before git carries the PAT to it."""
    app = _build_app(proxy_settings)
    body = b'{"repo":"octo/widget","clone_url":"' + clone_url.encode() + b'","default_branch":"main"}'
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/clone",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/clone", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 400, resp.text
    assert not (Path(proxy_settings.workspace_root) / "_pool" / "octo__widget").exists()


async def test_git_push_rejects_attacker_pushurl(proxy_settings: Settings, upstream_repo: Path) -> None:
    """`origin` keeps a legit fetch URL but a separate `pushurl` points at an
    attacker host. `git push` would use the pushurl, so the guard MUST refuse
    before the PAT ships — a fetch-URL-only check would miss this."""
    branch = "farm/abc/pushurl"
    repo_dir, head = _stage_workspace(proxy_settings, upstream_repo, "octo/widget", 1, branch)
    _git(
        ["-C", str(repo_dir), "remote", "set-url", "--push", "origin", "https://evil.example.com/octo/widget.git"],
        repo_dir,
    )

    app = _build_app(proxy_settings)
    body = (
        b'{"repo":"octo/widget","workspace_key":"octo__widget__1","branch":"'
        + branch.encode()
        + b'","expected_head":"'
        + head.encode()
        + b'"}'
    )
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/push",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/push", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 400, resp.text
    assert not _bare_has_branch(upstream_repo, branch)

# ============================================================================
# fetch_ref refuses refspec / option injection in `ref`
# ============================================================================


@pytest.mark.parametrize(
    "bad_ref",
    [
        "refs/heads/x:refs/heads/evil",  # `:` -> refspec injection (arbitrary local ref write)
        "--upload-pack=env",  # leading dash -> argv option injection
        "+refs/heads/*:refs/remotes/origin/x",  # `+`/`*` wildcard refspec
        "refs/heads/*",  # wildcard
        "a..b",  # `..` range token
        "ref with space",  # whitespace / control
        "feature/",  # trailing slash
    ],
)
async def test_git_fetch_ref_rejects_injection_refs(proxy_settings: Settings, bad_ref: str) -> None:
    """`ref` is interpolated into the fetch refspec, so a `:`/leading-dash/
    wildcard ref MUST be refused with 400 — validation runs before any git op,
    so no pool needs to exist."""
    app = _build_app(proxy_settings)
    body = json.dumps({"repo": "octo/widget", "ref": bad_ref}).encode()
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/fetch_ref",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/fetch_ref", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 400, resp.text


async def test_git_fetch_ref_allows_slashy_branch_name(proxy_settings: Settings, upstream_repo: Path) -> None:
    """A normal PR-head-style branch (`contrib/fix-parser`) MUST pass validation.
    fetch_ref is best-effort, so a clean ref against the staged pool returns 200
    even though that branch isn't on the local upstream."""
    _stage_pool(proxy_settings, upstream_repo)
    app = _build_app(proxy_settings)
    body = json.dumps({"repo": "octo/widget", "ref": "contrib/fix-parser"}).encode()
    async with await _async_client(app) as client:
        resp = await client.post(
            "/gh/v1/git/fetch_ref",
            content=body,
            headers={**_signed("POST", "/gh/v1/git/fetch_ref", body), "Content-Type": "application/json"},
        )
    assert resp.status_code == 200, resp.text
