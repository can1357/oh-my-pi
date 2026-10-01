from __future__ import annotations

import os
import subprocess
from pathlib import Path

import httpx
import pytest

from robomp import tasks
from robomp.config import Settings
from robomp.db import Database
from robomp.github_client import GitHubClient
from robomp.sandbox import SandboxManager

_REPO = "octo/widget"
_TAG = "v17.2.8"
_VERSION = "17.2.8"


def _git(cwd: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env=os.environ
        | {
            "GIT_AUTHOR_NAME": "release-test",
            "GIT_AUTHOR_EMAIL": "release-test@example.invalid",
            "GIT_COMMITTER_NAME": "release-test",
            "GIT_COMMITTER_EMAIL": "release-test@example.invalid",
        },
    )
    return proc.stdout.strip()


def _release_repo(tmp_path: Path) -> tuple[Path, str]:
    origin = tmp_path / "origin.git"
    seed = tmp_path / "seed"
    _git(tmp_path, "init", "--bare", "--initial-branch=main", str(origin))
    _git(tmp_path, "init", "--initial-branch=main", str(seed))
    (seed / "README.md").write_text("release\n", encoding="utf-8")
    _git(seed, "add", "README.md")
    _git(seed, "commit", "-m", f"chore: bump version to {_VERSION}")
    _git(seed, "remote", "add", "origin", str(origin))
    _git(seed, "push", "--set-upstream", "origin", "main")
    return origin, _git(seed, "rev-parse", "HEAD")


def _run(
    run_id: int,
    *,
    conclusion: str | None,
    status: str = "completed",
    name: str = "CI",
    head_sha: str,
) -> dict[str, object]:
    return {
        "id": run_id,
        "name": name,
        "event": "push",
        "status": status,
        "conclusion": conclusion,
        "head_branch": "main",
        "head_sha": head_sha,
        "html_url": f"https://example/runs/{run_id}",
        "run_attempt": 1,
    }


def _payload(head_sha: str, clone_url: Path, *, conclusion: str) -> dict[str, object]:
    return {
        "action": "completed",
        "repository": {
            "full_name": _REPO,
            "default_branch": "main",
            "clone_url": str(clone_url),
            "private": False,
        },
        "workflow_run": {
            "id": 1,
            "name": "CI",
            "head_branch": "main",
            "head_sha": head_sha,
            "html_url": "https://example/runs/1",
            "conclusion": conclusion,
            "head_commit": {"message": f"chore: bump version to {_VERSION}"},
        },
    }


def _github(
    *,
    head_sha: str,
    runs: list[dict[str, object]] | None = None,
    tag_sha: str | None = None,
    release_exists: bool = True,
) -> GitHubClient:
    resolved_tag_sha = head_sha if tag_sha is None else tag_sha

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith(f"/git/ref/tags/{_TAG}"):
            return httpx.Response(200, json={"object": {"type": "commit", "sha": resolved_tag_sha}})
        if path.endswith("/actions/runs"):
            return httpx.Response(200, json={"workflow_runs": runs or []})
        if path.endswith("/jobs"):
            return httpx.Response(200, json={"jobs": []})
        if path.endswith("/logs"):
            return httpx.Response(200, text="failure")
        if path.endswith(f"/releases/tags/{_TAG}"):
            if not release_exists:
                return httpx.Response(404, json={"message": "Not Found"})
            return httpx.Response(
                200,
                json={
                    "tag_name": _TAG,
                    "name": _VERSION,
                    "draft": False,
                    "prerelease": False,
                    "html_url": "https://example/release",
                    "assets": [],
                },
            )
        raise AssertionError(f"unexpected GitHub request: {request.url}")

    return GitHubClient("token", transport=httpx.MockTransport(handler))


async def _handle(
    *,
    settings: Settings,
    db: Database,
    sandbox: SandboxManager,
    github: GitHubClient,
    payload: dict[str, object],
) -> None:
    await tasks.handle_release_ci(
        settings=settings,
        db=db,
        github=github,
        sandbox=sandbox,
        git_transport=sandbox.transport,
        payload=payload,
        delivery_id="delivery-1",
    )


@pytest.mark.asyncio
async def test_stale_release_event_does_not_create_round(
    settings: Settings,
    db: Database,
    tmp_path: Path,
) -> None:
    origin, head = _release_repo(tmp_path)
    sandbox = SandboxManager(settings.workspace_root)
    await _handle(
        settings=settings,
        db=db,
        sandbox=sandbox,
        github=_github(head_sha=head, tag_sha="new-tag-sha"),
        payload=_payload(head, origin, conclusion="failure"),
    )
    assert db.get_release(f"{_REPO}#{_TAG}") is None


@pytest.mark.asyncio
async def test_success_marks_release_green_when_all_runs_and_release_exist(
    settings: Settings,
    db: Database,
    tmp_path: Path,
) -> None:
    origin, head = _release_repo(tmp_path)
    sandbox = SandboxManager(settings.workspace_root)
    runs = [_run(1, conclusion="success", head_sha=head)]
    await _handle(
        settings=settings,
        db=db,
        sandbox=sandbox,
        github=_github(head_sha=head, runs=runs),
        payload=_payload(head, origin, conclusion="success"),
    )
    row = db.get_release(f"{_REPO}#{_TAG}")
    assert row is not None and row.state == "green"


@pytest.mark.asyncio
async def test_success_waits_for_an_in_progress_run(
    settings: Settings,
    db: Database,
    tmp_path: Path,
) -> None:
    origin, head = _release_repo(tmp_path)
    sandbox = SandboxManager(settings.workspace_root)
    runs = [
        _run(1, conclusion="success", head_sha=head),
        _run(2, conclusion=None, status="in_progress", name="Nix", head_sha=head),
    ]
    await _handle(
        settings=settings,
        db=db,
        sandbox=sandbox,
        github=_github(head_sha=head, runs=runs),
        payload=_payload(head, origin, conclusion="success"),
    )
    row = db.get_release(f"{_REPO}#{_TAG}")
    assert row is not None and row.state == "awaiting_ci"


@pytest.mark.asyncio
async def test_green_ci_without_release_marks_failed(
    settings: Settings,
    db: Database,
    tmp_path: Path,
) -> None:
    origin, head = _release_repo(tmp_path)
    sandbox = SandboxManager(settings.workspace_root)
    runs = [_run(1, conclusion="success", head_sha=head)]
    await _handle(
        settings=settings,
        db=db,
        sandbox=sandbox,
        github=_github(head_sha=head, runs=runs, release_exists=False),
        payload=_payload(head, origin, conclusion="success"),
    )
    row = db.get_release(f"{_REPO}#{_TAG}")
    assert row is not None
    assert row.state == "failed"
    assert row.last_error == "CI green but GitHub Release missing/draft"


@pytest.mark.asyncio
async def test_cancelled_nix_run_does_not_block_green(
    settings: Settings,
    db: Database,
    tmp_path: Path,
) -> None:
    origin, head = _release_repo(tmp_path)
    sandbox = SandboxManager(settings.workspace_root)
    runs = [
        _run(1, conclusion="success", head_sha=head),
        _run(2, conclusion="cancelled", name="Nix", head_sha=head),
    ]
    await _handle(
        settings=settings,
        db=db,
        sandbox=sandbox,
        github=_github(head_sha=head, runs=runs),
        payload=_payload(head, origin, conclusion="success"),
    )
    row = db.get_release(f"{_REPO}#{_TAG}")
    assert row is not None and row.state == "green"


@pytest.mark.asyncio
async def test_failure_bumps_round_and_runs_agent(
    settings: Settings,
    db: Database,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    origin, head = _release_repo(tmp_path)
    sandbox = SandboxManager(settings.workspace_root)
    calls: list[int] = []

    async def fake_run_task(*, task_kind: str, inputs) -> None:
        assert task_kind == "handle_release_ci"
        assert inputs.release is not None
        calls.append(inputs.release.round)
        inputs.db.set_release_state(f"{_REPO}#{_TAG}", "awaiting_ci")

    monkeypatch.setattr(tasks, "run_task", fake_run_task)
    runs = [_run(1, conclusion="failure", head_sha=head)]
    await _handle(
        settings=settings,
        db=db,
        sandbox=sandbox,
        github=_github(head_sha=head, runs=runs),
        payload=_payload(head, origin, conclusion="failure"),
    )
    row = db.get_release(f"{_REPO}#{_TAG}")
    assert calls == [1]
    assert row is not None and row.rounds == 1 and row.state == "awaiting_ci"


@pytest.mark.asyncio
async def test_failure_at_round_cap_marks_failed_without_agent(
    settings: Settings,
    db: Database,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    origin, head = _release_repo(tmp_path)
    sandbox = SandboxManager(settings.workspace_root)
    key = f"{_REPO}#{_TAG}"
    db.upsert_release(
        repo=_REPO,
        tag=_TAG,
        version=_VERSION,
        current_sha=head,
        session_dir="/session",
    )
    for round_number in range(settings.release_max_rounds):
        db.bump_release_round(key, failed_sha=f"older-{round_number}")

    called = False

    async def fake_run_task(**_kwargs) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(tasks, "run_task", fake_run_task)
    await _handle(
        settings=settings,
        db=db,
        sandbox=sandbox,
        github=_github(head_sha=head),
        payload=_payload(head, origin, conclusion="failure"),
    )
    row = db.get_release(key)
    assert called is False
    assert row is not None and row.state == "failed"
    assert row.last_error is not None and row.last_error.startswith(f"round cap {settings.release_max_rounds} reached")


@pytest.mark.asyncio
async def test_fixing_same_sha_resumes_without_round_bump(
    settings: Settings,
    db: Database,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    origin, head = _release_repo(tmp_path)
    sandbox = SandboxManager(settings.workspace_root)
    key = f"{_REPO}#{_TAG}"
    db.upsert_release(
        repo=_REPO,
        tag=_TAG,
        version=_VERSION,
        current_sha=head,
        session_dir="/session",
    )
    db.bump_release_round(key, failed_sha=head)
    calls: list[int] = []

    async def fake_run_task(*, inputs, **_kwargs) -> None:
        assert inputs.release is not None
        calls.append(inputs.release.round)
        inputs.db.set_release_state(key, "awaiting_ci")

    monkeypatch.setattr(tasks, "run_task", fake_run_task)
    runs = [_run(1, conclusion="failure", head_sha=head)]
    await _handle(
        settings=settings,
        db=db,
        sandbox=sandbox,
        github=_github(head_sha=head, runs=runs),
        payload=_payload(head, origin, conclusion="failure"),
    )
    row = db.get_release(key)
    assert calls == [1]
    assert row is not None and row.rounds == 1
