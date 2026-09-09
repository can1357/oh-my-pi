"""Verify pragmas survive the payload round-trip from server → durable queue → tasks."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from robomp import tasks
from robomp.github_client import IssueInfo, RepoInfo
from robomp.tasks import _attach_thread, _directive_from_payload
from robomp.worker import DirectiveInfo


def test_directive_from_payload_parses_pragmas() -> None:
    directive = _directive_from_payload(
        {
            "_robomp_directive": {
                "body": "do the thing",
                "author": "can1357",
                "pragmas": [["model", "gpt"], ["thinking", "low"]],
            }
        }
    )
    assert directive is not None
    assert directive.body == "do the thing"
    assert directive.author == "can1357"
    assert directive.pragmas == (("model", "gpt"), ("thinking", "low"))
    assert directive.authorizes_impl is False


def test_directive_from_payload_missing_pragmas_is_empty_tuple() -> None:
    directive = _directive_from_payload({"_robomp_directive": {"body": "x", "author": "can1357"}})
    assert directive is not None
    assert directive.pragmas == ()
    assert directive.authorizes_impl is False


def test_directive_from_payload_drops_malformed_pragma_entries() -> None:
    directive = _directive_from_payload(
        {
            "_robomp_directive": {
                "body": "x",
                "author": "can1357",
                "pragmas": [
                    ["model", "gpt"],
                    ["bad"],  # wrong arity
                    [1, "v"],  # non-string key
                    "string-instead-of-pair",
                ],
            }
        }
    )
    assert directive is not None
    assert directive.pragmas == (("model", "gpt"),)


def test_directive_from_payload_parses_implementation_authorization() -> None:
    directive = _directive_from_payload(
        {
            "_robomp_directive": {
                "body": "do the thing",
                "author": "can1357",
                "authorizes_impl": True,
            }
        }
    )
    assert directive is not None
    assert directive.authorizes_impl is True


def test_directive_from_payload_returns_none_for_missing_directive() -> None:
    assert _directive_from_payload({}) is None
    assert _directive_from_payload({"_robomp_directive": "not-a-mapping"}) is None


async def test_attach_thread_preserves_authorizes_impl(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_fetch_thread(*args, **kwargs):
        return ()

    monkeypatch.setattr("robomp.tasks._fetch_thread", fake_fetch_thread)

    directive = DirectiveInfo(
        body="test body",
        author="test_author",
        authorizes_impl=True,
    )
    hydrated = await _attach_thread(None, directive, "owner/repo", 42, is_pr=False)
    assert hydrated is not None
    assert hydrated.body == "test body"
    assert hydrated.author == "test_author"
    assert hydrated.authorizes_impl is True


def _payload_with_directive(*, issue_number: int, body: str = "@robomp-bot ship it") -> dict[str, object]:
    return {
        "repository": {
            "full_name": "octo/widget",
            "default_branch": "main",
            "clone_url": "https://x/octo/widget.git",
            "private": False,
        },
        "issue": {
            "number": issue_number,
            "title": "proposal",
            "body": "issue body",
            "state": "open",
            "user": {"login": "alice"},
            "labels": [{"name": "proposal"}],
        },
        "comment": {
            "id": 99,
            "body": body,
            "created_at": "2026-01-01T00:00:00Z",
            "user": {"login": "owner"},
        },
        "_robomp_directive": {
            "body": body,
            "author": "owner",
            "authorizes_impl": True,
        },
    }


def _workspace(tmp_path):
    repo_dir = tmp_path / "repo"
    session_dir = tmp_path / "session"
    repo_dir.mkdir(exist_ok=True)
    session_dir.mkdir(exist_ok=True)
    return SimpleNamespace(root=tmp_path, repo_dir=repo_dir, session_dir=session_dir, branch="robomp/issue-42")


async def test_handle_comment_preserves_authorizes_impl_to_run_task(
    db, tmp_path, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = _workspace(tmp_path)
    captured: dict[str, object] = {}

    async def fake_attach_thread(
        _github: object,
        directive: DirectiveInfo | None,
        _repo: str,
        _number: int,
        *,
        is_pr: bool,
    ) -> DirectiveInfo | None:
        assert directive is not None
        assert is_pr is False
        captured["attached_authorizes_impl"] = directive.authorizes_impl
        return directive

    async def fake_run_task(
        *,
        task_kind: str,
        inputs: object,
        directive: DirectiveInfo | None = None,
        **_kwargs: object,
    ) -> None:
        del inputs
        captured["task_kind"] = task_kind
        captured["run_task_authorizes_impl"] = directive.authorizes_impl if directive is not None else None

    monkeypatch.setattr(tasks, "_attach_thread", fake_attach_thread)
    monkeypatch.setattr(tasks, "run_task", fake_run_task)

    await tasks.handle_comment(
        settings=settings,
        db=db,
        github=SimpleNamespace(),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=lambda **_kwargs: workspace),
        git_transport=SimpleNamespace(),
        payload=_payload_with_directive(issue_number=42),
        delivery_id="d-comment",
    )

    assert captured == {
        "attached_authorizes_impl": True,
        "task_kind": "triage_issue",
        "run_task_authorizes_impl": True,
    }


async def test_handle_pr_conversation_preserves_authorizes_impl_to_run_task(
    db, tmp_path, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = _workspace(tmp_path)
    db.upsert_issue(
        key="octo/widget#42",
        repo="octo/widget",
        number=42,
        state="opened",
        branch=workspace.branch,
        session_dir=str(workspace.session_dir),
        pr_number=7,
    )
    captured: dict[str, object] = {}

    class FakeGitHub:
        async def get_repo(self, repo: str) -> RepoInfo:
            assert repo == "octo/widget"
            return RepoInfo(full_name=repo, default_branch="main", clone_url="https://x/octo/widget.git", private=False)

        async def get_issue(self, repo: str, number: int) -> IssueInfo:
            assert repo == "octo/widget"
            assert number == 42
            return IssueInfo(
                repo=repo,
                number=number,
                title="proposal",
                body="issue body",
                state="open",
                author="alice",
                labels=("proposal",),
                is_pull_request=False,
            )

    async def fake_attach_thread(
        _github: object,
        directive: DirectiveInfo | None,
        repo: str,
        number: int,
        *,
        is_pr: bool,
    ) -> DirectiveInfo | None:
        assert directive is not None
        assert repo == "octo/widget"
        assert number == 7
        assert is_pr is True
        captured["attached_authorizes_impl"] = directive.authorizes_impl
        return directive

    async def fake_run_task(
        *,
        task_kind: str,
        inputs: object,
        pr_number: int | None = None,
        directive: DirectiveInfo | None = None,
        **_kwargs: object,
    ) -> None:
        del inputs
        captured["task_kind"] = task_kind
        captured["pr_number"] = pr_number
        captured["run_task_authorizes_impl"] = directive.authorizes_impl if directive is not None else None

    monkeypatch.setattr(tasks, "_attach_thread", fake_attach_thread)
    monkeypatch.setattr(tasks, "run_task", fake_run_task)

    payload = _payload_with_directive(issue_number=7)
    issue_payload = payload["issue"]
    assert isinstance(issue_payload, dict)
    issue_payload["pull_request"] = {"url": "https://api.github.com/repos/octo/widget/pulls/7"}
    await tasks.handle_pr_conversation(
        settings=settings,
        db=db,
        github=FakeGitHub(),
        sandbox=SimpleNamespace(natives_cache=None, ensure_workspace=lambda **_kwargs: workspace),
        git_transport=SimpleNamespace(),
        payload=payload,
        delivery_id="d-pr-comment",
    )

    assert captured == {
        "attached_authorizes_impl": True,
        "task_kind": "handle_comment",
        "pr_number": 7,
        "run_task_authorizes_impl": True,
    }
