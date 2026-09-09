"""Gated end-to-end smoke test.

Runs only when ROBOMP_INTEGRATION=1 and `omp` is available on PATH (or via
ROBOMP_OMP_COMMAND). Spins up:

- a local bare git repo with a trivial failing test,
- a fake GitHub API via httpx.MockTransport that records comments + PRs,
- a real `omp --mode rpc` subprocess driven by `worker.run_task`.

Asserts that triage_issue produces:
- at least one issue comment,
- one PR matching the body template,
- a pushed branch on the bare repo,
- an `opened` row in sqlite.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from pathlib import Path
from typing import Any

import httpx
import pytest

INTEGRATION = os.environ.get("ROBOMP_INTEGRATION") == "1"

pytestmark = pytest.mark.skipif(
    not INTEGRATION,
    reason="ROBOMP_INTEGRATION=1 required to run the omp-backed smoke test",
)


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ | {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
    }
    return subprocess.run(["git", *args], cwd=str(cwd), check=check, capture_output=True, text=True, env=env)


def _seed_failing_repo(tmp_path: Path) -> Path:
    bare = tmp_path / "upstream.git"
    bare.mkdir()
    _git(bare.parent, "init", "--initial-branch=main", "--bare", str(bare))
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(seed, "init", "--initial-branch=main")
    (seed / "test.js").write_text(
        "const assert = require('assert');\n"
        "// FIXME: this assertion is wrong; the answer is 4.\n"
        "assert.strictEqual(2 + 2, 5);\n"
    )
    (seed / "README.md").write_text("toy repo\n")
    _git(seed, "add", ".")
    _git(seed, "commit", "-m", "init")
    _git(seed, "remote", "add", "origin", str(bare))
    _git(seed, "push", "origin", "main")
    return bare


def test_triage_end_to_end(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from robomp.config import Settings, reset_settings_cache
    from robomp.db import Database
    from robomp.github_client import GitHubClient
    from robomp.sandbox import LocalGitTransport, SandboxManager
    from robomp.tasks import triage_issue

    bare = _seed_failing_repo(tmp_path)

    monkeypatch.setenv("ROBOMP_GH_PROXY_URL", "http://gh-proxy.invalid:8081")
    monkeypatch.setenv("ROBOMP_GH_PROXY_HMAC_KEY", "test-hmac-key-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    monkeypatch.setenv("GITHUB_TOKEN", "")
    monkeypatch.setenv("GITHUB_WEBHOOK_SECRET", "secret")
    monkeypatch.setenv("ROBOMP_BOT_LOGIN", "robomp-bot")
    monkeypatch.setenv("ROBOMP_REPO_ALLOWLIST", "octo/widget")
    monkeypatch.setenv("ROBOMP_WORKSPACE_ROOT", str(tmp_path / "workspaces"))
    monkeypatch.setenv("ROBOMP_SQLITE_PATH", str(tmp_path / "robomp.sqlite"))
    monkeypatch.setenv("ROBOMP_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("ROBOMP_TASK_TIMEOUT_SECONDS", "300")
    reset_settings_cache()
    cfg = Settings()  # type: ignore[call-arg]
    cfg.ensure_paths()

    # Fake GitHub: capture POSTs, serve repo/issue/comments GETs.
    comments: list[dict[str, Any]] = []
    prs: list[dict[str, Any]] = []
    next_comment_id = [100]

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        method = request.method
        if method == "GET" and path == "/repos/octo/widget":
            return httpx.Response(
                200,
                json={
                    "full_name": "octo/widget",
                    "default_branch": "main",
                    "clone_url": str(bare),
                    "private": False,
                },
            )
        if method == "GET" and path == "/repos/octo/widget/issues/1":
            return httpx.Response(
                200,
                json={
                    "number": 1,
                    "title": "2+2 should be 4",
                    "body": "Running `node test.js` exits non-zero because the assertion claims 2+2 is 5.",
                    "state": "open",
                    "user": {"login": "alice"},
                    "labels": [],
                },
            )
        if method == "GET" and path == "/repos/octo/widget/issues/1/comments":
            return httpx.Response(200, json=comments)
        if method == "POST" and path == "/repos/octo/widget/issues/1/comments":
            body = json.loads(request.content)
            next_comment_id[0] += 1
            comment = {
                "id": next_comment_id[0],
                "user": {"login": "robomp-bot"},
                "body": body["body"],
                "created_at": "now",
            }
            comments.append(comment)
            return httpx.Response(201, json=comment)
        if method == "POST" and path == "/repos/octo/widget/pulls":
            body = json.loads(request.content)
            pr = {
                "number": 7,
                "html_url": "https://example.invalid/octo/widget/pull/7",
                "head": {"ref": body["head"]},
                "base": {"ref": body["base"]},
                "state": "open",
                "title": body["title"],
                "body": body["body"],
            }
            prs.append(pr)
            return httpx.Response(201, json=pr)
        return httpx.Response(404, json={"message": f"unmocked {method} {path}"})

    transport = httpx.MockTransport(handler)

    payload = {
        "action": "opened",
        "issue": {
            "number": 1,
            "title": "2+2 should be 4",
            "body": "Running `node test.js` exits non-zero because the assertion claims 2+2 is 5.",
            "state": "open",
            "user": {"login": "alice"},
            "labels": [],
        },
        "repository": {
            "full_name": "octo/widget",
            "default_branch": "main",
            "clone_url": str(bare),
            "private": False,
        },
    }

    async def _go() -> None:
        db = Database(cfg.sqlite_path)
        github = GitHubClient("ghp_test", transport=transport)
        sandbox = SandboxManager(cfg.workspace_root)
        await triage_issue(
            settings=cfg,
            db=db,
            github=github,
            git_transport=LocalGitTransport(token=None),
            sandbox=sandbox,
            payload=payload,
            delivery_id="smoke-test",
        )
        row = db.get_issue("octo/widget#1")
        assert row is not None, "issue row missing"
        assert row.state in {"opened"}, f"unexpected state {row.state}"
        db.close()

    asyncio.run(_go())

    assert prs, "no PR opened"
    pr = prs[0]
    for section in ("## Repro", "## Cause", "## Fix", "## Verification"):
        assert section in pr["body"], f"PR body missing {section}"
    assert "Fixes #1" in pr["body"]
    # Branch should be pushed to the bare repo.
    refs = subprocess.run(
        ["git", "-C", str(bare), "for-each-ref", "--format=%(refname)"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert any(r.startswith("refs/heads/farm/") for r in refs.stdout.splitlines()), refs.stdout
    assert comments, "expected at least one comment"
