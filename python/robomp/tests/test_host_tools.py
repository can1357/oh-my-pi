"""Host tool tests against a mocked GitHub via httpx.MockTransport."""

from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from pathlib import Path
from typing import Any

import httpx
import pytest
from omp_rpc import HostToolContext, RpcCommandError

from robomp import host_tools
from robomp.config import Settings
from robomp.db import Database
from robomp.git_ops import PushResult
from robomp.github_client import GitHubClient, IssueIndexEntry, IssueInfo, RepoInfo
from robomp.host_tools import AbortController, ReleaseToolContext, ToolBindings, build
from robomp.sandbox import LocalGitTransport, Workspace


def _stub_workspace(tmp_path: Path) -> Workspace:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    session_dir = root / ".omp-session"
    context_dir = root / "context"
    artifacts_dir = root / "artifacts"
    for p in (root, repo_dir, session_dir, context_dir, context_dir / "repro", artifacts_dir):
        p.mkdir(parents=True, exist_ok=True)
    return Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=session_dir,
        context_dir=context_dir,
        artifacts_dir=artifacts_dir,
        branch="farm/abc12345/some-issue",
        repo_full_name="octo/widget",
        issue_number=42,
    )


def _stub_issue() -> IssueInfo:
    return IssueInfo(
        repo="octo/widget",
        number=42,
        title="boom",
        body="b",
        state="open",
        author="alice",
        labels=("bug",),
        is_pull_request=False,
    )


def _stub_repo() -> RepoInfo:
    return RepoInfo(
        full_name="octo/widget",
        default_branch="main",
        clone_url="https://x/octo/widget.git",
        private=False,
    )


# Unified diff whose anchorable lines are RIGHT {10..14} / LEFT {9..12};
# line 15+ is a gap (unanchorable) and RIGHT line 9 is before the hunk.
_PATCH = "@@ -9,5 +10,6 @@ def f():\n ctx1\n-old10\n+new11\n ctx2\n+new13\n ctx3\n"


def _pr_files_response(request: httpx.Request, patch: str = _PATCH, *, status: int = 200) -> httpx.Response:
    if status != 200:
        return httpx.Response(status, json={"message": "files fetch failed"})
    return httpx.Response(
        200,
        json=[{"filename": "src/app.py", "status": "modified", "additions": 1, "deletions": 1, "patch": patch}],
    )


def _make_loop_in_background() -> tuple[asyncio.AbstractEventLoop, threading.Thread]:
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, daemon=True)
    t.start()
    return loop, t


def _stop_loop(loop: asyncio.AbstractEventLoop, t: threading.Thread) -> None:
    loop.call_soon_threadsafe(loop.stop)
    t.join(timeout=2.0)
    loop.close()


def _bindings(
    db: Database, tmp_path: Path, transport: httpx.MockTransport, *, slot_uid: int | None = None
) -> tuple[ToolBindings, asyncio.AbstractEventLoop, threading.Thread]:
    github = GitHubClient("token", transport=transport)
    loop, thread = _make_loop_in_background()
    bindings = ToolBindings(
        db=db,
        github=github,
        git_transport=LocalGitTransport(token=None),
        repo=_stub_repo(),
        issue=_stub_issue(),
        workspace=_stub_workspace(tmp_path),
        loop=loop,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
        slot_uid=slot_uid,
    )
    db.upsert_issue(
        key=bindings.issue_key,
        repo="octo/widget",
        number=42,
        state="reproducing",
        branch=bindings.workspace.branch,
        session_dir=str(bindings.workspace.session_dir),
    )
    return bindings, loop, thread


def _ctx() -> HostToolContext[Any]:
    return HostToolContext(tool_call_id="tc-1", _cancel_event=threading.Event(), _send_update=lambda _payload: None)


def test_repo_command_env_scrubs_secrets_and_uses_workspace_cache(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("GITHUB_TOKEN", "secret-token")
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "secret-webhook")
    monkeypatch.setenv("ROBOMP_GH_PROXY_HMAC_KEY", "secret-proxy")
    monkeypatch.setenv("BUN_INSTALL_CACHE_DIR", "/data/cache/bun-cache")

    bindings, loop, thread = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)), slot_uid=2001)
    try:
        env = host_tools._repo_command_env(bindings)
    finally:
        _stop_loop(loop, thread)

    assert env["GITHUB_TOKEN"] == ""
    assert env["GITHUB_WEBHOOK_SECRET"] == ""
    assert env["ROBOMP_GH_PROXY_HMAC_KEY"] == ""
    assert env["BUN_INSTALL_CACHE_DIR"] == str(bindings.workspace.root / ".omp-xdg" / "cache" / "bun-install")
    assert env["XDG_CACHE_HOME"] == str(bindings.workspace.root / ".omp-xdg" / "cache")
    assert env["TMPDIR"] == str(bindings.workspace.root / ".omp-tmp")
    assert env["GIT_CONFIG_COUNT"] == "1"
    assert env["GIT_CONFIG_KEY_0"] == "safe.directory"
    assert env["GIT_CONFIG_VALUE_0"] == str(bindings.workspace.repo_dir)
    assert env["GIT_AUTHOR_NAME"] == bindings.author_name
    assert env["GIT_AUTHOR_EMAIL"] == bindings.author_email
    assert env["GIT_COMMITTER_NAME"] == bindings.author_name
    assert env["GIT_COMMITTER_EMAIL"] == bindings.author_email
    assert (bindings.workspace.root / ".omp-tmp").is_dir()


def test_run_repo_command_uses_slot_identity_kwargs(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    bindings, loop, thread = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)), slot_uid=2001)
    captured: dict[str, Any] = {}

    monkeypatch.setattr(
        host_tools,
        "_slot_subprocess_kwargs",
        lambda uid: {"user": uid, "group": uid, "extra_groups": [2000], "umask": 0o002},
    )

    def fake_run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(cmd, 0, "ok", "")

    monkeypatch.setattr(host_tools.subprocess, "run", fake_run)  # type: ignore[attr-defined]
    try:
        proc = host_tools._run_repo_command(bindings, ["git", "status"])
    finally:
        _stop_loop(loop, thread)

    assert proc.stdout == "ok"
    assert captured["cmd"] == ["git", "status"]
    kwargs = captured["kwargs"]
    assert kwargs["cwd"] == str(bindings.workspace.repo_dir)
    assert kwargs["user"] == 2001
    assert kwargs["group"] == 2001
    assert kwargs["extra_groups"] == [2000]
    assert kwargs["umask"] == 0o002
    assert kwargs["env"]["BUN_INSTALL_CACHE_DIR"].endswith("/.omp-xdg/cache/bun-install")


def _write_bun_repo(repo_dir: Path) -> None:
    repo_dir.mkdir(parents=True, exist_ok=True)
    (repo_dir / "package.json").write_text('{"name":"x"}', encoding="utf-8")
    (repo_dir / "bun.lock").write_text("{}", encoding="utf-8")


def test_ensure_workspace_dependencies_installs_when_missing(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    bindings, loop, thread = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    _write_bun_repo(bindings.workspace.repo_dir)
    captured: list[tuple[str, ...]] = []

    def fake_run_repo_command(
        _b: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        captured.append(tuple(cmd))
        return subprocess.CompletedProcess(list(cmd), 0, "449 packages installed", "")

    monkeypatch.setattr(host_tools, "_run_repo_command", fake_run_repo_command)
    try:
        host_tools.ensure_workspace_dependencies(bindings)
    finally:
        _stop_loop(loop, thread)

    assert captured == [("bun", "install", "--frozen-lockfile", "--ignore-scripts")]


def test_ensure_workspace_dependencies_reinstalls_when_node_modules_present(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A bare node_modules/ dir is NOT a "fully installed" sentinel: a prior
    # install that timed out or crashed half-way leaves a partial tree. The
    # frozen install must still run so bun re-links anything missing, instead
    # of skipping forever and leaving the resolver broken.
    import subprocess

    bindings, loop, thread = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    _write_bun_repo(bindings.workspace.repo_dir)
    (bindings.workspace.repo_dir / "node_modules").mkdir()
    captured: list[tuple[str, ...]] = []

    def fake_run_repo_command(
        _b: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        captured.append(tuple(cmd))
        return subprocess.CompletedProcess(list(cmd), 0, "Checked 449 packages", "")

    monkeypatch.setattr(host_tools, "_run_repo_command", fake_run_repo_command)
    try:
        host_tools.ensure_workspace_dependencies(bindings)
    finally:
        _stop_loop(loop, thread)

    assert captured == [("bun", "install", "--frozen-lockfile", "--ignore-scripts")]


def test_ensure_workspace_dependencies_skips_non_bun_repo(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # repo_dir exists (created by _stub_workspace) but has no package.json/bun.lock.
    bindings, loop, thread = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    called = False

    def fail_run(*_a: Any, **_k: Any) -> Any:
        nonlocal called
        called = True
        raise AssertionError("must not install in a non-bun repo")

    monkeypatch.setattr(host_tools, "_run_repo_command", fail_run)
    try:
        host_tools.ensure_workspace_dependencies(bindings)
    finally:
        _stop_loop(loop, thread)

    assert called is False


def test_ensure_workspace_dependencies_swallows_install_failure(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess

    bindings, loop, thread = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    _write_bun_repo(bindings.workspace.repo_dir)

    def failing_run(
        _b: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(list(cmd), 1, "", "lockfile out of date")

    monkeypatch.setattr(host_tools, "_run_repo_command", failing_run)
    try:
        # A stale frozen lockfile (e.g. a PR that bumped deps) must not raise —
        # the agent can still install itself or report the gap.
        host_tools.ensure_workspace_dependencies(bindings)
    finally:
        _stop_loop(loop, thread)

    assert not (bindings.workspace.repo_dir / "node_modules").exists()


def test_guarded_push_branch_rev_parse_runs_via_repo_command_and_passes_slot_uid(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import subprocess
    from dataclasses import replace

    from robomp.git_ops import PushResult

    class RecordingTransport:
        def __init__(self) -> None:
            self.calls: list[dict[str, Any]] = []

        def push_branch(self, **kwargs: Any) -> PushResult:
            self.calls.append(kwargs)
            return PushResult(head=str(kwargs["expected_head"]), branch=str(kwargs["branch"]))

    transport = RecordingTransport()
    bindings, loop, thread = _bindings(
        db,
        tmp_path,
        httpx.MockTransport(lambda _r: httpx.Response(500)),
        slot_uid=2001,
    )
    bindings = replace(bindings, git_transport=transport)
    commands: list[list[str]] = []

    def fake_run_repo_command(
        command_bindings: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None
    ) -> subprocess.CompletedProcess[str]:
        del timeout
        assert command_bindings.slot_uid == 2001
        command = list(cmd)
        commands.append(command)
        if command == ["git", "rev-parse", "HEAD"]:
            return subprocess.CompletedProcess(command, 0, "abc123\n", "")
        if command[:3] == ["git", "log", "--format=%H%x09%ae%x09%an"]:
            return subprocess.CompletedProcess(
                command,
                0,
                "abc123\trobomp-bot@example.invalid\trobomp-bot\n",
                "",
            )
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(host_tools, "_run_repo_command", fake_run_repo_command)
    monkeypatch.setattr(host_tools, "_share_git_metadata_with_slots", lambda _repo_dir, _slot_uid: None)
    try:
        head = host_tools._guarded_push_branch(bindings, {}, "gh_push_branch", bindings.workspace.branch)
    finally:
        _stop_loop(loop, thread)

    assert head == "abc123"
    assert ["git", "rev-parse", "HEAD"] in commands
    assert transport.calls == [
        {
            "repo": "octo/widget",
            "workspace_key": "octo__widget__42",
            "repo_dir": bindings.workspace.repo_dir,
            "branch": bindings.workspace.branch,
            "expected_head": "abc123",
            "slot_uid": 2001,
        }
    ]


def test_gh_post_comment_happy_path(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(201, json={"id": 999, "user": {"login": "robomp-bot"}, "body": "hi", "created_at": "t"})

    transport = httpx.MockTransport(handler)
    bindings, loop, t = _bindings(db, tmp_path, transport)
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        result = tool.execute({"body": "hi"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert result.startswith("comment posted")
    assert captured["url"].endswith("/repos/octo/widget/issues/42/comments")
    assert captured["body"] == {"body": "hi"}
    assert captured["auth"] == "Bearer token"


def test_gh_post_comment_validates_body(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        with pytest.raises(RpcCommandError):
            tool.execute({"body": ""}, _ctx())
    finally:
        _stop_loop(loop, t)


def test_gh_post_comment_defaults_to_inbound_pr_thread(db: Database, tmp_path: Path) -> None:
    """PR conversation/review tasks set inbound_thread_number to the PR; the
    agent's reply must land on that PR by default, not the originating issue."""
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(201, json={"id": 7, "user": {"login": "robomp-bot"}, "body": "hi", "created_at": "t"})

    transport = httpx.MockTransport(handler)
    github = GitHubClient("token", transport=transport)
    loop, thread = _make_loop_in_background()
    bindings = ToolBindings(
        db=db,
        github=github,
        git_transport=LocalGitTransport(token=None),
        repo=_stub_repo(),
        issue=_stub_issue(),  # issue #42
        workspace=_stub_workspace(tmp_path),
        loop=loop,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
        inbound_thread_number=99,  # PR #99 that fixes issue #42
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        tool.execute({"body": "hi"}, _ctx())
    finally:
        _stop_loop(loop, thread)

    assert captured["url"].endswith("/repos/octo/widget/issues/99/comments"), captured["url"]


def test_gh_post_comment_explicit_number_overrides_inbound(db: Database, tmp_path: Path) -> None:
    """An explicit `number` arg still wins over the inbound default."""
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(201, json={"id": 7, "user": {"login": "robomp-bot"}, "body": "hi", "created_at": "t"})

    transport = httpx.MockTransport(handler)
    github = GitHubClient("token", transport=transport)
    loop, thread = _make_loop_in_background()
    bindings = ToolBindings(
        db=db,
        github=github,
        git_transport=LocalGitTransport(token=None),
        repo=_stub_repo(),
        issue=_stub_issue(),
        workspace=_stub_workspace(tmp_path),
        loop=loop,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
        inbound_thread_number=99,
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        tool.execute({"body": "hi", "number": 42}, _ctx())
    finally:
        _stop_loop(loop, thread)

    assert captured["url"].endswith("/repos/octo/widget/issues/42/comments"), captured["url"]


def test_gh_post_comment_propagates_github_error(db: Database, tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(422, json={"message": "Validation failed"}))
    bindings, loop, t = _bindings(db, tmp_path, transport)
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"body": "hi"}, _ctx())
        assert "422" in str(exc.value)
    finally:
        _stop_loop(loop, t)


def test_gh_open_pr_requires_template_sections(db: Database, tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(500))
    bindings, loop, t = _bindings(db, tmp_path, transport)
    db.set_issue_classification(bindings.issue_key, "bug")
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"title": "t", "body": "no sections"}, _ctx())
        assert "Repro" in str(exc.value)
    finally:
        _stop_loop(loop, t)


def test_repro_record_writes_transcript(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "repro_record")
        result = tool.execute(
            {
                "title": "panic on empty input",
                "command": "bun test foo.test.ts",
                "output": "Error: boom",
                "exit_code": 1,
                "reproduced": True,
            },
            _ctx(),
        )
        assert result == "recorded"
        files = list(bindings.workspace.repro_dir.iterdir())
        assert len(files) == 1
        assert "exit_code: 1" in files[0].read_text()
    finally:
        _stop_loop(loop, t)


def test_repro_record_clears_needs_info_after_actionable_reply(db: Database, tmp_path: Path) -> None:
    removed: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        removed.append((request.method, request.url.path))
        return httpx.Response(204)

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    db.set_issue_state(bindings.issue_key, "needs_info")
    try:
        tool = next(x for x in build(bindings) if x.name == "repro_record")
        result = tool.execute(
            {
                "title": "panic on empty input",
                "command": "bun test foo.test.ts",
                "output": "Error: boom",
                "exit_code": 1,
            },
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)

    assert result == "recorded"
    assert removed == [("DELETE", "/repos/octo/widget/issues/42/labels/needs-info")]
    issue = db.get_issue(bindings.issue_key)
    assert issue and issue.state == "reproducing"


def test_repro_record_advances_needs_info_when_label_is_missing(db: Database, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert request.url.path == "/repos/octo/widget/issues/42/labels/needs-info"
        return httpx.Response(404, json={"message": "Label does not exist"})

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    db.set_issue_state(bindings.issue_key, "needs_info")
    try:
        tool = next(x for x in build(bindings) if x.name == "repro_record")
        tool.execute(
            {
                "title": "panic on empty input",
                "command": "bun test foo.test.ts",
                "output": "Error: boom",
                "exit_code": 1,
            },
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)

    issue = db.get_issue(bindings.issue_key)
    assert issue and issue.state == "reproducing"


def test_repro_record_advances_needs_info_when_cleanup_transport_fails(db: Database, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection dropped", request=request)

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    db.set_issue_state(bindings.issue_key, "needs_info")
    try:
        tool = next(x for x in build(bindings) if x.name == "repro_record")
        result = tool.execute(
            {
                "title": "panic on empty input",
                "command": "bun test foo.test.ts",
                "output": "Error: boom",
                "exit_code": 1,
            },
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)

    assert result == "recorded"
    issue = db.get_issue(bindings.issue_key)
    assert issue and issue.state == "reproducing"


def test_repro_record_chowns_to_slot_when_root(db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    chowns: list[tuple[Path, int, int]] = []
    monkeypatch.setattr(host_tools, "_slot_permissions_active", lambda slot_uid: slot_uid is not None)
    monkeypatch.setattr(
        "robomp.host_tools.os.chown",
        lambda path, uid, gid: chowns.append((Path(path), uid, gid)),
        raising=False,
    )

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)), slot_uid=2001)
    try:
        tool = next(x for x in build(bindings) if x.name == "repro_record")
        result = tool.execute(
            {
                "title": "panic on empty input",
                "command": "bun test foo.test.ts",
                "output": "Error: boom",
                "exit_code": 1,
            },
            _ctx(),
        )
        assert result == "recorded"
        files = list(bindings.workspace.repro_dir.iterdir())
        assert len(files) == 1
        assert chowns == [(files[0], 2001, 2001)]
    finally:
        _stop_loop(loop, t)


def test_repro_record_rejects_bad_args(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "repro_record")
        with pytest.raises(RpcCommandError):
            tool.execute({"title": "", "command": "x", "output": "y", "exit_code": 1}, _ctx())
        with pytest.raises(RpcCommandError):
            tool.execute({"title": "t", "command": "x", "output": "y", "exit_code": "bad"}, _ctx())
    finally:
        _stop_loop(loop, t)


def test_mark_unable_posts_comment_marks_needs_info_and_labels_issue(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/labels"):
            captured["labels"] = json.loads(request.content)
            return httpx.Response(200, json=[{"name": "bug"}, {"name": "needs-info"}])
        captured["comment"] = json.loads(request.content)
        return httpx.Response(201, json={"id": 321, "user": {"login": "robomp-bot"}, "body": "x", "created_at": "t"})

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "mark_unable_to_reproduce")
        result = tool.execute({"diagnosis": "needed exact version", "info_needed": "post bun --version"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "needs-info comment" in result
    assert captured["labels"] == {"labels": ["needs-info"]}
    assert "resume from this context" in captured["comment"]["body"]
    issue = db.get_issue(bindings.issue_key)
    assert issue and issue.state == "needs_info"


def test_mark_unable_keeps_needs_info_when_label_is_missing(db: Database, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/labels"):
            return httpx.Response(422, json={"message": "Label does not exist"})
        return httpx.Response(201, json={"id": 321, "user": {"login": "robomp-bot"}, "body": "x", "created_at": "t"})

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "mark_unable_to_reproduce")
        tool.execute({"diagnosis": "needed exact version", "info_needed": "post bun --version"}, _ctx())
    finally:
        _stop_loop(loop, t)

    issue = db.get_issue(bindings.issue_key)
    assert issue and issue.state == "needs_info"


def test_mark_unable_keeps_needs_info_when_label_transport_fails(db: Database, tmp_path: Path) -> None:
    comments = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal comments
        if request.url.path.endswith("/labels"):
            raise httpx.ConnectError("connection dropped", request=request)
        comments += 1
        return httpx.Response(201, json={"id": 321, "user": {"login": "robomp-bot"}, "body": "x", "created_at": "t"})

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "mark_unable_to_reproduce")
        tool.execute({"diagnosis": "needed exact version", "info_needed": "post bun --version"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert comments == 1
    issue = db.get_issue(bindings.issue_key)
    assert issue and issue.state == "needs_info"
    row = db._conn.execute(
        "SELECT result_json FROM tool_calls WHERE tool='mark_unable_to_reproduce' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    result = json.loads(row["result_json"])
    assert "ConnectError" in result["label_error"]


def test_abort_task_signals_controller_and_abandons_without_comment(db: Database, tmp_path: Path) -> None:
    # Any HTTP call is a regression: abort_task MUST NOT touch GitHub.
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError(f"abort_task issued an HTTP request to {request.url}")

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    controller = AbortController()
    stops: list[None] = []
    controller.stop = lambda: stops.append(None)
    # Frozen dataclass — rebuild with the controller attached.
    bindings = ToolBindings(
        db=bindings.db,
        github=bindings.github,
        git_transport=bindings.git_transport,
        repo=bindings.repo,
        issue=bindings.issue,
        workspace=bindings.workspace,
        loop=bindings.loop,
        author_name=bindings.author_name,
        author_email=bindings.author_email,
        settings=bindings.settings,
        inbound_thread_number=bindings.inbound_thread_number,
        inbound_is_pr=bindings.inbound_is_pr,
        slot_uid=bindings.slot_uid,
        abort=controller,
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "abort_task")
        result = tool.execute({"reason": "ref dir owned by foreign uid; git commit cannot lock HEAD"}, _ctx())
    finally:
        _stop_loop(loop, t)
    assert result == "aborted"
    assert controller.triggered
    assert "foreign uid" in controller.reason
    assert len(stops) == 1, "stop callback must fire exactly once"
    issue = db.get_issue(bindings.issue_key)
    assert issue and issue.state == "abandoned"
    # Audit row records the call. Use raw SQL because `Database` exposes a
    # writer but no reader for `tool_calls` — the dashboard reads via SQL too.
    with db._lock:  # noqa: SLF001 - test-only inspection
        row = db._conn.execute(  # noqa: SLF001
            "SELECT tool, args_json FROM tool_calls WHERE issue_key=? AND tool=?",
            (bindings.issue_key, "abort_task"),
        ).fetchone()
    assert row is not None
    assert "foreign uid" in row["args_json"]


def test_abort_task_rejects_empty_reason(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "abort_task")
        with pytest.raises(RpcCommandError):
            tool.execute({"reason": "   "}, _ctx())
    finally:
        _stop_loop(loop, t)
    # No state change on rejected validation.
    issue = db.get_issue(bindings.issue_key)
    assert issue and issue.state == "reproducing"


def test_abort_task_signal_is_idempotent(db: Database, tmp_path: Path) -> None:
    controller = AbortController()
    fires: list[None] = []
    controller.stop = lambda: fires.append(None)
    controller.signal("first")
    controller.signal("second")
    assert controller.triggered
    assert controller.reason == "first"  # second call must not overwrite
    assert len(fires) == 1, "stop must not be called again after the first abort"


def test_fetch_issue_thread_returns_markdown(db: Database, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/comments"):
            return httpx.Response(
                200,
                json=[
                    {"id": 1, "user": {"login": "alice"}, "body": "still broken", "created_at": "t1"},
                ],
            )
        return httpx.Response(
            200,
            json={
                "number": 42,
                "title": "boom",
                "body": "b",
                "state": "open",
                "user": {"login": "alice"},
                "labels": [{"name": "bug"}],
            },
        )

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "fetch_issue_thread")
        result = tool.execute({}, _ctx())
    finally:
        _stop_loop(loop, t)
    assert "octo/widget#42" in result
    assert "@alice" in result
    assert "still broken" in result


def test_classify_issue_applies_labels_and_persists_primary(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json=[{"name": n} for n in captured["body"]["labels"]],
        )

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        result = tool.execute(
            {
                "primary": "bug",
                "priority": "prio:p1",
                "functional": ["tool", "agent"],
                "provider": "provider:openai",
                "platform": "platform:macos",
                "rationale": "tool call panics on empty arg on macOS",
            },
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)

    assert "classified as bug" in result
    assert "reproduce" in result.lower()
    assert captured["path"].endswith("/issues/42/labels")
    assert captured["body"]["labels"] == [
        "bug",
        "prio:p1",
        "tool",
        "agent",
        "providers",
        "provider:openai",
        "platform:macos",
        "triaged",
    ]
    row = db.get_issue(bindings.issue_key)
    assert row is not None and row.classification == "bug"


def test_classify_issue_question_skips_repro_path(db: Database, tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=[{"name": "question"}, {"name": "triaged"}]))
    bindings, loop, t = _bindings(db, tmp_path, transport)
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        result = tool.execute(
            {"primary": "question", "rationale": "how-to about config"},
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)
    assert "question" in result
    assert "no PR" in result
    row = db.get_issue(bindings.issue_key)
    assert row is not None and row.classification == "question"


def test_classify_issue_wontfix_takes_comment_only_path(db: Database, tmp_path: Path) -> None:
    """`wontfix` is a non-PR primary: labels land, classification persists, and the
    echoed next step routes to a single explanatory comment — no repro, no PR."""
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=[{"name": "wontfix"}, {"name": "triaged"}]))
    bindings, loop, t = _bindings(db, tmp_path, transport)
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        result = tool.execute(
            {"primary": "wontfix", "rationale": "intentional design tradeoff, no demonstrated impact"},
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)
    assert "wontfix" in result
    assert "no PR" in result
    row = db.get_issue(bindings.issue_key)
    assert row is not None and row.classification == "wontfix"


def test_gh_search_issues_scopes_repo_and_renders_matches(db: Database, tmp_path: Path) -> None:
    """Search auto-prefixes the repo scope, surfaces PR/state_reason so triage can
    spot prior fixes and not-planned precedents, and filters the inbound issue."""
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["q"] = request.url.params["q"]
        return httpx.Response(
            200,
            json={
                "total_count": 3,
                "items": [
                    {
                        "number": 42,  # the inbound issue itself — must be filtered
                        "title": "boom",
                        "state": "open",
                        "user": {"login": "alice"},
                        "labels": [],
                        "comments": 0,
                        "updated_at": "2026-07-01T00:00:00Z",
                        "created_at": "2026-07-01T00:00:00Z",
                        "html_url": "https://example/42",
                    },
                    {
                        "number": 30,
                        "title": "same crash on resize",
                        "state": "closed",
                        "state_reason": "not_planned",
                        "user": {"login": "bob"},
                        "labels": [{"name": "wontfix"}],
                        "comments": 3,
                        "updated_at": "2026-06-01T00:00:00Z",
                        "created_at": "2026-05-01T00:00:00Z",
                        "html_url": "https://example/30",
                    },
                    {
                        "number": 31,
                        "title": "fix: resize crash",
                        "state": "closed",
                        "state_reason": "completed",
                        "user": {"login": "bot"},
                        "labels": [],
                        "comments": 1,
                        "updated_at": "2026-06-02T00:00:00Z",
                        "created_at": "2026-06-02T00:00:00Z",
                        "html_url": "https://example/pull/31",
                        "pull_request": {"url": "https://example/pull/31"},
                    },
                ],
            },
        )

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_search_issues")
        result = tool.execute({"query": "resize crash"}, _ctx())
    finally:
        _stop_loop(loop, t)
    assert captured["q"] == "repo:octo/widget resize crash"
    assert "#42" not in result  # inbound issue filtered out
    assert "#30 (issue, closed (not_planned))" in result
    assert "#31 (PR, closed (completed))" in result


def test_gh_search_issues_rejects_repo_qualifier_and_empty_query(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_search_issues")
        with pytest.raises(RpcCommandError):
            tool.execute({"query": "repo:evil/elsewhere secrets"}, _ctx())
        with pytest.raises(RpcCommandError):
            tool.execute({"query": "   "}, _ctx())
    finally:
        _stop_loop(loop, t)


def test_gh_search_issues_serves_from_local_index_once_synced(db: Database, tmp_path: Path) -> None:
    """With a sync watermark present the tool answers from SQLite: qualifiers
    become filters, merged PRs render as `merged`, and NO GitHub call happens."""

    def handler(_request: httpx.Request) -> httpx.Response:
        raise AssertionError("local-index search must not call GitHub")

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    db.set_issue_index_watermark("octo/widget", "2026-07-01T00:00:00Z")
    db.upsert_issue_index(
        IssueIndexEntry(
            repo="octo/widget",
            number=31,
            is_pull_request=True,
            title="fix: resize crash",
            body="handles narrow terminals",
            state="closed",
            state_reason="",
            merged_at="2026-06-02T00:00:00Z",
            author="bot",
            labels=(),
            comments=1,
            created_at="2026-06-02T00:00:00Z",
            updated_at="2026-06-02T00:00:00Z",
            html_url="https://example/pull/31",
        )
    )
    db.upsert_issue_index(
        IssueIndexEntry(
            repo="octo/widget",
            number=30,
            is_pull_request=False,
            title="resize crash report",
            body="",
            state="closed",
            state_reason="not_planned",
            merged_at="",
            author="bob",
            labels=("wontfix",),
            comments=3,
            created_at="2026-05-01T00:00:00Z",
            updated_at="2026-06-01T00:00:00Z",
            html_url="https://example/30",
        )
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_search_issues")
        result = tool.execute({"query": "resize crash"}, _ctx())
        pr_only = tool.execute({"query": "resize crash is:merged"}, _ctx())
    finally:
        _stop_loop(loop, t)
    assert "#30 (issue, closed (not_planned))" in result
    assert "#31 (PR, merged)" in result
    assert "#31" in pr_only and "#30" not in pr_only


def _git_repo_with_commits(bindings) -> None:
    """Turn the stub workspace repo_dir into a git repo with two commits."""
    repo = str(bindings.workspace.repo_dir)
    ident = ["-c", "user.name=t", "-c", "user.email=t@example.invalid"]
    subprocess.run(["git", "init", "-q", "-b", "main", repo], check=True)
    Path(repo, "a.txt").write_text("plain start\n", encoding="utf-8")
    subprocess.run(["git", "-C", repo, "add", "."], check=True)
    subprocess.run(["git", "-C", repo, *ident, "commit", "-q", "-m", "feat: initial import"], check=True)
    Path(repo, "a.txt").write_text("plain start\nsplitPathAndSel guard\n", encoding="utf-8")
    subprocess.run(["git", "-C", repo, "add", "."], check=True)
    subprocess.run(
        ["git", "-C", repo, *ident, "commit", "-q", "-m", "fix(tools): colon selector literal paths"],
        check=True,
    )


def test_search_commits_message_and_patch_modes(db: Database, tmp_path: Path) -> None:
    """message mode greps commit messages; patch mode pickaxes diff content.
    Without an origin ref the search falls back to HEAD instead of failing."""
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    _git_repo_with_commits(bindings)
    try:
        tool = next(x for x in build(bindings) if x.name == "search_commits")
        by_message = tool.execute({"query": "colon selector"}, _ctx())
        by_patch = tool.execute({"query": "splitPathAndSel", "mode": "patch"}, _ctx())
        none = tool.execute({"query": "nonexistent-topic"}, _ctx())
        with pytest.raises(RpcCommandError):
            tool.execute({"query": "x", "mode": "bogus"}, _ctx())
    finally:
        _stop_loop(loop, t)
    assert "fix(tools): colon selector literal paths" in by_message
    assert "feat: initial import" not in by_message
    assert "fix(tools): colon selector literal paths" in by_patch
    assert none.startswith("No commits")


def test_classify_issue_rejects_bug_without_priority(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        with pytest.raises(RpcCommandError):
            tool.execute({"primary": "bug", "rationale": "yes a bug"}, _ctx())
    finally:
        _stop_loop(loop, t)


def test_classify_issue_drops_priority_on_non_bug(db: Database, tmp_path: Path) -> None:
    """Non-bug primaries silently drop a stray `priority` rather than rejecting.

    Some models treat every tool-schema property as required and would loop
    forever if a non-empty optional value triggered a hard validation error.
    """
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=[{"name": "question"}, {"name": "triaged"}])

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        result = tool.execute(
            {"primary": "question", "priority": "prio:p3", "rationale": "how-to"},
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)
    assert "question" in result
    # priority must NOT be applied as a label on non-bug classifications.
    assert "prio:p3" not in (captured["body"].get("labels") or [])
    row = db.get_issue(bindings.issue_key)
    assert row is not None and row.classification == "question"


def test_classify_issue_rejects_unknown_primary(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        with pytest.raises(RpcCommandError):
            tool.execute({"primary": "nonsense", "rationale": "x"}, _ctx())
    finally:
        _stop_loop(loop, t)


def _pr_bindings(
    db: Database, tmp_path: Path, transport: httpx.MockTransport
) -> tuple[ToolBindings, asyncio.AbstractEventLoop, threading.Thread]:
    """Same as _bindings but with `inbound_is_pr=True` — webhook arrived on a PR."""
    github = GitHubClient("token", transport=transport)
    loop, thread = _make_loop_in_background()
    bindings = ToolBindings(
        db=db,
        github=github,
        git_transport=LocalGitTransport(token=None),
        repo=_stub_repo(),
        issue=_stub_issue(),
        workspace=_stub_workspace(tmp_path),
        loop=loop,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
        inbound_thread_number=99,
        inbound_is_pr=True,
    )
    db.upsert_issue(
        key=bindings.issue_key,
        repo="octo/widget",
        number=42,
        state="opened",
        branch=bindings.workspace.branch,
        session_dir=str(bindings.workspace.session_dir),
        pr_number=99,
    )
    db.set_issue_classification(bindings.issue_key, "bug")
    return bindings, loop, thread


def _review_bindings(
    db: Database,
    tmp_path: Path,
    transport: httpx.MockTransport,
    *,
    platform: str = "github",
) -> tuple[ToolBindings, asyncio.AbstractEventLoop, threading.Thread]:
    github = GitHubClient("token", transport=transport, platform=platform)
    loop, thread = _make_loop_in_background()
    issue = IssueInfo(
        repo="octo/widget",
        number=99,
        title="contributor PR",
        body="body",
        state="open",
        author="alice",
        labels=(),
        is_pull_request=True,
    )
    workspace = _stub_workspace(tmp_path)
    workspace.issue_number = 99
    bindings = ToolBindings(
        db=db,
        github=github,
        git_transport=LocalGitTransport(token=None),
        repo=_stub_repo(),
        issue=issue,
        workspace=workspace,
        loop=loop,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
        inbound_thread_number=99,
        inbound_is_pr=True,
        review_mode=True,
    )
    db.upsert_issue(
        key=bindings.issue_key,
        repo="octo/widget",
        number=99,
        state="reviewing",
        branch=bindings.workspace.branch,
        session_dir=str(bindings.workspace.session_dir),
        pr_number=99,
    )
    return bindings, loop, thread


def test_fetch_pr_returns_premise_and_changed_files(db: Database, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99":
            return httpx.Response(
                200,
                json={
                    "number": 99,
                    "html_url": "https://github.com/octo/widget/pull/99",
                    "title": "Fix crash",
                    "body": "Fixes #42",
                    "head": {"ref": "fix-crash", "repo": {"full_name": "alice/widget"}},
                    "base": {"ref": "main"},
                    "state": "open",
                    "user": {"login": "alice"},
                },
            )
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return httpx.Response(
                200,
                json=[{"filename": "src/app.py", "status": "modified", "additions": 5, "deletions": 2}],
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "fetch_pr")
        result = tool.execute({}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "Fix crash" in result
    assert "#42" in result
    assert "`src/app.py` (modified, +5/-2)" in result


def test_classify_pr_applies_review_labels_and_persists_rank(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=[{"name": label} for label in captured["body"]["labels"]])

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_pr")
        result = tool.execute(
            {
                "rank": "review:p1",
                "type": "fix",
                "area": ["tool", "unknown"],
                "provider": "provider:openai",
                "rationale": "fixes the tool crash with a scoped guard",
            },
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)

    assert "review:p1" in result
    assert captured["path"].endswith("/issues/99/labels")
    assert captured["body"]["labels"] == ["triaged", "review:p1", "fix", "tool", "providers", "provider:openai"]
    row = db.get_issue(bindings.issue_key)
    assert row is not None and row.classification == "review:p1"


def test_classify_pr_rejects_bad_rank(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_pr")
        with pytest.raises(RpcCommandError):
            tool.execute({"rank": "prio:p1", "type": "fix", "rationale": "wrong namespace"}, _ctx())
    finally:
        _stop_loop(loop, t)


def test_pr_review_comment_stages_and_submit_flushes_one_comment_review(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            captured["path"] = request.url.path
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": captured["body"]["body"],
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        staged = stage_tool.execute(
            {
                "path": "src/app.py",
                "line": 12,
                "side": "RIGHT",
                "start_line": 10,
                "start_side": "RIGHT",
                "body": "blocking: this dereferences cfg before the guard.",
            },
            _ctx(),
        )
        assert "staged_count=1" in staged
        rows = db.list_staged_review_comments(bindings.issue_key)
        assert len(rows) == 1
        assert rows[0].path == "src/app.py"

        result = submit_tool.execute({"body": "review:p1 — one blocking issue", "event": "APPROVE"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "submitted PR review" in result
    assert captured["path"].endswith("/pulls/99/reviews")
    assert captured["body"] == {
        "body": "review:p1 — one blocking issue",
        "event": "COMMENT",
        "comments": [
            {
                "path": "src/app.py",
                "line": 12,
                "side": "RIGHT",
                "body": "blocking: this dereferences cfg before the guard.",
                "start_line": 10,
                "start_side": "RIGHT",
            }
        ],
    }
    assert db.list_staged_review_comments(bindings.issue_key) == []


def test_submit_pr_review_posts_summary_only_when_no_staged_comments(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={"id": 45, "user": {"login": "robomp-bot"}, "body": "ok", "state": "COMMENTED", "submitted_at": "t"},
        )

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        result = tool.execute({"body": "lgtm — scoped fix"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "comments=0" in result
    assert captured["body"]["event"] == "COMMENT"
    assert captured["body"]["comments"] == []


def test_submit_pr_review_failure_keeps_staged_comments(db: Database, tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        return httpx.Response(403, json={"message": "forbidden"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 12, "body": "finding"}, _ctx())
        with pytest.raises(RpcCommandError):
            submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    rows = db.list_staged_review_comments(bindings.issue_key)
    assert len(rows) == 1
    assert rows[0].path == "src/app.py"


def test_submit_pr_review_drops_unanchorable_comment_and_folds_into_summary(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": captured["body"]["body"],
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 12, "body": "in-hunk finding"}, _ctx())
        stage_tool.execute({"path": "src/app.py", "line": 15, "body": "gap finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert captured["body"]["body"] == "summary\n\n## Not anchored to diff\n- **`src/app.py:15`** — gap finding"
    assert captured["body"]["comments"] == [
        {"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "in-hunk finding"}
    ]
    assert "submitted PR review" in result
    assert "dropped=1" in result
    assert db.list_staged_review_comments(bindings.issue_key) == []


def test_submit_pr_review_drops_all_comments_submits_summary_only(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": "ok",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 15, "body": "gap finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert captured["body"]["comments"] == []
    assert captured["body"]["body"].endswith("## Not anchored to diff\n- **`src/app.py:15`** — gap finding")
    assert "comments=0" in result
    assert "dropped=1" in result
    assert db.list_staged_review_comments(bindings.issue_key) == []


def test_submit_pr_review_drops_comment_for_path_not_in_diff(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": "ok",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/other.py", "line": 3, "body": "stale path finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert captured["body"]["comments"] == []
    assert captured["body"]["body"].endswith("## Not anchored to diff\n- **`src/other.py:3`** — stale path finding")
    assert "dropped=1" in result
    assert db.list_staged_review_comments(bindings.issue_key) == []


def test_submit_pr_review_skips_validation_when_files_fetch_fails(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request, status=500)
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": "ok",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 15, "body": "gap finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert captured["body"]["comments"] == [{"path": "src/app.py", "line": 15, "side": "RIGHT", "body": "gap finding"}]
    assert captured["body"]["body"] == "summary"
    assert "comments=1" in result
    assert "dropped" not in result


def test_submit_pr_review_422_falls_back_to_issue_comments(db: Database, tmp_path: Path) -> None:
    comment_bodies: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            return httpx.Response(422, json={"message": "Validation failed"})
        if request.url.path == "/repos/octo/widget/issues/99/comments":
            body = json.loads(request.content)["body"]
            comment_bodies.append(body)
            return httpx.Response(200, json={"id": len(comment_bodies), "body": body})
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 12, "body": "finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "posted summary + 1 inline comment(s) as issue comments" in result
    assert comment_bodies == ["summary", "**`src/app.py:12`**\n\nfinding"]
    assert db.list_staged_review_comments(bindings.issue_key) == []


def test_submit_pr_review_500_falls_back_to_issue_comments(db: Database, tmp_path: Path) -> None:
    """A 500 from Forgejo's reviews endpoint triggers the same fallback as 422.

    Without this, the 500 propagates to the model, causing a retry-and-degrade
    loop where the model strips newlines from subsequent review bodies.
    """
    comment_bodies: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            return httpx.Response(500, json={"message": "github error"})
        if request.url.path == "/repos/octo/widget/issues/99/comments":
            body = json.loads(request.content)["body"]
            comment_bodies.append(body)
            return httpx.Response(200, json={"id": len(comment_bodies), "body": body})
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 12, "body": "finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "posted summary + 1 inline comment(s) as issue comments" in result
    assert comment_bodies == ["summary", "**`src/app.py:12`**\n\nfinding"]
    assert db.list_staged_review_comments(bindings.issue_key) == []


def test_submit_pr_review_range_requires_both_endpoints_anchorable(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": "ok",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        # Reversed range: start_line (15) > line (14) — dropped.
        stage_tool.execute(
            {
                "path": "src/app.py",
                "line": 14,
                "start_line": 15,
                "start_side": "RIGHT",
                "side": "RIGHT",
                "body": "reversed range",
            },
            _ctx(),
        )
        # Valid range: both endpoints (10, 12) are context lines in the hunk — kept.
        stage_tool.execute(
            {
                "path": "src/app.py",
                "line": 12,
                "start_line": 10,
                "start_side": "RIGHT",
                "side": "RIGHT",
                "body": "valid range",
            },
            _ctx(),
        )
        # Cross-side range: start_side LEFT with side RIGHT — dropped.
        stage_tool.execute(
            {
                "path": "src/app.py",
                "line": 11,
                "start_line": 10,
                "start_side": "LEFT",
                "side": "RIGHT",
                "body": "cross-side range",
            },
            _ctx(),
        )
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert captured["body"]["comments"] == [
        {
            "path": "src/app.py",
            "line": 12,
            "side": "RIGHT",
            "body": "valid range",
            "start_line": 10,
            "start_side": "RIGHT",
        }
    ]
    assert "src/app.py:14" in captured["body"]["body"]
    assert "src/app.py:11" in captured["body"]["body"]
    assert "dropped=2" in result


def test_submit_pr_review_forgejo_fetches_commit_id(db: Database, tmp_path: Path) -> None:
    """Forgejo anchors inline comments by commit: submit must fetch the PR and
    include the head sha as commit_id in the reviews POST body."""
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99":
            return httpx.Response(
                200,
                json={
                    "number": 99,
                    "html_url": "https://x/octo/widget/pull/99",
                    "head": {"ref": "fix-crash", "sha": "abc123456789"},
                    "base": {"ref": "main"},
                    "state": "open",
                    "user": {"login": "alice"},
                },
            )
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": "ok",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler), platform="forgejo")
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 12, "body": "in-hunk finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "submitted PR review" in result
    assert captured["body"]["commit_id"] == "abc123456789"


def test_submit_pr_review_forgejo_commit_id_fetch_failure_is_swallowed(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When the PR fetch fails the commit_id is omitted (fail open) and the
    review still submits without it."""
    monkeypatch.setattr(GitHubClient, "_TRANSIENT_RETRY_DELAYS", (0.01, 0.01))
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99":
            return httpx.Response(500, json={"message": "internal error"})
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": "ok",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler), platform="forgejo")
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 12, "body": "in-hunk finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "submitted PR review" in result
    assert "commit_id" not in captured["body"]


def test_submit_pr_review_422_and_fallback_comment_failure_raises_and_keeps_staged(
    db: Database,
    tmp_path: Path,
) -> None:
    """When the reviews endpoint AND the issue-comments fallback both fail, the
    tool raises and the staged comments survive for a later retry."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            return httpx.Response(422, json={"message": "Validation failed"})
        if request.url.path == "/repos/octo/widget/issues/99/comments":
            return httpx.Response(500, json={"message": "internal error"})
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 12, "body": "finding"}, _ctx())
        with pytest.raises(RpcCommandError, match="fallback comment posting failed"):
            submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    rows = db.list_staged_review_comments(bindings.issue_key)
    assert len(rows) == 1
    assert rows[0].path == "src/app.py"


def test_submit_pr_review_empty_patch_fails_open(db: Database, tmp_path: Path) -> None:
    """A file whose patch the platform omitted is not a rejection reason: the
    comment is kept rather than folded into a 'Not anchored to diff' section."""
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request, patch="")
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": "ok",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 12, "body": "binary finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "submitted PR review" in result
    assert "dropped" not in result
    assert captured["body"]["comments"] == [
        {"path": "src/app.py", "line": 12, "side": "RIGHT", "body": "binary finding"}
    ]
    assert "Not anchored to diff" not in captured["body"]["body"]


def test_submit_pr_review_left_side_single_line_anchoring(db: Database, tmp_path: Path) -> None:
    """LEFT-side comments anchor against the old file's hunk lines
    (_PATCH: LEFT {9..12}): an in-hunk line is kept, an out-of-hunk line is
    dropped and folded into the summary."""
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/pulls/99/files":
            return _pr_files_response(request)
        if request.url.path.endswith("/reviews"):
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "id": 44,
                    "user": {"login": "robomp-bot"},
                    "body": "ok",
                    "state": "COMMENTED",
                    "submitted_at": "t",
                },
            )
        return httpx.Response(404, json={"message": "unrouted"})

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        stage_tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        submit_tool = next(x for x in build(bindings) if x.name == "submit_pr_review")
        stage_tool.execute({"path": "src/app.py", "line": 10, "side": "LEFT", "body": "old line finding"}, _ctx())
        stage_tool.execute({"path": "src/app.py", "line": 13, "side": "LEFT", "body": "gap finding"}, _ctx())
        result = submit_tool.execute({"body": "summary"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "dropped=1" in result
    assert captured["body"]["comments"] == [
        {"path": "src/app.py", "line": 10, "side": "LEFT", "body": "old line finding"}
    ]
    assert "## Not anchored to diff" in captured["body"]["body"]
    assert "**`src/app.py:13`** — gap finding" in captured["body"]["body"]


def test_diff_anchorable_lines_parses_hunk_sides() -> None:
    right, left = host_tools._diff_anchorable_lines(_PATCH)
    assert right == frozenset({10, 11, 12, 13, 14})
    assert left == frozenset({9, 10, 11, 12})

    # Gap between hunks: line 30 in the old file / 29..30 in the new file are
    # unanchorable (the PR 1111 smtp.go:106 failure shape).
    right, left = host_tools._diff_anchorable_lines("@@ -1,2 +1,3 @@\n a\n+x\n b\n@@ -30,2 +31,2 @@\n c\n d\n")
    assert right >= frozenset({1, 2, 3, 31, 32})
    assert right.isdisjoint(range(4, 31))

    assert host_tools._diff_anchorable_lines("") == (frozenset(), frozenset())
    assert host_tools._diff_anchorable_lines("\0Binary files differ") == (frozenset(), frozenset())

    right, left = host_tools._diff_anchorable_lines("@@ -9 +10 @@ x\n+a\n b\n")
    assert right == frozenset({10, 11})
    assert left == frozenset({9})

    # `\ No newline at end of file` markers are ignored.
    right, _ = host_tools._diff_anchorable_lines("@@ -1,2 +1,3 @@\n a\n+b\n\\ No newline at end of file\n")
    assert right == frozenset({1, 2})

    # File-creation hunk boundary: everything is added, nothing exists on the
    # LEFT; file-deletion hunk: everything is removed, RIGHT is empty.
    right, left = host_tools._diff_anchorable_lines("@@ -0,0 +1,2 @@\n+a\n+b\n")
    assert right == frozenset({1, 2})
    assert left == frozenset()

    right, left = host_tools._diff_anchorable_lines("@@ -5,3 +5,0 @@\n-a\n-b\n-c\n")
    assert right == frozenset()
    assert left == frozenset({5, 6, 7})


def test_diff_anchorable_lines_in_hunk_plus_minus_content() -> None:
    """Added lines whose content starts with `++` and removed lines starting
    with `--` must be treated as diff content, not file headers — otherwise
    the line counters desync (the `+++ b/...` skip used to swallow them)."""
    patch = "+++ b/src/app.py\n--- a/src/app.py\n@@ -1,2 +1,3 @@\n ctx\n tail\n--- removed\n+++ added\n"
    # Old file: ctx(1), tail(2), --- removed(3). New file: ctx(1), tail(2), +++ added(3).
    right, left = host_tools._diff_anchorable_lines(patch)
    assert right == frozenset({1, 2, 3})
    assert left == frozenset({1, 2, 3})


def test_review_tools_reject_outside_review_mode(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "pr_review_comment")
        with pytest.raises(RpcCommandError):
            tool.execute({"path": "x.py", "line": 1, "body": "nit"}, _ctx())
    finally:
        _stop_loop(loop, t)


def test_review_mode_rejects_push_and_open_pr_before_repo_commands(db: Database, tmp_path: Path) -> None:
    calls: list[list[str] | tuple[str, ...]] = []

    def record_repo_command(_bindings: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None):
        del timeout
        calls.append(cmd)
        raise AssertionError("repo command must not run in review mode")

    bindings, loop, t = _review_bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    try:
        original = host_tools._run_repo_command
        host_tools._run_repo_command = record_repo_command  # type: ignore[assignment]
        push = next(x for x in build(bindings) if x.name == "gh_push_branch")
        open_pr = next(x for x in build(bindings) if x.name == "gh_open_pr")
        with pytest.raises(RpcCommandError):
            push.execute({}, _ctx())
        with pytest.raises(RpcCommandError):
            open_pr.execute({"title": "t", "body": "invalid"}, _ctx())
    finally:
        host_tools._run_repo_command = original  # type: ignore[assignment]
        _stop_loop(loop, t)

    assert calls == []


@pytest.mark.parametrize("classification", ["enhancement", "proposal"])
def test_impl_gate_rejects_unauthorized_non_auto_classification_before_repo_commands(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, classification: str
) -> None:
    calls: list[list[str] | tuple[str, ...]] = []

    def record_repo_command(_bindings: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None):
        del timeout
        calls.append(cmd)
        raise AssertionError("repo command must not run before implementation authorization")

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    db.set_issue_classification(bindings.issue_key, classification)
    monkeypatch.setattr(host_tools, "_run_repo_command", record_repo_command)
    try:
        push = next(x for x in build(bindings) if x.name == "gh_push_branch")
        open_pr = next(x for x in build(bindings) if x.name == "gh_open_pr")
        with pytest.raises(RpcCommandError) as push_exc:
            push.execute({}, _ctx())
        with pytest.raises(RpcCommandError) as pr_exc:
            open_pr.execute({"title": "fix: x", "body": "invalid"}, _ctx())
    finally:
        _stop_loop(loop, t)

    for msg in (str(push_exc.value), str(pr_exc.value)):
        assert f"classified `{classification}`" in msg
        assert "OWNER or allowlisted maintainer" in msg
        assert "gh_post_comment" in msg
    assert calls == []
    rows = db._conn.execute(
        "SELECT tool, error FROM tool_calls WHERE tool IN ('gh_push_branch', 'gh_open_pr') ORDER BY id"
    ).fetchall()
    assert [row["tool"] for row in rows] == ["gh_push_branch", "gh_open_pr"]
    assert all(f"classified `{classification}`" in row["error"] for row in rows)


@pytest.mark.parametrize("classification", ["enhancement", "proposal"])
def test_impl_gate_allows_authorized_non_auto_classification_to_reach_pr_validation(
    db: Database, tmp_path: Path, classification: str
) -> None:
    from dataclasses import replace

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    db.set_issue_classification(bindings.issue_key, classification)
    bindings = replace(bindings, impl_authorized=True)
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"title": "fix: x", "body": ""}, _ctx())
    finally:
        _stop_loop(loop, t)

    msg = str(exc.value)
    assert "requires a non-empty 'body'" in msg
    assert "OWNER or allowlisted maintainer" not in msg


@pytest.mark.parametrize("classification", ["enhancement", "proposal"])
def test_impl_gate_allows_authorized_non_auto_classification_push_to_reach_repo_commands(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, classification: str
) -> None:
    from dataclasses import replace

    calls: list[list[str] | tuple[str, ...]] = []

    def record_repo_command(_bindings: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None):
        del timeout
        calls.append(cmd)
        raise RuntimeError("authorized non-auto issue reached gh_push_branch repo command")

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    db.set_issue_classification(bindings.issue_key, classification)
    bindings = replace(bindings, impl_authorized=True)
    monkeypatch.setattr(host_tools, "_run_repo_command", record_repo_command)
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RuntimeError, match="authorized non-auto issue reached gh_push_branch repo command"):
            tool.execute({}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert calls


def test_impl_gate_allows_later_authorized_event_to_reach_repo_commands(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[list[str] | tuple[str, ...]] = []

    def record_repo_command(_bindings: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None):
        del timeout
        calls.append(cmd)
        raise RuntimeError("later authorized event reached gh_push_branch repo command")

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    db.set_issue_classification(bindings.issue_key, "enhancement")
    db.record_event(
        delivery_id="auth-event",
        event_type="issue_comment",
        repo=bindings.issue.repo,
        issue_key=bindings.issue_key,
        payload={
            "_robomp_directive": {
                "body": "go ahead",
                "author": "can1357",
                "pragmas": [],
                "authorizes_impl": True,
            }
        },
    )
    monkeypatch.setattr(host_tools, "_run_repo_command", record_repo_command)
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RuntimeError, match="later authorized event reached gh_push_branch repo command"):
            tool.execute({}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert calls


def test_impl_gate_ignores_skipped_authorized_event(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[list[str] | tuple[str, ...]] = []

    def record_repo_command(_bindings: ToolBindings, cmd: list[str] | tuple[str, ...], *, timeout: float | None = None):
        del timeout
        calls.append(cmd)
        raise AssertionError("skipped authorization must not reach repo command")

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    db.set_issue_classification(bindings.issue_key, "enhancement")
    db.record_event(
        delivery_id="skipped-auth-event",
        event_type="issue_comment",
        repo=bindings.issue.repo,
        issue_key=bindings.issue_key,
        payload={
            "_robomp_directive": {
                "body": "go ahead",
                "author": "can1357",
                "pragmas": [],
                "authorizes_impl": True,
            }
        },
        state="skipped",
    )
    monkeypatch.setattr(host_tools, "_run_repo_command", record_repo_command)
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert "OWNER or allowlisted maintainer" in str(exc.value)
    assert calls == []


def test_impl_gate_allows_bug_without_directive_to_reach_pr_validation(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    db.set_issue_classification(bindings.issue_key, "bug")
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"title": "fix: x", "body": ""}, _ctx())
    finally:
        _stop_loop(loop, t)

    msg = str(exc.value)
    assert "requires a non-empty 'body'" in msg
    assert "OWNER or allowlisted maintainer" not in msg


def test_impl_gate_allows_existing_proposal_pr_to_reach_pr_validation(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda _r: httpx.Response(500)))
    db.set_issue_classification(bindings.issue_key, "proposal")
    db.set_issue_pr(bindings.issue_key, 7)
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"title": "fix: x", "body": ""}, _ctx())
    finally:
        _stop_loop(loop, t)

    msg = str(exc.value)
    assert "requires a non-empty 'body'" in msg
    assert "OWNER or allowlisted maintainer" not in msg


def test_classify_issue_on_pr_thread_is_noop(db: Database, tmp_path: Path) -> None:
    """On PR threads the tool must not hit GitHub and must not raise."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(500)

    bindings, loop, t = _pr_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        result = tool.execute(
            {"primary": "documentation", "rationale": "docs only"},
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)
    assert "no-op" in result.lower()
    assert calls == []  # no GitHub label mutation
    # Classification must remain whatever it was before — not overwritten.
    row = db.get_issue(bindings.issue_key)
    assert row is not None and row.classification == "bug"


def test_classify_issue_already_classified_is_noop(db: Database, tmp_path: Path) -> None:
    """Re-classifying an already-classified issue is rejected without GitHub side effects."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(500)

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    db.set_issue_classification(bindings.issue_key, "bug")
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        result = tool.execute(
            {"primary": "question", "rationale": "actually a question"},
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)
    assert "no-op" in result.lower()
    assert "already classified" in result.lower()
    assert calls == []
    row = db.get_issue(bindings.issue_key)
    assert row is not None and row.classification == "bug"  # unchanged


def test_set_issue_labels_on_pr_thread_is_noop(db: Database, tmp_path: Path) -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(500)

    bindings, loop, t = _pr_bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "set_issue_labels")
        result = tool.execute({"labels": ["wontfix"]}, _ctx())
    finally:
        _stop_loop(loop, t)
    assert "no-op" in result.lower()
    assert calls == []


def _init_git_repo(repo_dir: Path, branch: str) -> None:
    """Initialize a minimal git repo at `repo_dir` with `branch` checked out."""
    import os as _os
    import subprocess as _sp

    repo_dir.mkdir(parents=True, exist_ok=True)
    _sp.run(
        ["git", "init", f"--initial-branch={branch}", str(repo_dir)],
        check=True,
        capture_output=True,
        text=True,
    )
    (repo_dir / "README.md").write_text("hi\n", encoding="utf-8")
    _sp.run(["git", "-C", str(repo_dir), "add", "."], check=True, capture_output=True, text=True)
    _sp.run(
        ["git", "commit", "-m", "init"],
        cwd=str(repo_dir),
        check=True,
        capture_output=True,
        text=True,
        env=_os.environ
        | {
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
        },
    )


def test_classify_issue_renames_branch_when_slug_provided(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(
        db,
        tmp_path,
        httpx.MockTransport(
            lambda r: httpx.Response(200, json=[{"name": "bug"}, {"name": "prio:p1"}, {"name": "triaged"}])
        ),
    )
    # The stub workspace's initial branch matches `_stub_workspace`.
    _init_git_repo(bindings.workspace.repo_dir, bindings.workspace.branch)
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        result = tool.execute(
            {
                "primary": "bug",
                "priority": "prio:p1",
                "rationale": "powershell env colon-var parsing on win is broken",
                "branch_slug": "fix-windows-env-colon-vars",
            },
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)

    assert "branch renamed to" in result.lower()
    assert bindings.workspace.branch == "farm/abc12345/fix-windows-env-colon-vars"
    row = db.get_issue(bindings.issue_key)
    assert row is not None and row.branch == "farm/abc12345/fix-windows-env-colon-vars"
    import subprocess as _sp

    head = _sp.run(
        ["git", "symbolic-ref", "HEAD"],
        cwd=str(bindings.workspace.repo_dir),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head == "refs/heads/farm/abc12345/fix-windows-env-colon-vars"


def test_classify_issue_rejects_invalid_branch_slug(db: Database, tmp_path: Path) -> None:
    """Bad slug is rejected BEFORE GitHub is contacted (no labels applied)."""
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(500)

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        with pytest.raises(RpcCommandError):
            tool.execute(
                {
                    "primary": "bug",
                    "priority": "prio:p1",
                    "rationale": "x",
                    "branch_slug": "Has-Caps",
                },
                _ctx(),
            )
    finally:
        _stop_loop(loop, t)

    assert requests == []  # no GitHub call attempted
    # Branch unchanged; issue row unchanged.
    assert bindings.workspace.branch == "farm/abc12345/some-issue"


def test_classify_issue_rename_failure_does_not_apply_labels_or_classification(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(200, json=[])

    def fail_rename(*_args: object, **_kwargs: object) -> str:
        raise host_tools.GitCommandError(["git", "branch", "-m"], 128, "", "fatal: detected dubious ownership")

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    monkeypatch.setattr(host_tools, "rename_workspace_branch", fail_rename)
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        with pytest.raises(RpcCommandError):
            tool.execute(
                {
                    "primary": "bug",
                    "priority": "prio:p1",
                    "rationale": "x",
                    "branch_slug": "fix-orphan-tool-output",
                },
                _ctx(),
            )
    finally:
        _stop_loop(loop, t)

    assert requests == []
    row = db.get_issue(bindings.issue_key)
    assert row is not None
    assert row.classification is None
    assert row.branch == "farm/abc12345/some-issue"
    assert bindings.workspace.branch == "farm/abc12345/some-issue"


def test_classify_issue_omitting_branch_slug_is_a_noop(db: Database, tmp_path: Path) -> None:
    """Existing callers that don't pass branch_slug must keep the original branch."""
    bindings, loop, t = _bindings(
        db,
        tmp_path,
        httpx.MockTransport(lambda r: httpx.Response(200, json=[{"name": "question"}, {"name": "triaged"}])),
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "classify_issue")
        result = tool.execute(
            {"primary": "question", "rationale": "how-to"},
            _ctx(),
        )
    finally:
        _stop_loop(loop, t)

    assert "branch renamed" not in result.lower()
    assert bindings.workspace.branch == "farm/abc12345/some-issue"


def test_set_issue_labels_appends(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=[{"name": n} for n in captured["body"]["labels"]])

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    try:
        tool = next(x for x in build(bindings) if x.name == "set_issue_labels")
        result = tool.execute({"labels": ["wontfix"]}, _ctx())
    finally:
        _stop_loop(loop, t)
    assert "wontfix" in result
    assert captured["body"]["labels"] == ["wontfix"]


def test_set_issue_labels_rejects_empty(db: Database, tmp_path: Path) -> None:
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    try:
        tool = next(x for x in build(bindings) if x.name == "set_issue_labels")
        with pytest.raises(RpcCommandError):
            tool.execute({"labels": []}, _ctx())
        with pytest.raises(RpcCommandError):
            tool.execute({"labels": ["   ", ""]}, _ctx())
    finally:
        _stop_loop(loop, t)


def test_gh_push_branch_rejects_wrong_identity(db: Database, tmp_path: Path) -> None:
    """Pre-push gate refuses to push commits authored by anyone other than the configured identity."""
    import os
    import subprocess

    # Build a real local upstream + worktree so git operations actually work.
    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "seed",
        "GIT_AUTHOR_EMAIL": "seed@x",
        "GIT_COMMITTER_NAME": "seed",
        "GIT_COMMITTER_EMAIL": "seed@x",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        ["git", "-C", str(seed), "-c", "user.email=seed@x", "-c", "user.name=seed", "commit", "-m", "init"],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="identity test",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    # Commit with a different identity to provoke the gate.
    bad_env = os.environ | {
        "GIT_AUTHOR_NAME": "wrong",
        "GIT_AUTHOR_EMAIL": "wrong@nope",
        "GIT_COMMITTER_NAME": "wrong",
        "GIT_COMMITTER_EMAIL": "wrong@nope",
    }
    (ws.repo_dir / "x.txt").write_text("hi\n")
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "."], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(ws.repo_dir), "-c", "user.email=wrong@nope", "-c", "user.name=wrong", "commit", "-m", "bad"],
        check=True,
        capture_output=True,
        env=bad_env,
    )

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({}, _ctx())
        msg = str(exc.value)
        assert "identity mismatch" in msg
        assert "wrong <wrong@nope>" in msg
        assert "robomp-bot <robomp-bot@example.invalid>" in msg
        # Branch must NOT have been pushed.
        refs = subprocess.run(
            ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert not any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout
    finally:
        _stop_loop(loop, thread)


def test_gh_open_pr_rejects_wrong_identity_before_push_or_pr(db: Database, tmp_path: Path) -> None:
    """gh_open_pr uses the guarded push path before creating the pull request."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "seed",
        "GIT_AUTHOR_EMAIL": "seed@x",
        "GIT_COMMITTER_NAME": "seed",
        "GIT_COMMITTER_EMAIL": "seed@x",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        ["git", "-C", str(seed), "-c", "user.email=seed@x", "-c", "user.name=seed", "commit", "-m", "init"],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="identity test",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    bad_env = os.environ | {
        "GIT_AUTHOR_NAME": "wrong",
        "GIT_AUTHOR_EMAIL": "wrong@nope",
        "GIT_COMMITTER_NAME": "wrong",
        "GIT_COMMITTER_EMAIL": "wrong@nope",
    }
    (ws.repo_dir / "x.txt").write_text("hi\n")
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "."], check=True, capture_output=True)
    subprocess.run(
        ["git", "-C", str(ws.repo_dir), "-c", "user.email=wrong@nope", "-c", "user.name=wrong", "commit", "-m", "bad"],
        check=True,
        capture_output=True,
        env=bad_env,
    )

    opened_pr = False

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal opened_pr
        opened_pr = True
        return httpx.Response(
            201,
            json={
                "number": 7,
                "html_url": "https://github.com/octo/widget/pull/7",
                "head": {"ref": ws.branch},
                "base": {"ref": "main"},
            },
        )

    github = GitHubClient("tok", transport=httpx.MockTransport(handler))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        body = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nran tests\n\nFixes #42\n"
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"title": "fix: x", "body": body}, _ctx())
        assert "identity mismatch" in str(exc.value)
        assert not opened_pr
        refs = subprocess.run(
            ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert not any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout
    finally:
        _stop_loop(loop, thread)


def test_gh_push_branch_rejects_invalid_identity_scan_range(db: Database, tmp_path: Path) -> None:
    """A failing git-log author scan is a push rejection, not an empty successful scan."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="missing base ref",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    subprocess.run(
        ["git", "-C", str(ws.repo_dir), "update-ref", "-d", "refs/remotes/origin/main"], check=True, capture_output=True
    )
    (ws.repo_dir / "x.txt").write_text("hi\n")
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "x.txt"], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "ok",
        ],
        check=True,
        capture_output=True,
        env=env,
    )

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({}, _ctx())
        msg = str(exc.value)
        assert "could not inspect commit authors" in msg
        assert "origin/main..HEAD" in msg
        refs = subprocess.run(
            ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert not any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout
        row = db._conn.execute(
            "SELECT error FROM tool_calls WHERE tool='gh_push_branch' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        assert row is not None and "could not inspect commit authors" in row["error"]
        assert "origin/main..HEAD" in row["error"]
    finally:
        _stop_loop(loop, thread)


def test_gh_open_pr_requires_closes_keyword(db: Database, tmp_path: Path) -> None:
    """gh_open_pr refuses if the body has the four sections but no Fixes/Closes/Resolves keyword."""
    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(lambda r: httpx.Response(500)))
    db.set_issue_classification(bindings.issue_key, "bug")
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        body = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nran tests\n"
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"title": "fix: x", "body": body}, _ctx())
        assert "Fixes #42" in str(exc.value)
    finally:
        _stop_loop(loop, t)


def test_gh_open_pr_refuses_failed_bun_check_before_push_or_pr(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """gh_open_pr sends a failing pre-PR check back to the agent without creating a PR."""
    import os

    opened_pr = False

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal opened_pr
        opened_pr = True
        return httpx.Response(
            201,
            json={
                "number": 7,
                "html_url": "https://github.com/octo/widget/pull/7",
                "head": {"ref": "farm/abc12345/some-issue"},
                "base": {"ref": "main"},
            },
        )

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    db.set_issue_classification(bindings.issue_key, "bug")
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    fake_bun = fakebin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        'if [ "$1" != "check" ]; then printf "wrong command: %s\\n" "$1" >&2; exit 2; fi\n'
        'printf "TypeError: property missing\\n" >&2\n'
        "exit 1\n",
        encoding="utf-8",
    )
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")
    (bindings.workspace.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"check": "tsc --noEmit"}}) + "\n",
        encoding="utf-8",
    )

    try:
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        body = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nran tests\n\nFixes #42\n"
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"title": "fix: x", "body": body}, _ctx())
    finally:
        _stop_loop(loop, t)

    msg = str(exc.value)
    assert "refusing to open PR" in msg
    assert "`bun check` failed before open PR" in msg
    assert "TypeError: property missing" in msg
    assert not opened_pr
    row = db._conn.execute("SELECT error FROM tool_calls WHERE tool='gh_open_pr' ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None
    assert "TypeError: property missing" in row["error"]


def test_gh_open_pr_refuses_failed_bun_run_test_before_push_or_pr(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A red suite aborts PR creation: `bun run test` runs after `bun check`,
    and its failure output comes back to the agent instead of becoming a PR."""
    import os

    opened_pr = False

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal opened_pr
        opened_pr = True
        return httpx.Response(
            201,
            json={
                "number": 7,
                "html_url": "https://github.com/octo/widget/pull/7",
                "head": {"ref": "farm/abc12345/some-issue"},
                "base": {"ref": "main"},
            },
        )

    bindings, loop, t = _bindings(db, tmp_path, httpx.MockTransport(handler))
    db.set_issue_classification(bindings.issue_key, "bug")
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    fake_bun = fakebin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "check" ]; then exit 0; fi\n'
        'if [ "$1" = "run" ] && [ "$2" = "test" ]; then\n'
        '    printf "1 fail\\nexpect(received).toBe(expected)\\n" >&2\n'
        "    exit 1\n"
        "fi\n"
        'printf "unexpected bun call: %s\\n" "$*" >&2\n'
        "exit 2\n",
        encoding="utf-8",
    )
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")
    (bindings.workspace.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"check": "tsc --noEmit", "test": "bun test"}}) + "\n",
        encoding="utf-8",
    )

    try:
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        body = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nran tests\n\nFixes #42\n"
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"title": "fix: x", "body": body}, _ctx())
    finally:
        _stop_loop(loop, t)

    msg = str(exc.value)
    assert "refusing to open PR" in msg
    assert "`bun run test` failed before open PR" in msg
    assert "expect(received).toBe(expected)" in msg
    assert not opened_pr
    row = db._conn.execute("SELECT error FROM tool_calls WHERE tool='gh_open_pr' ORDER BY id DESC LIMIT 1").fetchone()
    assert row is not None
    assert "expect(received).toBe(expected)" in row["error"]


def test_gh_push_branch_rejects_dirty_worktree(db: Database, tmp_path: Path) -> None:
    """Pre-push gate refuses if the working tree has uncommitted changes."""
    import os
    import subprocess

    # Real upstream + worktree so git status works.
    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="dirty test",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    # Make a proper commit (so the identity gate passes).
    (ws.repo_dir / "a.txt").write_text("a\n")
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "a.txt"], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "ok",
        ],
        check=True,
        capture_output=True,
        env=env,
    )
    # Now dirty the worktree — uncommitted edit.
    (ws.repo_dir / "a.txt").write_text("a-modified\n")

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({}, _ctx())
        assert "working tree is dirty" in str(exc.value)
        # Nothing pushed.
        refs = subprocess.run(
            ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert not any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout
    finally:
        _stop_loop(loop, thread)


def test_gh_push_branch_runs_fix_and_check_before_pushing(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """gh_push_branch must run `bun run fix` then `bun check` (when defined)
    before the push reaches the remote. Same gate as `gh_open_pr` so a
    follow-up commit can't break CI."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="push gate",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    fix_calls = tmp_path / "fix-calls"
    check_calls = tmp_path / "check-calls"
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    fake_bun = fakebin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "run" ] && [ "$2" = "fix" ]; then\n'
        f"    printf called >> {fix_calls}\n"
        '    printf "formatted\\n" > src.txt\n'
        "    exit 0\n"
        "fi\n"
        'if [ "$1" = "check" ]; then\n'
        f"    printf called >> {check_calls}\n"
        "    exit 0\n"
        "fi\n"
        'printf "unexpected bun call: %s\\n" "$*" >&2\n'
        "exit 2\n"
    )
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")

    (ws.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"fix": "...", "check": "..."}}) + "\n",
        encoding="utf-8",
    )
    (ws.repo_dir / "src.txt").write_text("original\n")
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "package.json", "src.txt"], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "feat: follow-up",
        ],
        check=True,
        capture_output=True,
        env=env,
    )

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        result = tool.execute({}, _ctx())
    finally:
        _stop_loop(loop, thread)

    # Both gates ran, and fix preceded check (both have one call recorded).
    assert fix_calls.read_text() == "called"
    assert check_calls.read_text() == "called"
    # The formatter's diff was amended into the agent's HEAD commit — no
    # standalone `style:` commit; subject and author are retained.
    log = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "log", "--format=%an <%ae> %s", "-n", "2"],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = log.stdout.strip().splitlines()
    assert lines[0] == "robomp-bot <robomp-bot@example.invalid> feat: follow-up", lines
    assert lines[1] == "robomp-bot <robomp-bot@example.invalid> init", lines
    assert (ws.repo_dir / "src.txt").read_text() == "formatted\n"
    # HEAD's tree contains the formatter output (not just the worktree).
    show = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "show", "HEAD:src.txt"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert show.stdout == "formatted\n"
    # And the branch ended up on the remote at the new head.
    assert result.startswith(f"pushed {ws.branch} ")
    refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert f"refs/heads/{ws.branch}" in refs.stdout.splitlines()


def test_gh_push_branch_force_with_lease_recovers_after_amend(db: Database, tmp_path: Path) -> None:
    """A divergent local history (amended commit) must push successfully.

    Plain `git push` rejects this as non-fast-forward, leaving the agent stuck.
    `--force-with-lease` accepts the rewrite because origin still matches the
    ref we last fetched."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="amend recover",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    # First commit + push — fast-forward path.
    (ws.repo_dir / "feature.txt").write_text("original\n")
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "feature.txt"], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "feat: original",
        ],
        check=True,
        capture_output=True,
        env=env,
    )

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        tool.execute({}, _ctx())

        # Confirm origin received the original commit.
        first_remote = subprocess.run(
            ["git", "-C", str(bare), "rev-parse", f"refs/heads/{ws.branch}"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()

        # Now amend the commit (simulates an agent reset-author rebase, or a
        # code change applied via `git commit --amend`).
        (ws.repo_dir / "feature.txt").write_text("amended\n")
        subprocess.run(["git", "-C", str(ws.repo_dir), "add", "feature.txt"], check=True, capture_output=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(ws.repo_dir),
                "-c",
                "user.email=robomp-bot@example.invalid",
                "-c",
                "user.name=robomp-bot",
                "commit",
                "--amend",
                "--no-edit",
            ],
            check=True,
            capture_output=True,
            env=env,
        )
        new_local = subprocess.run(
            ["git", "-C", str(ws.repo_dir), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        assert new_local != first_remote, "amend must rewrite the SHA"

        # Second push — divergent. Plain `git push` would reject; we expect success.
        result = tool.execute({}, _ctx())
    finally:
        _stop_loop(loop, thread)

    assert result.startswith(f"pushed {ws.branch} ")
    final_remote = subprocess.run(
        ["git", "-C", str(bare), "rev-parse", f"refs/heads/{ws.branch}"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert final_remote == new_local, (final_remote, new_local)


def test_gh_push_branch_aborts_on_failed_bun_check(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failing `bun check` aborts the push and leaves the remote untouched."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="push aborted",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    fake_bun = fakebin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "check" ]; then\n'
        '    printf "TypeError: property missing\\n" >&2\n'
        "    exit 1\n"
        "fi\n"
        "exit 0\n"
    )
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")

    (ws.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"check": "tsc --noEmit"}}) + "\n",
        encoding="utf-8",
    )
    (ws.repo_dir / "feature.txt").write_text("feature\n")
    subprocess.run(
        ["git", "-C", str(ws.repo_dir), "add", "package.json", "feature.txt"], check=True, capture_output=True
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "ok",
        ],
        check=True,
        capture_output=True,
        env=env,
    )

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({}, _ctx())
    finally:
        _stop_loop(loop, thread)

    msg = str(exc.value)
    assert "refusing to push" in msg
    assert "`bun check` failed before push" in msg
    assert "TypeError: property missing" in msg
    # The branch must not have reached the remote.
    refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert not any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout
    # Audit row attributes the failure to gh_push_branch, not gh_open_pr.
    row = db._conn.execute(
        "SELECT tool, error FROM tool_calls WHERE tool='gh_push_branch' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    assert row is not None
    assert "TypeError: property missing" in row["error"]


def test_gh_push_branch_skip_checks_bypasses_failing_bun_check(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`skip_checks=true` bypasses a failing `bun check` and pushes anyway.

    Models the scenario where `main` itself is broken (e.g. an unrelated
    formatter/typecheck failure) and the agent has verified that the
    failure is pre-existing — re-running the gate forever would never
    succeed.
    """
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="skip checks",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    bun_invocations = fakebin / "bun.log"
    fake_bun = fakebin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        f'echo "$@" >> "{bun_invocations}"\n'
        # Both `fix` and `check` would fail — but skip_checks must short-circuit
        # so this script is never invoked for them.
        "exit 1\n"
    )
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")

    (ws.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"fix": "ruff format", "check": "tsc --noEmit"}}) + "\n",
        encoding="utf-8",
    )
    (ws.repo_dir / "feature.txt").write_text("feature\n")
    subprocess.run(
        ["git", "-C", str(ws.repo_dir), "add", "package.json", "feature.txt"], check=True, capture_output=True
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "ok",
        ],
        check=True,
        capture_output=True,
        env=env,
    )

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        result = tool.execute({"skip_checks": True}, _ctx())
    finally:
        _stop_loop(loop, thread)

    assert "pushed" in result
    assert "pre-push checks skipped" in result
    # Bun was never invoked — both `fix` and `check` were short-circuited.
    assert not bun_invocations.exists(), bun_invocations.read_text()
    # The branch DID reach the remote.
    refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout
    # Audit row records the skip.
    rows = db._conn.execute(
        "SELECT tool, result_json FROM tool_calls WHERE tool='gh_push_branch' ORDER BY id"
    ).fetchall()
    skipped = [json.loads(r["result_json"] or "{}") for r in rows]
    assert any(s.get("skipped") == "bun_run_fix" for s in skipped)
    assert any(s.get("skipped") == "bun_check" for s in skipped)


def test_gh_push_branch_skip_checks_still_refuses_dirty_worktree(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`skip_checks=true` MUST still refuse when there are uncommitted changes —
    we never let uncommitted diff leak into a remote ref."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="dirty",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    # package.json declares scripts.fix so the dirty-tree gate inside
    # _run_pre_publish_bun_fix actually runs (the helper short-circuits to
    # a no-op when there is no scripts.fix entry).
    (ws.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"fix": "ruff format"}}) + "\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "package.json"], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "wip",
        ],
        check=True,
        capture_output=True,
        env=env,
    )
    # Now leave an uncommitted edit on disk.
    (ws.repo_dir / "dirty.txt").write_text("uncommitted\n")

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"skip_checks": True}, _ctx())
    finally:
        _stop_loop(loop, thread)

    msg = str(exc.value)
    assert "dirty worktree" in msg
    # Branch did NOT reach the remote.
    refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert not any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout


def test_gh_open_pr_runs_fix_then_check_and_amends_formatter_diff(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """gh_open_pr runs `bun run fix`, amends any diff into HEAD, then runs `bun check`."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="fix runs before check",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    # The fake bun:
    #   `bun run fix` → rewrite src.txt and emit a small marker the test asserts on
    #   `bun check`   → exit 0
    #   anything else → fail
    fix_calls = tmp_path / "fix-calls"
    check_calls = tmp_path / "check-calls"
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    fake_bun = fakebin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "run" ] && [ "$2" = "fix" ]; then\n'
        f"    printf called >> {fix_calls}\n"
        '    printf "formatted\\n" > src.txt\n'
        "    exit 0\n"
        "fi\n"
        'if [ "$1" = "check" ]; then\n'
        f"    printf called >> {check_calls}\n"
        "    exit 0\n"
        "fi\n"
        'printf "unexpected bun call: %s\\n" "$*" >&2\n'
        "exit 2\n"
    )
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")

    (ws.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"fix": "...", "check": "..."}}) + "\n",
        encoding="utf-8",
    )
    (ws.repo_dir / "src.txt").write_text("original\n")
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "package.json", "src.txt"], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "feat: initial change",
        ],
        check=True,
        capture_output=True,
        env=env,
    )

    opened_pr: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        opened_pr["url"] = str(request.url)
        return httpx.Response(
            201,
            json={
                "number": 7,
                "html_url": "https://github.com/octo/widget/pull/7",
                "head": {"ref": ws.branch},
                "base": {"ref": "main"},
                "state": "open",
            },
        )

    github = GitHubClient("tok", transport=httpx.MockTransport(handler))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        body = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nran tests\n\nFixes #42\n"
        result = tool.execute({"title": "fix: x", "body": body}, _ctx())
    finally:
        _stop_loop(loop, thread)

    # Both bun stages ran, and fix preceded check.
    assert fix_calls.read_text() == "called"
    assert check_calls.read_text() == "called"
    # The formatter diff was amended into HEAD — subject and author retained,
    # no standalone "style:" commit, and HEAD's tree holds the formatted file.
    log = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "log", "--format=%an|%ae|%s", "-2"],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = log.stdout.strip().splitlines()
    assert lines[0] == "robomp-bot|robomp-bot@example.invalid|feat: initial change"
    assert lines[1].endswith("|init")
    show = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "show", "HEAD:src.txt"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert show.stdout == "formatted\n"
    # Worktree is clean again (gate before push would have rejected otherwise).
    status = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert status.stdout == ""
    # The PR actually opened.
    assert "opened #7" in result
    assert opened_pr["url"].endswith("/repos/octo/widget/pulls")
    refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert f"refs/heads/{ws.branch}" in refs.stdout.splitlines()


def test_gh_open_pr_skip_checks_bypasses_failing_bun_run_test(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`skip_checks=true` bypasses the suite alongside fix/check.

    Models pre-existing breakage on `main`: every bun stage would fail, yet the
    PR opens and each skipped gate is recorded in the audit trail.
    """
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="skip checks bypasses tests",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    bun_invocations = fakebin / "bun.log"
    fake_bun = fakebin / "bun"
    fake_bun.write_text(f'#!/bin/sh\necho "$@" >> "{bun_invocations}"\nexit 1\n', encoding="utf-8")
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")

    (ws.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"fix": "biome", "check": "tsc --noEmit", "test": "bun test"}}) + "\n",
        encoding="utf-8",
    )
    (ws.repo_dir / "feature.txt").write_text("feature\n")
    subprocess.run(
        ["git", "-C", str(ws.repo_dir), "add", "package.json", "feature.txt"], check=True, capture_output=True
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "fix: something",
        ],
        check=True,
        capture_output=True,
        env=env,
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201,
            json={
                "number": 7,
                "html_url": "https://github.com/octo/widget/pull/7",
                "head": {"ref": ws.branch},
                "base": {"ref": "main"},
                "state": "open",
            },
        )

    github = GitHubClient("tok", transport=httpx.MockTransport(handler))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        body = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\n`bun run test` red on main\n\nFixes #42\n"
        result = tool.execute({"title": "fix: x", "body": body, "skip_checks": True}, _ctx())
    finally:
        _stop_loop(loop, thread)

    assert "opened #7" in result
    # No bun stage ran at all — fix, check and test were all short-circuited.
    assert not bun_invocations.exists(), bun_invocations.read_text()
    rows = db._conn.execute("SELECT result_json FROM tool_calls WHERE tool='gh_open_pr' ORDER BY id").fetchall()
    skipped = [json.loads(r["result_json"] or "{}") for r in rows]
    assert any(s.get("skipped") == "bun_run_fix" for s in skipped)
    assert any(s.get("skipped") == "bun_check" for s in skipped)
    assert any(s.get("skipped") == "bun_run_test" for s in skipped)


def test_gh_open_pr_refuses_dirty_worktree_before_fix(
    db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pre-existing uncommitted edit MUST cause gh_open_pr (and gh_push_branch)
    to refuse BEFORE `bun run fix` runs — otherwise `git add -A` after fix
    would silently amend the unrelated edit into the agent's HEAD commit
    and ship it in the PR."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="dirty before fix",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    # `bun run fix` is a no-op; `bun check` would also pass. The bug being
    # tested is the staging order, not the formatter's behavior.
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    fake_bun = fakebin / "bun"
    fake_bun.write_text("#!/bin/sh\nexit 0\n")
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")

    # Commit a clean package.json + tracked source; then leave an UNRELATED
    # uncommitted edit sitting in the worktree (the kind of thing the agent
    # forgot to commit).
    (ws.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"fix": "...", "check": "..."}}) + "\n",
        encoding="utf-8",
    )
    (ws.repo_dir / "src.txt").write_text("clean\n")
    subprocess.run(
        ["git", "-C", str(ws.repo_dir), "add", "package.json", "src.txt"],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "feat: committed work",
        ],
        check=True,
        capture_output=True,
        env=env,
    )
    head_before = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    # Now plant the stowaway edit that the agent forgot.
    (ws.repo_dir / "src.txt").write_text("STOWAWAY uncommitted edit\n")

    github = GitHubClient("tok", transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        push_tool = next(x for x in build(bindings) if x.name == "gh_push_branch")
        with pytest.raises(RpcCommandError) as exc:
            push_tool.execute({}, _ctx())
        assert "dirty worktree" in str(exc.value).lower()

        pr_tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        body = "## Repro\nr\n\n## Cause\nc\n\n## Fix\nf\n\n## Verification\nv\n\nFixes #42\n"
        with pytest.raises(RpcCommandError) as exc2:
            pr_tool.execute({"title": "fix: x", "body": body}, _ctx())
        assert "dirty worktree" in str(exc2.value).lower()
    finally:
        _stop_loop(loop, thread)

    # HEAD is unchanged: the unrelated edit was NEVER committed.
    head_after = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert head_after == head_before
    # The stowaway edit is still sitting uncommitted in the worktree.
    status = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "status", "--porcelain"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert "src.txt" in status.stdout
    # Origin's farm/* branch was never created — push refused before reaching the network.
    refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert not any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines())


def test_gh_open_pr_skips_fix_when_no_script(db: Database, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No `scripts.fix` entry → fix stage is a no-op even if `scripts.check` exists."""
    import os
    import subprocess

    bare = tmp_path / "upstream.git"
    bare.mkdir()
    subprocess.run(["git", "init", "--bare", "--initial-branch=main", str(bare)], check=True, capture_output=True)
    seed = tmp_path / "seed"
    seed.mkdir()
    env = os.environ | {
        "GIT_AUTHOR_NAME": "robomp-bot",
        "GIT_AUTHOR_EMAIL": "robomp-bot@example.invalid",
        "GIT_COMMITTER_NAME": "robomp-bot",
        "GIT_COMMITTER_EMAIL": "robomp-bot@example.invalid",
    }
    subprocess.run(["git", "init", "--initial-branch=main", str(seed)], check=True, capture_output=True)
    (seed / "README.md").write_text("init\n")
    for cmd in (
        ["git", "-C", str(seed), "add", "."],
        [
            "git",
            "-C",
            str(seed),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "init",
        ],
        ["git", "-C", str(seed), "remote", "add", "origin", str(bare)],
        ["git", "-C", str(seed), "push", "origin", "main"],
    ):
        subprocess.run(cmd, check=True, capture_output=True, env=env)

    from robomp.sandbox import SandboxManager

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="no fix script",
        clone_url=str(bare),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    fix_calls = tmp_path / "fix-calls"
    check_calls = tmp_path / "check-calls"
    fakebin = tmp_path / "fakebin"
    fakebin.mkdir()
    fake_bun = fakebin / "bun"
    fake_bun.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "run" ] && [ "$2" = "fix" ]; then\n'
        f"    printf called >> {fix_calls}\n"
        "    exit 0\n"
        "fi\n"
        'if [ "$1" = "check" ]; then\n'
        f"    printf called >> {check_calls}\n"
        "    exit 0\n"
        "fi\n"
        "exit 2\n"
    )
    fake_bun.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fakebin}{os.pathsep}{os.environ['PATH']}")

    (ws.repo_dir / "package.json").write_text(
        json.dumps({"scripts": {"check": "..."}}) + "\n",
        encoding="utf-8",
    )
    subprocess.run(["git", "-C", str(ws.repo_dir), "add", "package.json"], check=True, capture_output=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(ws.repo_dir),
            "-c",
            "user.email=robomp-bot@example.invalid",
            "-c",
            "user.name=robomp-bot",
            "commit",
            "-m",
            "feat: x",
        ],
        check=True,
        capture_output=True,
        env=env,
    )

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201,
            json={
                "number": 7,
                "html_url": "https://github.com/octo/widget/pull/7",
                "head": {"ref": ws.branch},
                "base": {"ref": "main"},
                "state": "open",
            },
        )

    github = GitHubClient("tok", transport=httpx.MockTransport(handler))
    loop, thread = _make_loop_in_background()
    try:
        bindings = ToolBindings(
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            repo=_stub_repo(),
            issue=IssueInfo(
                repo="octo/widget",
                number=42,
                title="t",
                body="",
                state="open",
                author="alice",
                labels=(),
                is_pull_request=False,
            ),
            workspace=ws,
            loop=loop,
            author_name="robomp-bot",
            author_email="robomp-bot@example.invalid",
        )
        db.upsert_issue(
            key=bindings.issue_key,
            repo="octo/widget",
            number=42,
            state="reproducing",
            branch=ws.branch,
            session_dir=str(ws.session_dir),
        )
        db.set_issue_classification(bindings.issue_key, "bug")
        tool = next(x for x in build(bindings) if x.name == "gh_open_pr")
        body = "## Repro\nrepro\n\n## Cause\ncause\n\n## Fix\nfix\n\n## Verification\nran tests\n\nFixes #42\n"
        result = tool.execute({"title": "fix: x", "body": body}, _ctx())
    finally:
        _stop_loop(loop, thread)

    assert not fix_calls.exists()
    assert check_calls.read_text() == "called"
    assert "opened #7" in result


# -------- gh_post_comment + question auto-close ---------------------------


def _stub_settings(*, enabled: bool = True, hours: float = 4.0):
    """Construct a Settings stub with question_autoclose knobs only.

    `model_construct` skips field validation, which lets us avoid wiring up
    every required env var just to set the autoclose fields a test needs.
    """
    from pydantic import SecretStr

    from robomp.config import Settings

    return Settings.model_construct(
        github_token=None,
        github_webhook_secret=SecretStr("x"),
        bot_login="robomp-bot",
        git_author_email="bot@example.invalid",
        repo_allowlist_raw="octo/widget",
        gh_proxy_url="http://proxy.invalid",
        gh_proxy_hmac_key=SecretStr("k" * 32),
        question_autoclose_enabled=enabled,
        question_autoclose_hours=hours,
        question_autoclose_scan_seconds=60.0,
    )


def _question_handler(captured: dict[str, Any]):
    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            201,
            json={"id": 4242, "user": {"login": "robomp-bot"}, "body": "x", "created_at": "t"},
        )

    return handler


def test_gh_post_comment_appends_suffix_and_schedules_for_question(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}
    transport = httpx.MockTransport(_question_handler(captured))
    bindings, loop, t = _bindings(db, tmp_path, transport)
    db.set_issue_classification(bindings.issue_key, "question")
    bindings = ToolBindings(
        db=bindings.db,
        github=bindings.github,
        git_transport=bindings.git_transport,
        repo=bindings.repo,
        issue=bindings.issue,
        workspace=bindings.workspace,
        loop=bindings.loop,
        author_name=bindings.author_name,
        author_email=bindings.author_email,
        settings=_stub_settings(),
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        tool.execute({"body": "Here's the answer"}, _ctx())
    finally:
        _stop_loop(loop, t)

    body = captured["body"]["body"]
    assert body.startswith("Here's the answer")
    # Suffix appended exactly once.
    assert body.count("react 👎") == 1
    assert "auto-close in 4 hours" in body
    row = db.get_pending_closure(bindings.issue_key)
    assert row is not None
    assert row.state == "pending"
    assert row.comment_id == 4242
    # `_stub_issue()` opens the issue as `alice`.
    assert row.issue_author == "alice"


def test_gh_post_comment_skips_suffix_for_non_question(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}
    transport = httpx.MockTransport(_question_handler(captured))
    bindings, loop, t = _bindings(db, tmp_path, transport)
    db.set_issue_classification(bindings.issue_key, "bug")
    bindings = ToolBindings(
        db=bindings.db,
        github=bindings.github,
        git_transport=bindings.git_transport,
        repo=bindings.repo,
        issue=bindings.issue,
        workspace=bindings.workspace,
        loop=bindings.loop,
        author_name=bindings.author_name,
        author_email=bindings.author_email,
        settings=_stub_settings(),
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        tool.execute({"body": "Here's the diagnosis"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert captured["body"] == {"body": "Here's the diagnosis"}
    assert db.get_pending_closure(bindings.issue_key) is None


def test_gh_post_comment_skips_suffix_when_target_differs_from_origin(db: Database, tmp_path: Path) -> None:
    """Posting to a different `number` (e.g. cross-issue reply) must not schedule."""
    captured: dict[str, Any] = {}
    transport = httpx.MockTransport(_question_handler(captured))
    bindings, loop, t = _bindings(db, tmp_path, transport)
    db.set_issue_classification(bindings.issue_key, "question")
    bindings = ToolBindings(
        db=bindings.db,
        github=bindings.github,
        git_transport=bindings.git_transport,
        repo=bindings.repo,
        issue=bindings.issue,
        workspace=bindings.workspace,
        loop=bindings.loop,
        author_name=bindings.author_name,
        author_email=bindings.author_email,
        settings=_stub_settings(),
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        tool.execute({"body": "see other issue", "number": 99}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert captured["body"] == {"body": "see other issue"}
    assert db.get_pending_closure(bindings.issue_key) is None


def test_gh_post_comment_skips_suffix_when_feature_disabled(db: Database, tmp_path: Path) -> None:
    captured: dict[str, Any] = {}
    transport = httpx.MockTransport(_question_handler(captured))
    bindings, loop, t = _bindings(db, tmp_path, transport)
    db.set_issue_classification(bindings.issue_key, "question")
    bindings = ToolBindings(
        db=bindings.db,
        github=bindings.github,
        git_transport=bindings.git_transport,
        repo=bindings.repo,
        issue=bindings.issue,
        workspace=bindings.workspace,
        loop=bindings.loop,
        author_name=bindings.author_name,
        author_email=bindings.author_email,
        settings=_stub_settings(enabled=False),
    )
    try:
        tool = next(x for x in build(bindings) if x.name == "gh_post_comment")
        tool.execute({"body": "Here's the answer"}, _ctx())
    finally:
        _stop_loop(loop, t)

    assert captured["body"] == {"body": "Here's the answer"}
    assert db.get_pending_closure(bindings.issue_key) is None


class _RecordingReleaseTransport(LocalGitTransport):
    """Local release transport that records publication attempts."""

    __slots__ = ("calls",)

    def __init__(self) -> None:
        super().__init__(token=None)
        self.calls: list[dict[str, Any]] = []

    def push_release(
        self,
        *,
        repo: str,
        workspace_key: str,
        repo_dir: Path,
        branch: str,
        tag: str,
        expected_head: str,
        slot_uid: int | None = None,
    ) -> PushResult:
        self.calls.append(
            {
                "repo": repo,
                "workspace_key": workspace_key,
                "repo_dir": repo_dir,
                "branch": branch,
                "tag": tag,
                "expected_head": expected_head,
                "slot_uid": slot_uid,
            }
        )
        return super().push_release(
            repo=repo,
            workspace_key=workspace_key,
            repo_dir=repo_dir,
            branch=branch,
            tag=tag,
            expected_head=expected_head,
            slot_uid=slot_uid,
        )


def _release_git(*args: str, cwd: Path | None = None) -> str:
    command = ["git"]
    if cwd is not None:
        command.extend(["-C", str(cwd)])
    command.extend(args)
    proc = subprocess.run(command, check=True, capture_output=True, text=True)
    return proc.stdout.strip()


def _release_bindings(
    db: Database,
    tmp_path: Path,
    settings: Settings,
    *,
    subject: str = "chore: bump version to 1.2.3",
    author_name: str = "robomp-bot",
    author_email: str = "robomp-bot@example.invalid",
    dirty: bool = False,
    remote_tag_sha: str | None = None,
    create_fix: bool = True,
) -> tuple[
    ToolBindings,
    asyncio.AbstractEventLoop,
    threading.Thread,
    _RecordingReleaseTransport,
    str,
    Path,
]:
    bare = tmp_path / "release-origin.git"
    seed = tmp_path / "release-seed"
    _release_git("init", "--bare", "--initial-branch=main", str(bare))
    _release_git("init", "--initial-branch=main", str(seed))
    (seed / "README.md").write_text("release\n", encoding="utf-8")
    _release_git("add", "README.md", cwd=seed)
    _release_git(
        "-c",
        "user.name=release-owner",
        "-c",
        "user.email=release-owner@example.invalid",
        "commit",
        "-m",
        "chore: bump version to 1.2.3",
        cwd=seed,
    )
    expected_sha = _release_git("rev-parse", "HEAD", cwd=seed)
    _release_git("remote", "add", "origin", str(bare), cwd=seed)
    _release_git("push", "origin", "main", f"{expected_sha}:refs/tags/v1.2.3", cwd=seed)

    root = tmp_path / "release-workspace"
    root.mkdir()
    repo_dir = root / "repo"
    _release_git("clone", "--branch", "main", str(bare), str(repo_dir))
    _release_git("config", "user.name", "robomp-bot", cwd=repo_dir)
    _release_git("config", "user.email", "robomp-bot@example.invalid", cwd=repo_dir)
    if create_fix:
        (repo_dir / "fix.txt").write_text("fixed\n", encoding="utf-8")
        _release_git("add", "fix.txt", cwd=repo_dir)
        _release_git(
            "-c",
            f"user.name={author_name}",
            "-c",
            f"user.email={author_email}",
            "commit",
            "-m",
            subject,
            cwd=repo_dir,
        )
    if dirty:
        (repo_dir / "fix.txt").write_text("uncommitted\n", encoding="utf-8")

    session_dir = root / ".omp-session-v1.2.3"
    context_dir = root / "context"
    artifacts_dir = root / "artifacts"
    for directory in (session_dir, context_dir, context_dir / "repro", artifacts_dir):
        directory.mkdir(parents=True, exist_ok=True)
    workspace = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=session_dir,
        context_dir=context_dir,
        artifacts_dir=artifacts_dir,
        branch="main",
        repo_full_name="octo/widget",
        issue_number="release",
    )
    key = "octo/widget#v1.2.3"
    db.upsert_release(
        repo="octo/widget",
        tag="v1.2.3",
        version="1.2.3",
        current_sha=expected_sha,
        session_dir=str(session_dir),
    )
    db.bump_release_round(key, failed_sha=expected_sha)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/repos/octo/widget/git/ref/tags/v1.2.3":
            return httpx.Response(
                200,
                json={
                    "object": {
                        "type": "commit",
                        "sha": expected_sha if remote_tag_sha is None else remote_tag_sha,
                    }
                },
            )
        return httpx.Response(500, json={"message": f"unexpected {request.url.path}"})

    loop, thread = _make_loop_in_background()
    transport = _RecordingReleaseTransport()
    release = ReleaseToolContext(
        repo="octo/widget",
        tag="v1.2.3",
        version="1.2.3",
        key=key,
        expected_sha=expected_sha,
        default_branch="main",
    )
    bindings = ToolBindings(
        db=db,
        github=GitHubClient("token", transport=httpx.MockTransport(handler)),
        git_transport=transport,
        repo=RepoInfo(
            full_name="octo/widget",
            default_branch="main",
            clone_url=str(bare),
            private=False,
        ),
        issue=None,
        workspace=workspace,
        loop=loop,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
        settings=settings,
        abort=AbortController(),
        release=release,
    )
    return bindings, loop, thread, transport, expected_sha, bare


def test_release_retag_refuses_dirty_tree(db: Database, tmp_path: Path, settings: Settings) -> None:
    bindings, loop, thread, transport, _, _ = _release_bindings(db, tmp_path, settings, dirty=True)
    try:
        tool = next(item for item in build(bindings) if item.name == "release_retag")
        with pytest.raises(RpcCommandError, match="working tree is dirty"):
            tool.execute({"summary": "fixed release"}, _ctx())
    finally:
        _stop_loop(loop, thread)
    assert transport.calls == []


def test_release_retag_requires_release_subject_prefix(db: Database, tmp_path: Path, settings: Settings) -> None:
    bindings, loop, thread, transport, _, _ = _release_bindings(
        db,
        tmp_path,
        settings,
        subject="fix(ci): repair release",
    )
    try:
        tool = next(item for item in build(bindings) if item.name == "release_retag")
        with pytest.raises(RpcCommandError) as exc:
            tool.execute({"summary": "fixed release"}, _ctx())
    finally:
        _stop_loop(loop, thread)
    assert str(exc.value).startswith("refusing to retag: HEAD subject must start with 'chore: bump version to '")
    assert "#2564" in str(exc.value)
    assert transport.calls == []


def test_release_retag_refuses_wrong_author(db: Database, tmp_path: Path, settings: Settings) -> None:
    bindings, loop, thread, transport, _, _ = _release_bindings(
        db,
        tmp_path,
        settings,
        author_name="wrong",
        author_email="wrong@example.invalid",
    )
    try:
        tool = next(item for item in build(bindings) if item.name == "release_retag")
        with pytest.raises(RpcCommandError, match="commit author identity mismatch"):
            tool.execute({"summary": "fixed release"}, _ctx())
    finally:
        _stop_loop(loop, thread)
    assert transport.calls == []


def test_release_retag_refuses_remote_tag_drift(db: Database, tmp_path: Path, settings: Settings) -> None:
    bindings, loop, thread, transport, _, _ = _release_bindings(
        db,
        tmp_path,
        settings,
        remote_tag_sha="human-retagged-sha",
    )
    try:
        tool = next(item for item in build(bindings) if item.name == "release_retag")
        with pytest.raises(RpcCommandError, match="tag moved remotely"):
            tool.execute({"summary": "fixed release"}, _ctx())
    finally:
        _stop_loop(loop, thread)
    assert transport.calls == []


def test_release_retag_atomically_publishes_and_awaits_ci(db: Database, tmp_path: Path, settings: Settings) -> None:
    bindings, loop, thread, transport, expected_sha, bare = _release_bindings(db, tmp_path, settings)
    new_head = _release_git("rev-parse", "HEAD", cwd=bindings.workspace.repo_dir)
    assert new_head != expected_sha
    try:
        tool = next(item for item in build(bindings) if item.name == "release_retag")
        result = tool.execute({"summary": "fixed the failing check"}, _ctx())
    finally:
        _stop_loop(loop, thread)

    assert result == {"pushed": new_head, "tag": "v1.2.3", "round": 1}
    assert len(transport.calls) == 1
    assert transport.calls[0]["workspace_key"] == "octo__widget__release"
    row = db.get_release("octo/widget#v1.2.3")
    assert row is not None
    assert row.state == "awaiting_ci"
    assert row.current_sha == new_head
    assert _release_git("--git-dir", str(bare), "rev-parse", "refs/heads/main") == new_head
    assert _release_git("--git-dir", str(bare), "rev-parse", "refs/tags/v1.2.3") == new_head


def test_abort_task_marks_release_failed(db: Database, tmp_path: Path, settings: Settings) -> None:
    bindings, loop, thread, _, _, _ = _release_bindings(
        db,
        tmp_path,
        settings,
        create_fix=False,
    )
    try:
        tool = next(item for item in build(bindings) if item.name == "abort_task")
        assert tool.execute({"reason": "runner credentials require human repair"}, _ctx()) == "aborted"
    finally:
        _stop_loop(loop, thread)

    row = db.get_release("octo/widget#v1.2.3")
    assert row is not None
    assert row.state == "failed"
    assert row.last_error == "runner credentials require human repair"
    assert bindings.abort is not None and bindings.abort.triggered


def test_release_status_and_job_log_are_scoped_to_expected_sha(
    db: Database, tmp_path: Path, settings: Settings
) -> None:
    expected_sha = "a" * 40
    seen: list[tuple[str, str]] = []
    log_lines = [f"line-{index}" for index in range(1005)]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.path, request.url.query.decode()))
        if request.url.path == "/repos/octo/widget/actions/runs":
            return httpx.Response(
                200,
                json={
                    "workflow_runs": [
                        {
                            "id": 10,
                            "name": "CI",
                            "event": "push",
                            "status": "completed",
                            "conclusion": "failure",
                            "head_branch": "main",
                            "head_sha": expected_sha,
                            "html_url": "https://example.invalid/runs/10",
                            "run_attempt": 1,
                        }
                    ]
                },
            )
        if request.url.path == "/repos/octo/widget/actions/runs/10/jobs":
            return httpx.Response(
                200,
                json={
                    "jobs": [
                        {
                            "id": 20,
                            "run_id": 10,
                            "name": "check",
                            "status": "completed",
                            "conclusion": "failure",
                            "html_url": "https://example.invalid/jobs/20",
                            "steps": [
                                {"name": "install", "conclusion": "success"},
                                {"name": "bun check", "conclusion": "failure"},
                            ],
                        }
                    ]
                },
            )
        if request.url.path == "/repos/octo/widget/actions/jobs/20/logs":
            return httpx.Response(200, text="\n".join(log_lines))
        return httpx.Response(500, json={"message": f"unexpected {request.url.path}"})

    workspace = _stub_workspace(tmp_path)
    workspace.branch = "main"
    workspace.issue_number = "release"
    key = "octo/widget#v1.2.3"
    db.upsert_release(
        repo="octo/widget",
        tag="v1.2.3",
        version="1.2.3",
        current_sha=expected_sha,
        session_dir=str(workspace.session_dir),
    )
    loop, thread = _make_loop_in_background()
    bindings = ToolBindings(
        db=db,
        github=GitHubClient("token", transport=httpx.MockTransport(handler)),
        git_transport=LocalGitTransport(token=None),
        repo=_stub_repo(),
        issue=None,
        workspace=workspace,
        loop=loop,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
        settings=settings,
        release=ReleaseToolContext(
            repo="octo/widget",
            tag="v1.2.3",
            version="1.2.3",
            key=key,
            expected_sha=expected_sha,
            default_branch="main",
        ),
    )
    try:
        status_tool = next(item for item in build(bindings) if item.name == "release_ci_status")
        log_tool = next(item for item in build(bindings) if item.name == "release_job_log")
        status = json.loads(status_tool.execute({}, _ctx()))
        log_tail = log_tool.execute({"job_id": 20, "tail_lines": 5000}, _ctx())
    finally:
        _stop_loop(loop, thread)

    assert status["sha"] == expected_sha
    assert status["runs"][0]["failed_jobs"][0]["failed_steps"] == ["bun check"]
    assert seen[0] == (
        "/repos/octo/widget/actions/runs",
        f"head_sha={expected_sha}&per_page=100",
    )
    assert log_tail.splitlines() == log_lines[-1000:]
