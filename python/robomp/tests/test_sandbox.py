from __future__ import annotations

import os
import platform
import signal
import stat
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from robomp.git_ops import (
    GitCommandError,
)
from robomp.git_ops import (
    fetch_pr_head as git_fetch_pr_head,
)
from robomp.git_ops import (
    fetch_prune as git_fetch_prune,
)
from robomp.git_ops import (
    fetch_ref as git_fetch_ref,
)
from robomp.sandbox import (
    _DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT,
    SandboxManager,
    Workspace,
    _chown_workspace,
    _prepare_slot_runtime_env,
    _prepare_slot_tmpdir,
    _provision_runtime_dirs,
    _reap_slot,
    _safe_directory_env,
    _share_git_metadata_with_slots,
    _slot_pids,
    _slot_subprocess_kwargs,
    make_branch,
    rename_workspace_branch,
    workspace_key,
)


def _git(args: list[str], cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def _workspace(root: Path) -> Workspace:
    return Workspace(
        root=root,
        repo_dir=root / "repo",
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch="farm/test/topic",
        repo_full_name="octo/widget",
        issue_number=1,
    )


@pytest.fixture
def upstream_repo(tmp_path: Path) -> Path:
    """Create a local --bare-ish remote with one commit on main."""
    repo = tmp_path / "upstream.git"
    repo.mkdir()
    _git(["init", "--initial-branch=main", "--bare", str(repo)], cwd=tmp_path)
    seed = tmp_path / "seed"
    seed.mkdir()
    _git(["init", "--initial-branch=main", str(seed)], cwd=tmp_path)
    (seed / "README.md").write_text("hello\n", encoding="utf-8")
    _git(["-C", str(seed), "add", "."], cwd=tmp_path)
    env = os.environ | {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
    }
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=str(seed),
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    _git(["-C", str(seed), "remote", "add", "origin", str(repo)], cwd=tmp_path)
    _git(["-C", str(seed), "push", "origin", "main"], cwd=tmp_path)
    return repo


def test_workspace_key_and_branch_shape() -> None:
    assert workspace_key("oven-sh/bun", 30654) == "oven-sh__bun__30654"
    assert workspace_key("oven-sh/bun", "release") == "oven-sh__bun__release"
    branch = make_branch(issue_number=30654, title="JSON.parse crashes on BOM", seed="oven-sh/bun#30654")
    assert branch.startswith("farm/")
    parts = branch.split("/")
    assert len(parts) == 3 and len(parts[1]) == 8
    assert "json-parse-crashes" in parts[2]


def _init_worktree_repo(repo_dir: Path, branch: str) -> None:
    """Stand up a minimal local git repo with `branch` checked out."""
    repo_dir.mkdir(parents=True, exist_ok=True)
    _git(["init", f"--initial-branch={branch}", str(repo_dir)], cwd=repo_dir.parent)
    (repo_dir / "README.md").write_text("hello\n", encoding="utf-8")
    _git(["-C", str(repo_dir), "add", "."], cwd=repo_dir.parent)
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=str(repo_dir),
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


def test_rename_workspace_branch_renames_local_branch(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    initial = "farm/abc12345/some-issue"
    _init_worktree_repo(repo_dir, initial)
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    new_branch = rename_workspace_branch(ws, "fix-json-bom")
    assert new_branch == "farm/abc12345/fix-json-bom"
    assert ws.branch == "farm/abc12345/fix-json-bom"
    head = subprocess.run(
        ["git", "symbolic-ref", "HEAD"],
        cwd=str(repo_dir),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head == "refs/heads/farm/abc12345/fix-json-bom"


def test_rename_workspace_branch_refreshes_shared_metadata(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    initial = "farm/abc12345/some-issue"
    _init_worktree_repo(repo_dir, initial)
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    # On Linux+root the rename runs `git branch -m` as the slot uid (2004),
    # so the worktree needs to be readable by that uid before the call.
    # On macOS dev `_slot_permissions_active` returns False and this
    # whole block is a no-op.
    if platform.system() == "Linux" and os.geteuid() == 0:
        for path in [root, repo_dir, *repo_dir.rglob("*")]:
            os.chown(path, 2004, 2004, follow_symlinks=False)
    calls: list[tuple[Path, int | None]] = []
    monkeypatch.setattr(
        "robomp.sandbox._share_git_metadata_with_slots",
        lambda repo_dir, slot_uid: calls.append((repo_dir, slot_uid)),
    )

    rename_workspace_branch(ws, "fix-json-bom", slot_uid=2004)

    assert calls == [(repo_dir, 2004)]


def test_rename_workspace_branch_runs_git_as_slot_when_permissions_active(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    repo_dir.mkdir(parents=True)
    initial = "farm/abc12345/some-issue"
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    captured: dict[str, object] = {}

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.subprocess.run", fake_run)
    monkeypatch.setattr("robomp.sandbox._share_git_metadata_with_slots", lambda _repo_dir, _slot_uid: None)

    new_branch = rename_workspace_branch(ws, "fix-json-bom", slot_uid=2004)

    assert new_branch == "farm/abc12345/fix-json-bom"
    assert captured["cmd"] == ["git", "branch", "-m", initial, "farm/abc12345/fix-json-bom"]
    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs["cwd"] == str(repo_dir)
    assert kwargs["user"] == 2004
    assert kwargs["group"] == 2004
    assert kwargs["extra_groups"] == [2000]


def test_rename_workspace_branch_is_idempotent_when_slug_unchanged(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    initial = "farm/abc12345/keep-me"
    _init_worktree_repo(repo_dir, initial)
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    # No git operation should run; nothing to rename. We assert that by
    # passing a non-existent repo_dir — the helper must not touch git.
    ws.repo_dir = tmp_path / "does-not-exist"
    out = rename_workspace_branch(ws, "keep-me")
    assert out == initial
    assert ws.branch == initial


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "Has-Caps",
        "-leading",
        "trailing-",
        "double--hyphen",
        "has/slash",
        "has_underscore",
        "a" * 51,
        None,
        123,
    ],
)
def test_rename_workspace_branch_rejects_bad_slug(tmp_path: Path, bad: object) -> None:
    ws = _workspace(tmp_path / "ws")
    with pytest.raises(ValueError):
        rename_workspace_branch(ws, bad)  # type: ignore[arg-type]


def test_rename_workspace_branch_noop_when_pr_open(tmp_path: Path) -> None:
    """A non-None ``pr_number`` makes rename a no-op: an open PR on origin
    still tracks the current branch, and renaming would orphan it."""
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    initial = "farm/abc12345/old-slug"
    _init_worktree_repo(repo_dir, initial)
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    out = rename_workspace_branch(ws, "new-slug", pr_number=42)
    assert out == initial
    assert ws.branch == initial
    head = subprocess.run(
        ["git", "symbolic-ref", "HEAD"],
        cwd=str(repo_dir),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head == f"refs/heads/{initial}"
    # An invalid slug must still be rejected even when pr_number suppresses the rename.
    with pytest.raises(ValueError):
        rename_workspace_branch(ws, "Bad Slug", pr_number=42)


def test_rename_workspace_branch_rejects_non_farm_branch(tmp_path: Path) -> None:
    ws = _workspace(tmp_path / "ws")
    ws.branch = "main"
    with pytest.raises(ValueError):
        rename_workspace_branch(ws, "ok-slug")


def test_rename_workspace_branch_surfaces_git_failure(tmp_path: Path) -> None:
    root = tmp_path / "ws"
    repo_dir = root / "repo"
    initial = "farm/abc12345/old"
    _init_worktree_repo(repo_dir, initial)
    # Create a second branch that collides with the rename target.
    _git(["-C", str(repo_dir), "branch", "farm/abc12345/new"], cwd=repo_dir.parent)
    ws = Workspace(
        root=root,
        repo_dir=repo_dir,
        session_dir=root / ".omp-session",
        context_dir=root / "context",
        artifacts_dir=root / "artifacts",
        branch=initial,
        repo_full_name="octo/widget",
        issue_number=1,
    )
    with pytest.raises(GitCommandError):
        rename_workspace_branch(ws, "new")
    # Original branch must remain on failure.
    assert ws.branch == initial


def test_delete_bad_refs_removes_worktree_holding_the_ref(tmp_path: Path) -> None:
    """When a bad-object ref is still checked out by a worktree, the worktree's
    stale ``HEAD`` keeps fetch failing even after ``update-ref -d`` succeeds.
    The repair MUST also tear down that worktree before deleting the ref."""
    from robomp.git_ops import _delete_bad_refs

    pool = tmp_path / "pool"
    _init_worktree_repo(pool, "main")

    # Create a worktree on `farm/badhex/bad-branch`.
    work_dir = tmp_path / "worktree"
    subprocess.run(
        ["git", "worktree", "add", "-b", "farm/badhex/bad-branch", str(work_dir), "main"],
        cwd=str(pool),
        check=True,
        capture_output=True,
        text=True,
    )
    assert (work_dir / ".git").exists()

    fetch_output = (
        "error: object directory /tmp/git-objects-aux does not exist; check .git/objects/info/alternates\n"
        "fatal: bad object refs/heads/farm/badhex/bad-branch\n"
        "error: did not send all necessary objects\n"
    )
    changed = _delete_bad_refs(pool, fetch_output)
    assert changed is True
    # Ref must be gone from the pool's refs store.
    rp = subprocess.run(
        ["git", "rev-parse", "--verify", "refs/heads/farm/badhex/bad-branch"],
        cwd=str(pool),
        capture_output=True,
        text=True,
    )
    assert rp.returncode != 0
    # And the worktree's `.git` link must be cleared so the next fetch can
    # validate connectivity without re-tripping over the dead HEAD.
    assert not (work_dir / ".git").exists()


def test_delete_bad_refs_noop_when_no_bad_ref_in_output(tmp_path: Path) -> None:
    from robomp.git_ops import _delete_bad_refs

    pool = tmp_path / "pool"
    _init_worktree_repo(pool, "main")
    # Output that doesn't match the bad-object regex.
    assert _delete_bad_refs(pool, "fatal: unrelated failure\n") is False


def test_ensure_workspace_creates_worktree(tmp_path: Path, upstream_repo: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=42,
        title="something is wrong",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert ws.repo_dir.is_dir()
    assert (ws.repo_dir / "README.md").read_text() == "hello\n"
    # Branch is checked out.
    result = subprocess.run(
        ["git", "-C", str(ws.repo_dir), "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == ws.branch
    assert ws.branch.startswith("farm/")
    # Session and context dirs exist.
    assert ws.session_dir.is_dir()
    assert ws.context_dir.is_dir()
    assert ws.repro_dir.is_dir()
    assert ws.artifacts_dir.is_dir()


def test_release_workspace_resets_to_remote_main_and_uses_tag_session(
    tmp_path: Path,
    upstream_repo: Path,
) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    workspace = mgr.ensure_release_workspace(
        repo="octo/widget",
        clone_url=str(upstream_repo),
        default_branch="main",
        tag="v1.2.3",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert workspace.branch == "main"
    assert workspace.issue_number == "release"
    assert workspace.workspace_key == "octo__widget__release"
    assert workspace.session_dir.name == ".omp-session-v1.2.3"

    (workspace.repo_dir / "local.txt").write_text("discard me\n", encoding="utf-8")
    _git(["-C", str(workspace.repo_dir), "add", "local.txt"], cwd=tmp_path)
    _git(["-C", str(workspace.repo_dir), "commit", "-m", "local crash residue"], cwd=tmp_path)
    (workspace.repo_dir / "untracked.txt").write_text("discard me too\n", encoding="utf-8")

    seed = tmp_path / "seed"
    (seed / "remote.txt").write_text("new remote state\n", encoding="utf-8")
    _git(["-C", str(seed), "add", "remote.txt"], cwd=tmp_path)
    subprocess.run(
        ["git", "commit", "-m", "advance remote"],
        cwd=str(seed),
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
    _git(["-C", str(seed), "push", "origin", "main"], cwd=tmp_path)
    remote_head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(seed),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()

    resumed = mgr.ensure_release_workspace(
        repo="octo/widget",
        clone_url=str(upstream_repo),
        default_branch="main",
        tag="v1.2.3",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(resumed.repo_dir),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert head == remote_head
    assert not (resumed.repo_dir / "local.txt").exists()
    assert not (resumed.repo_dir / "untracked.txt").exists()
    assert (resumed.repo_dir / "remote.txt").read_text(encoding="utf-8") == "new remote state\n"

    next_release = mgr.ensure_release_workspace(
        repo="octo/widget",
        clone_url=str(upstream_repo),
        default_branch="main",
        tag="v1.2.4",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert next_release.repo_dir == resumed.repo_dir
    assert next_release.session_dir.name == ".omp-session-v1.2.4"


def test_ensure_workspace_pr_head_uses_detached_pr_ref(tmp_path: Path, upstream_repo: Path) -> None:
    contributor = tmp_path / "contributor"
    _git(["clone", str(upstream_repo), str(contributor)], cwd=tmp_path)
    (contributor / "README.md").write_text("hello from pr\n", encoding="utf-8")
    _git(["-C", str(contributor), "add", "README.md"], cwd=tmp_path)
    subprocess.run(
        ["git", "commit", "-m", "pr change"],
        cwd=str(contributor),
        check=True,
        capture_output=True,
        text=True,
        env=os.environ
        | {
            "GIT_AUTHOR_NAME": "c",
            "GIT_AUTHOR_EMAIL": "c@t",
            "GIT_COMMITTER_NAME": "c",
            "GIT_COMMITTER_EMAIL": "c@t",
        },
    )
    pr_head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(contributor),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    _git(["-C", str(contributor), "push", "origin", "HEAD:refs/pull/9/head"], cwd=tmp_path)

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=9,
        title="incoming PR",
        clone_url=str(upstream_repo),
        default_branch="main",
        pr_head=9,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(ws.repo_dir),
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    symbolic = subprocess.run(
        ["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
        cwd=str(ws.repo_dir),
        capture_output=True,
        text=True,
        check=False,
    )
    pushurl = subprocess.run(
        ["git", "config", "--get", "remote.origin.pushurl"],
        cwd=str(ws.repo_dir),
        capture_output=True,
        text=True,
        check=False,
    )
    assert head == pr_head
    assert symbolic.returncode != 0
    assert ws.branch == "review/pr-9"
    assert pushurl.returncode != 0


def test_chown_workspace_noops_when_not_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], bool]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 1000)
    monkeypatch.setattr(
        "robomp.sandbox.subprocess.run",
        lambda cmd, *, check: calls.append((cmd, check)),
    )

    _chown_workspace(tmp_path, 2001)

    assert calls == []


def test_chown_workspace_noops_off_linux(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], bool]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Darwin")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr(
        "robomp.sandbox.subprocess.run",
        lambda cmd, *, check: calls.append((cmd, check)),
    )

    _chown_workspace(tmp_path, 2001)

    assert calls == []


def test_chown_workspace_runs_chown_and_chmod_as_root_on_linux(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[list[str], bool]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)

    def fake_run(cmd, *, check, timeout):
        assert timeout == _DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT
        calls.append((cmd, check))

    monkeypatch.setattr("robomp.sandbox.subprocess.run", fake_run)

    _chown_workspace(tmp_path, 2001)

    # 2001 is the slot-private GID matching the slot UID, not the shared omp group.
    assert calls == [
        (["chown", "-R", "2001:2001", str(tmp_path)], True),
        (["chmod", "-R", "u=rwX,g=rwX,o=", str(tmp_path)], True),
    ]


def test_chown_workspace_makes_workspace_slot_owned(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    subdir = tmp_path / "subdir"
    subdir.mkdir()
    file_path = subdir / "file.txt"
    file_path.write_text("data\n", encoding="utf-8")
    tmp_path.chmod(0o777)
    subdir.chmod(0o777)
    file_path.chmod(0o777)
    owned: dict[Path, tuple[int, int]] = {}

    def fake_run(cmd: list[str], *, check: bool, timeout: float) -> None:
        assert check
        assert timeout == _DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT
        if cmd[:2] == ["chown", "-R"]:
            uid_text, gid_text = cmd[2].split(":", 1)
            root = Path(cmd[3])
            uid = int(uid_text)
            gid = int(gid_text)
            owned[root] = (uid, gid)
            for current_root, dirs, files in os.walk(root):
                current = Path(current_root)
                owned[current] = (uid, gid)
                for dirname in dirs:
                    owned[current / dirname] = (uid, gid)
                for filename in files:
                    owned[current / filename] = (uid, gid)
        elif cmd[:3] == ["chmod", "-R", "u=rwX,g=rwX,o="]:
            root = Path(cmd[3])
            root.chmod(0o770)
            for current_root, dirs, files in os.walk(root):
                current = Path(current_root)
                current.chmod(0o770)
                for dirname in dirs:
                    (current / dirname).chmod(0o770)
                for filename in files:
                    (current / filename).chmod(0o660)
        else:
            raise AssertionError(f"unexpected command: {cmd!r}")

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.subprocess.run", fake_run)

    _chown_workspace(tmp_path, 2001)

    assert owned[tmp_path] == (2001, 2001)
    assert owned[subdir] == (2001, 2001)
    assert owned[file_path] == (2001, 2001)
    assert stat.S_IMODE(tmp_path.stat().st_mode) == 0o770
    assert stat.S_IMODE(subdir.stat().st_mode) == 0o770
    assert stat.S_IMODE(file_path.stat().st_mode) == 0o660


def test_slot_pids_reads_proc_status_and_skips_zombies(tmp_path: Path) -> None:
    nonnumeric = tmp_path / "self"
    nonnumeric.mkdir()

    live = tmp_path / "123"
    live.mkdir()
    (live / "status").write_text(
        "Name:\tomp\nState:\tS (sleeping)\nUid:\t0\t2001\t2001\t2001\n",
        encoding="utf-8",
    )

    zombie = tmp_path / "124"
    zombie.mkdir()
    (zombie / "status").write_text(
        "Name:\tomp\nState:\tZ (zombie)\nUid:\t2001\t2001\t2001\t2001\n",
        encoding="utf-8",
    )

    other = tmp_path / "125"
    other.mkdir()
    (other / "status").write_text(
        "Name:\troot\nState:\tS (sleeping)\nUid:\t0\t0\t0\t0\n",
        encoding="utf-8",
    )

    assert _slot_pids(2001, tmp_path) == (123,)


def test_reap_slot_noops_when_permissions_inactive(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, int]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Darwin")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.kill", lambda pid, sig: calls.append((pid, sig)))

    _reap_slot(2001)

    assert calls == []


def test_reap_slot_kills_slot_uid_on_linux_root(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[int, int]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox._slot_pids", lambda _uid: (111, 222))
    monkeypatch.setattr("robomp.sandbox.os.kill", lambda pid, sig: calls.append((pid, sig)))

    _reap_slot(2001)

    assert calls == [(111, signal.SIGKILL), (222, signal.SIGKILL)]


def test_prepare_slot_tmpdir_mkdirs_without_chown(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    chowns: list[tuple[Path, int, int]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.chown", lambda path, uid, gid: chowns.append((Path(path), uid, gid)))

    tmpdir = _prepare_slot_tmpdir(_workspace(tmp_path), 2001)

    assert tmpdir == tmp_path / ".omp-tmp"
    assert tmpdir.is_dir()
    assert stat.S_IMODE(tmpdir.stat().st_mode) == 0o700
    assert chowns == []


def test_prepare_slot_tmpdir_replaces_symlink_without_touching_target(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    tmpdir = tmp_path / ".omp-tmp"
    tmpdir.symlink_to(target, target_is_directory=True)

    prepared = _prepare_slot_tmpdir(_workspace(tmp_path), None)

    assert prepared == tmpdir
    assert prepared.is_dir()
    assert not prepared.is_symlink()
    assert target.is_dir()


def test_provision_runtime_dirs_replaces_tmpdir_symlink_and_creates_xdg_tree(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    tmpdir = tmp_path / ".omp-tmp"
    tmpdir.symlink_to(target, target_is_directory=True)

    _provision_runtime_dirs(tmp_path)

    assert tmpdir.is_dir()
    assert not tmpdir.is_symlink()
    assert target.is_dir()
    assert stat.S_IMODE(tmpdir.stat().st_mode) == 0o700
    for base in (tmp_path / ".omp-xdg" / "data", tmp_path / ".omp-xdg" / "state", tmp_path / ".omp-xdg" / "cache"):
        assert base.is_dir()
        assert (base / "omp").is_dir()
    assert (tmp_path / ".omp-xdg" / "cache" / "bun-install").is_dir()


def test_safe_directory_env_scopes_single_repo_path(tmp_path: Path) -> None:
    repo_dir = tmp_path / "repo"

    assert _safe_directory_env(repo_dir) == {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "safe.directory",
        "GIT_CONFIG_VALUE_0": str(repo_dir),
    }


def test_slot_subprocess_kwargs_run_as_slot_on_linux_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)

    assert _slot_subprocess_kwargs(2001) == {
        "user": 2001,
        "group": 2001,
        "extra_groups": [2000],
        "umask": 0o002,
    }


def test_chown_workspace_normalizes_to_root_when_slots_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[list[str], bool | None]] = []

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((cmd, kwargs.get("check") if isinstance(kwargs.get("check"), bool) else None))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.getegid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.subprocess.run", fake_run)

    _chown_workspace(tmp_path, None)

    assert calls == [
        (["chown", "-R", "0:0", str(tmp_path)], True),
        (["chmod", "-R", "u=rwX,g=rwX,o=", str(tmp_path)], True),
    ]


def test_prepare_slot_runtime_env_returns_workspace_private_paths_without_chown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chowns: list[tuple[Path, int, int]] = []
    calls: list[list[str]] = []

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.chown", lambda path, uid, gid: chowns.append((Path(path), uid, gid)))
    monkeypatch.setattr("robomp.sandbox.subprocess.run", lambda cmd, **_kwargs: calls.append(cmd))

    ws = _workspace(tmp_path)
    bun_cache = ws.root / ".omp-xdg" / "cache" / "bun-install"

    env = _prepare_slot_runtime_env(ws, 2001)

    assert env["TMPDIR"] == str(ws.root / ".omp-tmp")
    assert env["XDG_CACHE_HOME"] == str(ws.root / ".omp-xdg" / "cache")
    assert env["BUN_INSTALL_CACHE_DIR"] == str(bun_cache)
    for base in (ws.root / ".omp-xdg" / "data", ws.root / ".omp-xdg" / "state", ws.root / ".omp-xdg" / "cache"):
        assert base.is_dir()
        assert (base / "omp").is_dir()
    assert bun_cache.is_dir()
    assert chowns == []
    assert calls == []


def test_share_git_metadata_keeps_pool_writable_for_retry_slot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo_dir = tmp_path / "workspaces" / "octo__widget__43" / "repo"
    repo_dir.mkdir(parents=True)
    common_dir = tmp_path / "workspaces" / "_pool" / "octo__widget" / ".git"
    git_dir = common_dir / "worktrees" / "repo"
    git_dir.mkdir(parents=True)
    (repo_dir / ".git").write_text(f"gitdir: {git_dir}\n", encoding="utf-8")
    (git_dir / "commondir").write_text("../..\n", encoding="utf-8")

    object_dir = common_dir / "objects" / "ab"
    object_dir.mkdir(parents=True)
    object_file = object_dir / "object"
    object_file.write_text("object\n", encoding="utf-8")
    object_file.chmod(0o600)

    ref_dir = common_dir / "refs" / "heads"
    ref_dir.mkdir(parents=True)
    ref_file = ref_dir / "farm"
    ref_file.write_text("sha\n", encoding="utf-8")
    ref_file.chmod(0o600)

    log_dir = common_dir / "logs" / "refs" / "heads"
    log_dir.mkdir(parents=True)
    log_file = log_dir / "farm"
    log_file.write_text("sha sha bot <bot@example.invalid> commit\n", encoding="utf-8")
    log_file.chmod(0o600)

    index_file = git_dir / "index"
    index_file.write_text("index\n", encoding="utf-8")
    index_file.chmod(0o600)

    chowns: list[tuple[Path, int, int]] = []
    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.os.chown", lambda path, uid, gid: chowns.append((Path(path), uid, gid)))

    _share_git_metadata_with_slots(repo_dir, 2002)

    assert object_dir.stat().st_mode & stat.S_IWGRP
    assert object_dir.stat().st_mode & stat.S_ISGID
    assert object_file.stat().st_mode & stat.S_IRGRP
    assert not object_file.stat().st_mode & stat.S_IWGRP
    assert ref_file.stat().st_mode & stat.S_IWGRP
    assert log_file.stat().st_mode & stat.S_IWGRP
    assert index_file.stat().st_mode & stat.S_IWGRP
    assert (git_dir, -1, 2000) in chowns


def test_ensure_workspace_refreshes_permissions_for_retry_slot_and_session(
    tmp_path: Path, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    chowns: list[tuple[Path, int | None]] = []
    shared: list[tuple[Path, int | None]] = []
    real_chown = _chown_workspace
    real_share = _share_git_metadata_with_slots

    def record_chown(root: Path, slot_uid: int | None) -> None:
        chowns.append((root, slot_uid))
        # Delegate so subsequent slot-identity git ops can stat the tree.
        real_chown(root, slot_uid)

    def record_share(repo_dir: Path, slot_uid: int | None) -> None:
        shared.append((repo_dir, slot_uid))
        real_share(repo_dir, slot_uid)

    monkeypatch.setattr("robomp.sandbox._chown_workspace", record_chown)
    monkeypatch.setattr("robomp.sandbox._share_git_metadata_with_slots", record_share)

    mgr = SandboxManager(tmp_path / "workspaces")
    ws1 = mgr.ensure_workspace(
        repo="octo/widget",
        number=44,
        title="retry me",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=2001,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    transcript = ws1.session_dir / "turn.jsonl"
    transcript.write_text("{}\n", encoding="utf-8")
    ws2 = mgr.ensure_workspace(
        repo="octo/widget",
        number=44,
        title="retry me",
        clone_url=str(upstream_repo),
        default_branch="main",
        existing_branch=ws1.branch,
        slot_uid=2002,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    assert ws2.repo_dir == ws1.repo_dir
    assert ws2.session_dir == ws1.session_dir
    assert transcript.is_file()
    assert ws2.branch == ws1.branch
    assert shared == [
        (ws1.repo_dir, 2001),
        (ws1.repo_dir, 2001),
        (ws1.repo_dir, 2002),
        (ws1.repo_dir, 2002),
    ]
    assert chowns == [(ws1.root, 2001), (ws1.root, 2002)]


def test_ensure_workspace_preserves_checked_out_branch_on_replay(tmp_path: Path, upstream_repo: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws1 = mgr.ensure_workspace(
        repo="octo/widget",
        number=45,
        title="retry me",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=None,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    renamed = "farm/abc12345/renamed"
    _git(["-C", str(ws1.repo_dir), "branch", "-m", ws1.branch, renamed], cwd=ws1.repo_dir.parent)

    ws2 = mgr.ensure_workspace(
        repo="octo/widget",
        number=45,
        title="retry me",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=None,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    assert ws2.branch == renamed


def test_ensure_workspace_runs_existing_worktree_git_as_slot_after_chown(
    tmp_path: Path, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws1 = mgr.ensure_workspace(
        repo="octo/widget",
        number=47,
        title="retry me",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=None,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    events: list[tuple[str, int | None]] = []
    git_calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        git_calls.append((cmd, kwargs))
        if cmd[:3] == ["git", "remote", "get-url"]:
            return subprocess.CompletedProcess(cmd, 0, f"{upstream_repo}\n", "")
        if cmd[:4] == ["git", "symbolic-ref", "--quiet", "--short"]:
            user = kwargs.get("user")
            events.append(("symbolic-ref", user if isinstance(user, int) else None))
            return subprocess.CompletedProcess(cmd, 0, f"{ws1.branch}\n", "")
        if cmd[:2] == ["git", "config"]:
            user = kwargs.get("user")
            events.append(("config", user if isinstance(user, int) else None))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def record_chown(_ws_root: Path, slot_uid: int | None) -> None:
        events.append(("chown", slot_uid))

    monkeypatch.setattr("robomp.sandbox.platform.system", lambda: "Linux")
    monkeypatch.setattr("robomp.sandbox.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.sandbox.subprocess.run", fake_run)
    monkeypatch.setattr("robomp.sandbox._chown_workspace", record_chown)
    monkeypatch.setattr("robomp.sandbox._share_git_metadata_with_slots", lambda _repo_dir, _slot_uid: None)

    ws2 = mgr.ensure_workspace(
        repo="octo/widget",
        number=47,
        title="retry me",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=2002,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    assert ws2.branch == ws1.branch
    assert events[0] == ("chown", 2002)
    assert ("symbolic-ref", 2002) in events
    assert events.index(("chown", 2002)) < events.index(("symbolic-ref", 2002))
    assert events.count(("config", 2002)) == 2
    worktree_git = [kwargs for cmd, kwargs in git_calls if cmd[:2] in (["git", "symbolic-ref"], ["git", "config"])]
    assert worktree_git
    assert all(kwargs["user"] == 2002 and kwargs["group"] == 2002 for kwargs in worktree_git)


def test_ensure_workspace_invokes_slot_chown(
    tmp_path: Path, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[Path, int | None]] = []
    real_chown = _chown_workspace

    def record_chown(ws_root: Path, slot_uid: int | None) -> None:
        calls.append((ws_root, slot_uid))
        # Delegate to the real chown so the subsequent `git config` as the
        # slot can stat the tree. On macOS dev (uid != 0) the real chown is
        # itself a no-op; on Linux+root in CI it hands the tree to the slot.
        real_chown(ws_root, slot_uid)

    monkeypatch.setattr("robomp.sandbox._chown_workspace", record_chown)
    mgr = SandboxManager(tmp_path / "workspaces")

    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=43,
        title="something is wrong",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=2001,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    assert calls == [(ws.root, 2001)]


def test_ensure_workspace_provisions_and_slot_owns_runtime_dirs(
    tmp_path: Path, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    owned: dict[Path, tuple[int, int]] = {}
    runtime_paths: list[Path] = []
    real_chown = _chown_workspace

    def record_chown(ws_root: Path, slot_uid: int | None) -> None:
        assert slot_uid is not None
        paths = [
            ws_root / ".omp-tmp",
            ws_root / ".omp-xdg" / "data",
            ws_root / ".omp-xdg" / "data" / "omp",
            ws_root / ".omp-xdg" / "state",
            ws_root / ".omp-xdg" / "state" / "omp",
            ws_root / ".omp-xdg" / "cache",
            ws_root / ".omp-xdg" / "cache" / "omp",
            ws_root / ".omp-xdg" / "cache" / "bun-install",
        ]
        runtime_paths.extend(paths)
        for path in paths:
            assert path.is_dir()
            owned[path] = (slot_uid, slot_uid)
        # Same rationale as test_ensure_workspace_invokes_slot_chown: hand
        # the tree to the slot so the subsequent `git config` works under
        # real slot permissions in CI.
        real_chown(ws_root, slot_uid)

    monkeypatch.setattr("robomp.sandbox._chown_workspace", record_chown)
    mgr = SandboxManager(tmp_path / "workspaces")

    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=46,
        title="runtime perms",
        clone_url=str(upstream_repo),
        default_branch="main",
        slot_uid=2001,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    assert runtime_paths
    assert set(runtime_paths) == {
        ws.root / ".omp-tmp",
        ws.root / ".omp-xdg" / "data",
        ws.root / ".omp-xdg" / "data" / "omp",
        ws.root / ".omp-xdg" / "state",
        ws.root / ".omp-xdg" / "state" / "omp",
        ws.root / ".omp-xdg" / "cache",
        ws.root / ".omp-xdg" / "cache" / "omp",
        ws.root / ".omp-xdg" / "cache" / "bun-install",
    }
    assert set(owned.values()) == {(2001, 2001)}


def test_ensure_workspace_is_idempotent(tmp_path: Path, upstream_repo: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws1 = mgr.ensure_workspace(
        repo="octo/widget",
        number=5,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    ws2 = mgr.ensure_workspace(
        repo="octo/widget",
        number=5,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert ws1.repo_dir == ws2.repo_dir
    assert ws1.branch == ws2.branch


def test_ensure_workspace_existing_branch_starts_from_remote_head(tmp_path: Path, upstream_repo: Path) -> None:
    branch = "farm/abc12345/existing-pr"
    seed = tmp_path / "remote-branch-seed"
    _git(["clone", str(upstream_repo), str(seed)], cwd=tmp_path)
    _git(["-C", str(seed), "checkout", "-b", branch], cwd=tmp_path)
    (seed / "README.md").write_text("from pr branch\n", encoding="utf-8")
    _git(["-C", str(seed), "add", "README.md"], cwd=tmp_path)
    subprocess.run(
        ["git", "commit", "-m", "pr branch"],
        cwd=str(seed),
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
    _git(["-C", str(seed), "push", "origin", branch], cwd=tmp_path)

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=77,
        title="follow up",
        clone_url=str(upstream_repo),
        default_branch="main",
        existing_branch=branch,
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )

    assert ws.branch == branch
    assert (ws.repo_dir / "README.md").read_text(encoding="utf-8") == "from pr branch\n"


def test_remove_workspace(tmp_path: Path, upstream_repo: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=12,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert ws.repo_dir.exists()
    mgr.remove_workspace(repo="octo/widget", number=12)
    assert not ws.repo_dir.exists()
    assert not ws.root.exists()


def test_remove_workspace_prunes_pool_after_failed_worktree_remove(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mgr = SandboxManager(tmp_path)
    # Create a real repo_dir on disk so `repo_dir.exists()` is True on entry.
    ws_root = mgr.workspace_root("o/r", 7)
    repo_dir = ws_root / "repo"
    repo_dir.mkdir(parents=True, exist_ok=True)
    pool = mgr.pool_path("o/r")
    pool.mkdir(parents=True, exist_ok=True)
    (pool / ".git").mkdir(exist_ok=True)  # mark as a real git pool for the cleanup gate

    calls: list[tuple[list[str], object]] = []

    def fake_safe_run(cmd, **k):
        calls.append((list(cmd), k.get("cwd")))
        # The `worktree remove` "times out" (124) and does NOT delete repo_dir,
        # so the code must fall back to rmtree + prune. `prune` succeeds (0).
        if cmd[:3] == ["git", "worktree", "remove"]:
            return subprocess.CompletedProcess(cmd, 124, "", "timed out")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    mgr.remove_workspace(repo="o/r", number=7)

    cmds = [c for c, _ in calls]
    # The dangling registration must have been pruned, in the correct pool.
    assert ["git", "worktree", "prune"] in cmds, (
        "remove_workspace did not prune pool metadata after a failed worktree remove"
    )
    prune_idx = next(i for i, (c, _) in enumerate(calls) if c == ["git", "worktree", "prune"])
    assert calls[prune_idx][1] == pool, "prune did not run in the repo's pool dir"
    # And the remove was attempted first (ordering: remove before prune).
    remove_idx = next(i for i, (c, _) in enumerate(calls) if c[:3] == ["git", "worktree", "remove"])
    assert remove_idx < prune_idx
    # The real checkout dir was cleaned up.
    assert not repo_dir.exists()


def test_remove_workspace_prunes_when_failed_remove_already_deleted_checkout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The reviewer's case: `git worktree remove` deletes the checkout dir but is
    # killed (124) before clearing the pool's worktree registration. `repo_dir`
    # is gone by the time we check, so a guard on `repo_dir.exists()` would skip
    # the prune and leave dangling metadata; guarding on the return code must not.
    mgr = SandboxManager(tmp_path)
    ws_root = mgr.workspace_root("o/r", 9)
    repo_dir = ws_root / "repo"
    repo_dir.mkdir(parents=True, exist_ok=True)
    pool = mgr.pool_path("o/r")
    pool.mkdir(parents=True, exist_ok=True)
    (pool / ".git").mkdir(exist_ok=True)  # mark as a real git pool for the cleanup gate

    calls: list[tuple[list[str], object]] = []

    def fake_safe_run(cmd, **k):
        calls.append((list(cmd), k.get("cwd")))
        if cmd[:3] == ["git", "worktree", "remove"]:
            # Simulate git deleting the checkout, then dying before it could
            # unregister the worktree from the pool.
            repo_dir.rmdir()
            return subprocess.CompletedProcess(cmd, 124, "", "timed out")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    mgr.remove_workspace(repo="o/r", number=9)

    cmds = [c for c, _ in calls]
    assert ["git", "worktree", "prune"] in cmds, (
        "prune was skipped after a failed remove that had already deleted the checkout"
    )
    prune_idx = next(i for i, (c, _) in enumerate(calls) if c == ["git", "worktree", "prune"])
    assert calls[prune_idx][1] == pool, "prune did not run in the repo's pool dir"


def test_redact_credentials_strips_userinfo() -> None:
    from robomp.sandbox import redact_credentials

    assert (
        redact_credentials("Cloning into 'x' from https://bot:ghp_secret@github.com/o/r.git failed")
        == "Cloning into 'x' from https://***@github.com/o/r.git failed"
    )
    # Multiple URLs in one string.
    assert (
        redact_credentials("a https://x:y@example.com b https://q:z@example.org c")
        == "a https://***@example.com b https://***@example.org c"
    )
    # No-op on strings without credentials.
    assert redact_credentials("plain message") == "plain message"
    assert redact_credentials(None) == ""


def test_git_command_error_redacts_url_in_args_and_stderr(tmp_path: Path) -> None:
    """An ENOENT-style git failure on a credentialed clone URL must not echo the token."""
    import pytest as _pytest

    from robomp.sandbox import _run

    cred_url = "https://bot:ghp_abc123secret@example.invalid/o/r.git"
    with _pytest.raises(Exception) as exc:
        _run(["git", "clone", cred_url, str(tmp_path / "out")])
    text = str(exc.value)
    assert "ghp_abc123secret" not in text
    assert "bot" not in text or "https://bot:" not in text
    assert "***" in text or "example.invalid" in text


def test_ensure_workspace_rewrites_credentialed_origin(tmp_path: Path, upstream_repo: Path) -> None:
    """A pool clone created by an older deploy with `https://user:pass@…` in
    `.git/config` must have its `origin` URL rewritten to the credential-free
    URL before the next fetch — credentials NEVER persist on disk."""
    mgr = SandboxManager(tmp_path / "workspaces")
    # Pre-seed the pool by hand, simulating an older deploy: clone, then
    # rewrite `origin` to a credentialed URL pointing at the same local bare.
    pool = mgr.pool_path("octo/widget")
    pool.parent.mkdir(parents=True, exist_ok=True)
    _git(["clone", "--filter=blob:none", str(upstream_repo), str(pool)], cwd=tmp_path)
    credentialed = "https://bot:ghp_seekrit@example.invalid/octo/widget.git"
    _git(["-C", str(pool), "remote", "set-url", "origin", credentialed], cwd=tmp_path)
    config = (pool / ".git" / "config").read_text()
    assert "ghp_seekrit" in config  # sanity: precondition

    # Now resolve through ensure_workspace using the clean URL we now own.
    # The fetch step itself will fail against the bogus example.invalid host,
    # so route through a clean local URL by setting it as the canonical
    # clone_url; the remote MUST be rewritten BEFORE fetch.
    mgr.ensure_workspace(
        repo="octo/widget",
        number=7,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    config_after = (pool / ".git" / "config").read_text()
    assert "ghp_seekrit" not in config_after, config_after
    assert "bot:" not in config_after, config_after
    # Origin now points at the clean URL.
    url = subprocess.run(
        ["git", "-C", str(pool), "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert url == str(upstream_repo)


def test_push_force_with_lease_succeeds_after_local_amend(tmp_path: Path, upstream_repo: Path) -> None:
    """An agent amending an already-pushed commit (e.g. `--reset-author`) must
    still be able to push: `--force-with-lease` allows the local rewrite as
    long as origin still matches what we last fetched."""
    from robomp.git_ops import push as git_push

    # Clone, make a commit, push, then amend and push again.
    work = tmp_path / "work"
    _git(["clone", str(upstream_repo), str(work)], cwd=tmp_path)
    _git(["-C", str(work), "config", "user.email", "t@t"], cwd=tmp_path)
    _git(["-C", str(work), "config", "user.name", "t"], cwd=tmp_path)
    _git(["-C", str(work), "checkout", "-b", "farm/abc/topic"], cwd=tmp_path)
    (work / "x.txt").write_text("a\n")
    _git(["-C", str(work), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(work), "commit", "-m", "initial"], cwd=tmp_path)
    git_push(work, branch="farm/abc/topic", expected_head=None, token=None)

    # Amend (rewrites the SHA at origin/farm/abc/topic).
    (work / "x.txt").write_text("a-amended\n")
    _git(["-C", str(work), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(work), "commit", "--amend", "--no-edit"], cwd=tmp_path)
    amended = subprocess.run(
        ["git", "-C", str(work), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    result = git_push(work, branch="farm/abc/topic", expected_head=None, token=None)
    assert result.head == amended

    # Origin's branch ref now matches the amended SHA.
    on_origin = subprocess.run(
        ["git", "-C", str(upstream_repo), "rev-parse", "refs/heads/farm/abc/topic"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert on_origin == amended


def test_push_force_with_lease_refuses_when_origin_moved(tmp_path: Path, upstream_repo: Path) -> None:
    """If origin's branch ref has been moved by some other writer between our
    last fetch and this push, the lease MUST refuse — even though we're
    force-pushing."""
    from robomp.git_ops import GitCommandError
    from robomp.git_ops import push as git_push

    work = tmp_path / "work"
    _git(["clone", str(upstream_repo), str(work)], cwd=tmp_path)
    _git(["-C", str(work), "config", "user.email", "t@t"], cwd=tmp_path)
    _git(["-C", str(work), "config", "user.name", "t"], cwd=tmp_path)
    _git(["-C", str(work), "checkout", "-b", "farm/abc/topic"], cwd=tmp_path)
    (work / "x.txt").write_text("a\n")
    _git(["-C", str(work), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(work), "commit", "-m", "initial"], cwd=tmp_path)
    git_push(work, branch="farm/abc/topic", expected_head=None, token=None)

    # A "sneaky" second writer publishes a different SHA to the same ref on
    # origin — pushed from an independent worktree, NOT seen by `work`'s
    # remote-tracking ref.
    intruder = tmp_path / "intruder"
    _git(["clone", str(upstream_repo), str(intruder)], cwd=tmp_path)
    _git(["-C", str(intruder), "config", "user.email", "i@i"], cwd=tmp_path)
    _git(["-C", str(intruder), "config", "user.name", "i"], cwd=tmp_path)
    _git(["-C", str(intruder), "checkout", "-b", "farm/abc/topic", "origin/farm/abc/topic"], cwd=tmp_path)
    (intruder / "x.txt").write_text("from-intruder\n")
    _git(["-C", str(intruder), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(intruder), "commit", "--amend", "--no-edit"], cwd=tmp_path)
    _git(["-C", str(intruder), "push", "--force", "origin", "farm/abc/topic"], cwd=tmp_path)

    # Now `work` tries to push another amended commit. The lease pins the
    # expected origin SHA to whatever `work`'s remote-tracking ref still
    # records — which is now stale — so origin's actual SHA differs and the
    # push must be refused.
    (work / "x.txt").write_text("from-us\n")
    _git(["-C", str(work), "add", "x.txt"], cwd=tmp_path)
    _git(["-C", str(work), "commit", "--amend", "--no-edit"], cwd=tmp_path)
    with pytest.raises(GitCommandError) as exc:
        git_push(work, branch="farm/abc/topic", expected_head=None, token=None)
    assert (
        "stale info" in (exc.value.stderr + exc.value.stdout).lower()
        or "rejected" in (exc.value.stderr + exc.value.stdout).lower()
    )


def test_run_git_injects_safe_directory_and_subprocess_identity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from robomp.git_ops import _run_git

    captured: dict[str, object] = {}

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["cmd"] = cmd
        captured.update(kwargs)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.git_ops.subprocess.run", fake_run)

    _run_git(
        ["status"],
        cwd=tmp_path,
        token=None,
        safe_directory=Path("/x"),
        user=2001,
        group=2001,
        extra_groups=[2000],
        umask=0o002,
    )

    env = captured["env"]
    assert isinstance(env, dict)
    assert env["GIT_CONFIG_COUNT"] == "1"
    assert env["GIT_CONFIG_KEY_0"] == "safe.directory"
    assert env["GIT_CONFIG_VALUE_0"] == "/x"
    cmd = captured["cmd"]
    assert isinstance(cmd, list)
    assert "protocol.ext.allow=never" in cmd
    assert captured["user"] == 2001
    assert captured["group"] == 2001
    assert captured["extra_groups"] == [2000]
    assert captured["umask"] == 0o002


def test_run_git_scopes_token_and_scrubs_parent_auth_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from robomp.git_ops import AUTH_ENV_VAR, _run_git

    captured: dict[str, object] = {}

    def fake_run(cmd: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["cmd"] = cmd
        captured.update(kwargs)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setenv("GITHUB_TOKEN", "parent-token")
    monkeypatch.setenv(AUTH_ENV_VAR, "parent-auth")
    monkeypatch.setattr("robomp.git_ops.subprocess.run", fake_run)
    auth_url = "https://github.com/octo/widget.git"

    _run_git(["ls-remote", auth_url], cwd=tmp_path, token="scoped-token", auth_url=auth_url)

    env = captured["env"]
    cmd = captured["cmd"]
    assert isinstance(env, dict)
    assert isinstance(cmd, list)
    assert env[AUTH_ENV_VAR].startswith("Authorization: Basic ")
    assert env[AUTH_ENV_VAR] != "parent-auth"
    assert "GITHUB_TOKEN" not in env
    assert env["GIT_ALLOW_PROTOCOL"] == "https"
    assert env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert "--config-env" in cmd
    assert f"http.{auth_url}.extraHeader={AUTH_ENV_VAR}" in cmd
    assert "protocol.allow=never" in cmd
    assert "protocol.https.allow=always" in cmd
    assert "protocol.ext.allow=never" in cmd
    assert "core.hooksPath=/dev/null" in cmd
    assert "http.proxy=" in cmd
    assert "http.sslVerify=true" in cmd
    assert f"http.{auth_url}.proxy=" in cmd
    assert f"http.{auth_url}.sslVerify=true" in cmd
    assert f"http.{auth_url}.extraHeader=" in cmd


def test_run_git_kills_hung_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A `git` invocation that hangs past the timeout must be killed and
    raised as `GitCommandError(124)` rather than pinning the calling
    thread. The proxy already bounds the async caller via
    `asyncio.wait_for`, but the OS process only goes away because of this
    timeout."""
    from robomp.git_ops import GitCommandError, _run_git

    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    fake_git = fakebin / "git"
    # Use `exec /bin/sleep 30` so the kill from `subprocess.run`'s timeout
    # actually terminates the wait — `sh` with a non-exec `sleep` would
    # keep the parent alive on SIGTERM, and the absolute path means the
    # shim doesn't depend on PATH (we point PATH at fakebin so `git`
    # itself resolves to our shim).
    fake_git.write_text("#!/bin/sh\nexec /bin/sleep 30\n")
    fake_git.chmod(0o755)
    monkeypatch.setenv("PATH", str(fakebin))

    with pytest.raises(GitCommandError) as exc:
        _run_git(["status"], cwd=tmp_path, token=None, timeout=0.5)
    assert exc.value.returncode == 124
    assert "timed out" in exc.value.stderr.lower()


# ---------------------------------------------------------------------------
# Partial-clone blob backfill (oh-my-pi#1818)
# ---------------------------------------------------------------------------


def _partial_clone_upstream(tmp_path: Path) -> Path:
    """Bare upstream that advertises ``uploadpack.allowFilter`` so partial
    clones over ``file://`` actually skip blobs (local-protocol clones
    otherwise ignore ``--filter``)."""
    repo = tmp_path / "partial-upstream.git"
    repo.mkdir()
    _git(["init", "--initial-branch=main", "--bare", str(repo)], cwd=tmp_path)
    _git(["-C", str(repo), "config", "uploadpack.allowFilter", "true"], cwd=tmp_path)
    _git(["-C", str(repo), "config", "uploadpack.allowAnySHA1InWant", "true"], cwd=tmp_path)
    seed = tmp_path / "partial-seed"
    seed.mkdir()
    _git(["init", "--initial-branch=main", str(seed)], cwd=tmp_path)
    (seed / "README.md").write_text("hello\n", encoding="utf-8")
    _git(["-C", str(seed), "add", "."], cwd=tmp_path)
    subprocess.run(
        ["git", "-C", str(seed), "commit", "-m", "init"],
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
    _git(["-C", str(seed), "remote", "add", "origin", str(repo)], cwd=tmp_path)
    _git(["-C", str(seed), "push", "origin", "main"], cwd=tmp_path)
    return repo


def _commit_new_blob_upstream(upstream: Path, tmp_path: Path, *, path: str, content: str, ref: str = "main") -> str:
    """Add a fresh blob upstream and return the new commit SHA."""
    contrib = tmp_path / f"contrib-{path.replace('/', '_')}"
    _git(["clone", f"file://{upstream}", str(contrib)], cwd=tmp_path)
    (contrib / path).write_text(content, encoding="utf-8")
    _git(["-C", str(contrib), "add", path], cwd=tmp_path)
    subprocess.run(
        ["git", "-C", str(contrib), "commit", "-m", f"add {path}"],
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
    sha = subprocess.run(
        ["git", "-C", str(contrib), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    _git(["-C", str(contrib), "push", "origin", f"HEAD:{ref}"], cwd=tmp_path)
    return sha


def _missing_object_oids(repo: Path, rev: str) -> list[str]:
    """OIDs of promisor-deferred objects reachable from ``rev``."""
    proc = subprocess.run(
        ["git", "-C", str(repo), "rev-list", "--objects", "--missing=print", rev],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line[1:].split()[0] for line in proc.stdout.splitlines() if line.startswith("?")]


def test_fetch_ref_backfills_missing_blobs_into_partial_clone(tmp_path: Path) -> None:
    """Regression for oh-my-pi#1818: ``fetch_ref`` is called immediately before
    ``git worktree add origin/<ref>``. On a ``--filter=blob:none`` pool whose
    periodic ``fetch --prune`` inherited that filter, the ref's blobs are
    absent and the worktree-add triggers a promisor lazy fetch that — under
    proxy transport — has no PAT and dies. ``fetch_ref`` MUST materialize
    every reachable blob so the checkout never hits the lazy path."""
    upstream = _partial_clone_upstream(tmp_path)
    pool = tmp_path / "pool"
    _git(
        [
            "clone",
            "--filter=blob:none",
            "--no-tags",
            "--branch",
            "main",
            f"file://{upstream}",
            str(pool),
        ],
        cwd=tmp_path,
    )

    # New upstream commit → fresh blob not yet pulled into the pool.
    _commit_new_blob_upstream(upstream, tmp_path, path="payload.txt", content="v2 contents here\n")

    # Pool refresh mirrors `SandboxManager.ensure_clone` → inherits filter.
    git_fetch_prune(pool, token=None)
    missing_before = _missing_object_oids(pool, "origin/main")
    assert missing_before, (
        "test precondition broken: partial-clone fetch should leave at least one blob promisor-deferred"
    )

    # Pool config must show the partial-clone state we're recovering from.
    cfg_before = (pool / ".git" / "config").read_text(encoding="utf-8")
    assert "partialclonefilter = blob:none" in cfg_before
    assert "promisor = true" in cfg_before

    # The fix: fetch_ref backfills every reachable blob in a single call.
    git_fetch_ref(pool, "main", token=None)

    missing_after = _missing_object_oids(pool, "origin/main")
    assert missing_after == [], f"fetch_ref left missing objects: {missing_after}"

    # And the partial-clone config is intact — `fetch_prune` stays cheap on
    # the next pool refresh; only the explicit pre-checkout fetch eagerly
    # fills blobs.
    cfg_after = (pool / ".git" / "config").read_text(encoding="utf-8")
    assert "partialclonefilter = blob:none" in cfg_after
    assert "promisor = true" in cfg_after

    # End-to-end: worktree add must succeed even if origin is unreachable —
    # the blobs are local now, no lazy fetch can fire.
    _git(["-C", str(pool), "remote", "set-url", "origin", "https://example.invalid/missing.git"], cwd=tmp_path)
    ws_dir = tmp_path / "ws"
    subprocess.run(
        ["git", "-C", str(pool), "worktree", "add", "-b", "verify-1818", str(ws_dir), "origin/main"],
        check=True,
        capture_output=True,
        text=True,
        env=os.environ | {"GIT_TERMINAL_PROMPT": "0"},
    )
    assert (ws_dir / "payload.txt").read_text(encoding="utf-8") == "v2 contents here\n"


def test_fetch_pr_head_backfills_missing_blobs_into_partial_clone(tmp_path: Path) -> None:
    """Same regression as ``test_fetch_ref_backfills…`` but on the PR-review
    path: ``fetch_pr_head`` precedes ``git worktree add --detach FETCH_HEAD``
    and so MUST eagerly fetch blobs reachable from the PR head."""
    upstream = _partial_clone_upstream(tmp_path)
    pool = tmp_path / "pool"
    _git(
        [
            "clone",
            "--filter=blob:none",
            "--no-tags",
            "--branch",
            "main",
            f"file://{upstream}",
            str(pool),
        ],
        cwd=tmp_path,
    )

    # Publish a PR head with a fresh blob.
    pr_sha = _commit_new_blob_upstream(
        upstream, tmp_path, path="pr.txt", content="pr blob payload\n", ref="refs/pull/7/head"
    )

    git_fetch_pr_head(pool, 7, token=None)
    missing_after = _missing_object_oids(pool, pr_sha)
    assert missing_after == [], f"fetch_pr_head left missing objects: {missing_after}"

    # End-to-end: a detached worktree add against the freshly-fetched PR head
    # succeeds without lazy-fetching against (now-broken) origin.
    _git(["-C", str(pool), "remote", "set-url", "origin", "https://example.invalid/missing.git"], cwd=tmp_path)
    ws_dir = tmp_path / "pr-ws"
    subprocess.run(
        ["git", "-C", str(pool), "worktree", "add", "--detach", str(ws_dir), "FETCH_HEAD"],
        check=True,
        capture_output=True,
        text=True,
        env=os.environ | {"GIT_TERMINAL_PROMPT": "0"},
    )
    assert (ws_dir / "pr.txt").read_text(encoding="utf-8") == "pr blob payload\n"


# ---------------------------------------------------------------------------
# NativesCache integration into ensure_workspace
# ---------------------------------------------------------------------------


def _seed_native_dir(repo_dir: Path) -> Path:
    native_dir = repo_dir / "packages" / "natives" / "native"
    native_dir.mkdir(parents=True, exist_ok=True)
    return native_dir


def test_ensure_workspace_without_cache_leaves_native_dir_untouched(tmp_path: Path, upstream_repo: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=10,
        title="no cache",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    assert mgr.natives_cache is None
    # No `packages/natives/native/` was tracked in the upstream, and no cache
    # is configured → the directory wasn't created by populate.
    assert not (ws.repo_dir / "packages" / "natives" / "native").exists()


def test_ensure_workspace_populates_from_natives_cache(tmp_path: Path, upstream_repo: Path) -> None:
    from robomp.natives_cache import NativesCache, compute_key, target_triple

    cache = NativesCache(tmp_path / "natives-cache")
    mgr = SandboxManager(tmp_path / "workspaces", natives_cache=cache)

    # First workspace: stage built artifacts, capture under the workspace's key.
    ws1 = mgr.ensure_workspace(
        repo="octo/widget",
        number=11,
        title="producer",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    native_dir1 = _seed_native_dir(ws1.repo_dir)
    # Mirror the napi build output set. The filename must match the live
    # `target_triple()` value or the populate path won't recognize it.
    triple = target_triple()
    (native_dir1 / f"pi_natives.{triple}.node").write_bytes(b"ELFx")
    (native_dir1 / "index.d.ts").write_text("export const X: number;\n")
    (native_dir1 / "index.js").write_text("export const X = 1;\n")
    (native_dir1 / "embedded-addon.js").write_text("export const embeddedAddon = null;\n")
    key = compute_key(ws1.repo_dir)  # default target = target_triple()
    assert cache.capture("octo/widget", key, native_dir1) is not None

    # Second workspace on the same source HEAD: ensure_workspace auto-populates.
    # We force the same key by pinning TARGET_VARIANT (only relevant on x64;
    # harmless on arm64) — actually compute_key uses target_triple() at call
    # time. To make the test platform-independent, override populate to use
    # the same key explicitly.
    ws2 = mgr.ensure_workspace(
        repo="octo/widget",
        number=12,
        title="consumer",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    native_dir2 = ws2.repo_dir / "packages" / "natives" / "native"
    # The auto-populate path used the real target_triple() — which matches
    # the host that just captured. So the same key applies and files appear.
    assert native_dir2.is_dir(), "populate should have created native/ on hit"
    node_name = f"pi_natives.{triple}.node"
    assert (native_dir2 / node_name).read_bytes() == b"ELFx"
    # The .node is hardlinked, sharing the cache's inode.
    cached_node = cache.entry_dir("octo/widget", key) / node_name
    ws2_node = native_dir2 / node_name
    assert cached_node.stat().st_ino == ws2_node.stat().st_ino


def test_ensure_workspace_cache_miss_is_silent_noop(tmp_path: Path, upstream_repo: Path) -> None:
    from robomp.natives_cache import NativesCache

    cache = NativesCache(tmp_path / "empty-cache")
    mgr = SandboxManager(tmp_path / "workspaces", natives_cache=cache)
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=13,
        title="miss",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    # Cache is empty so the workspace ends up identical to the no-cache case.
    assert ws.repo_dir.is_dir()
    assert not (ws.repo_dir / "packages" / "natives" / "native").exists()


def test_repo_lock_is_per_repo_identity(tmp_path: Path) -> None:
    mgr = SandboxManager(tmp_path)
    assert mgr._repo_lock("o/r") is mgr._repo_lock("o/r")
    assert mgr._repo_lock("o/r") is not mgr._repo_lock("o/r2")


def test_repo_lock_serializes_same_repo(tmp_path: Path) -> None:
    # Deterministic: while one thread holds the repo lock, a probe from a
    # DIFFERENT thread must fail to acquire the SAME repo's lock non-blockingly.
    mgr = SandboxManager(tmp_path)
    held = threading.Event()
    release = threading.Event()
    probe_result: dict[str, bool] = {}

    def holder() -> None:
        with mgr._repo_lock("o/r"):
            held.set()
            assert release.wait(2.0), "probe never completed"

    def probe() -> None:
        assert held.wait(2.0), "holder never acquired the lock"
        lock = mgr._repo_lock("o/r")
        got = lock.acquire(blocking=False)
        probe_result["acquired"] = got
        if got:
            lock.release()
        release.set()

    th = threading.Thread(target=holder)
    tp = threading.Thread(target=probe)
    th.start()
    tp.start()
    th.join(3.0)
    tp.join(3.0)
    # Same repo, held cross-thread -> non-blocking acquire MUST fail.
    assert probe_result.get("acquired") is False, (
        "same-repo lock was acquirable from another thread while held (did not serialize)"
    )


def test_repo_lock_allows_distinct_repos_to_overlap(tmp_path: Path) -> None:
    # Deterministic: holding one repo's lock must NOT block acquiring a
    # DIFFERENT repo's lock from another thread.
    mgr = SandboxManager(tmp_path)
    held = threading.Event()
    release = threading.Event()
    probe_result: dict[str, bool] = {}

    def holder() -> None:
        with mgr._repo_lock("o/a"):
            held.set()
            assert release.wait(2.0), "probe never completed"

    def probe() -> None:
        assert held.wait(2.0), "holder never acquired the lock"
        lock = mgr._repo_lock("o/b")
        got = lock.acquire(blocking=False)
        probe_result["acquired"] = got
        if got:
            lock.release()
        release.set()

    th = threading.Thread(target=holder)
    tp = threading.Thread(target=probe)
    th.start()
    tp.start()
    th.join(3.0)
    tp.join(3.0)
    # Distinct repos -> the other lock is free -> non-blocking acquire succeeds.
    assert probe_result.get("acquired") is True, (
        "distinct-repo lock was NOT acquirable while an unrelated repo's lock was held"
    )


def test_ensure_workspace_acquires_repo_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mgr = SandboxManager(tmp_path)
    mgr.natives_cache = None
    real = threading.RLock()
    events: list[str | tuple[str, str]] = []

    class Rec:
        def __enter__(self) -> Rec:
            events.append("acquire")
            real.acquire()
            return self

        def __exit__(self, *a: object) -> bool:
            real.release()
            events.append("release")
            return False

    def fake_lock(repo: str) -> Rec:
        events.append(("lock", repo))
        return Rec()

    monkeypatch.setattr(mgr, "_repo_lock", fake_lock)
    mgr.transport = SimpleNamespace(
        clone_pool=lambda **k: None,
        fetch_pool=lambda **k: None,
        fetch_base_ref=lambda **k: None,
        fetch_pr_head=lambda **k: None,
    )  # type: ignore
    ok = subprocess.CompletedProcess(["x"], 0, "", "")
    monkeypatch.setattr("robomp.sandbox._run", lambda *a, **k: ok)
    monkeypatch.setattr("robomp.sandbox._safe_run", lambda *a, **k: ok)
    monkeypatch.setattr("robomp.sandbox._chown_workspace", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._share_git_metadata_with_slots", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._provision_runtime_dirs", lambda *a, **k: None)

    ws = mgr.ensure_workspace(
        repo="o/r",
        number=1,
        title="t",
        clone_url="https://x/o/r.git",
        default_branch="main",
        author_name="n",
        author_email="e@e",
        slot_uid=None,
    )
    assert ("lock", "o/r") in events
    assert events.count("acquire") == 1
    assert events.count("release") == 1
    assert ws.repo_full_name == "o/r"


def test_remove_workspace_acquires_repo_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    mgr = SandboxManager(tmp_path)
    events: list[str | tuple[str, str]] = []
    real = threading.RLock()

    class Rec:
        def __enter__(self) -> Rec:
            events.append("acquire")
            real.acquire()
            return self

        def __exit__(self, *a: object) -> bool:
            real.release()
            events.append("release")
            return False

    monkeypatch.setattr(mgr, "_repo_lock", lambda repo: (events.append(("lock", repo)), Rec())[1])
    # ws_root does not exist -> remove_workspace just no-ops inside the lock
    mgr.remove_workspace(repo="o/r", number=99)
    assert ("lock", "o/r") in events
    assert events.count("acquire") == 1 and events.count("release") == 1


def test_safe_run_timeout_returns_124(monkeypatch: pytest.MonkeyPatch) -> None:
    import robomp.sandbox as s

    seen: dict[str, object] = {}

    def boom(*a: object, **k: object) -> subprocess.CompletedProcess:
        seen["timeout"] = k.get("timeout")
        cmd = a[0] if a else k.get("args", ["git"])
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=1)  # type: ignore

    monkeypatch.setattr("robomp.sandbox.subprocess.run", boom)
    r = s._safe_run(["git", "status"])
    assert r.returncode == 124
    assert seen["timeout"] == s._DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT


def test_run_timeout_raises_git_command_error_124(monkeypatch: pytest.MonkeyPatch) -> None:
    import robomp.sandbox as s

    seen: dict[str, object] = {}

    def boom(*a: object, **k: object) -> subprocess.CompletedProcess:
        seen["timeout"] = k.get("timeout")
        cmd = a[0] if a else k.get("args", ["git"])
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=1)  # type: ignore

    monkeypatch.setattr("robomp.sandbox.subprocess.run", boom)
    with pytest.raises(s.GitCommandError) as exc:
        s._run(["git", "status"])
    assert exc.value.returncode == 124
    assert seen["timeout"] == s._DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT


def test_ensure_workspace_raises_when_local_branch_probe_times_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mgr = SandboxManager(tmp_path)
    mgr.natives_cache = None
    mgr.transport = SimpleNamespace(
        clone_pool=lambda **k: None,
        fetch_pool=lambda **k: None,
        fetch_base_ref=lambda **k: None,
        fetch_pr_head=lambda **k: None,
    )  # type: ignore

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        if "rev-parse" in cmd and cmd[-1].startswith("refs/heads/"):
            return subprocess.CompletedProcess(cmd, 124, "", "timed out")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)
    monkeypatch.setattr("robomp.sandbox._run", lambda *a, **k: subprocess.CompletedProcess(["x"], 0, "", ""))
    monkeypatch.setattr("robomp.sandbox._chown_workspace", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._share_git_metadata_with_slots", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._provision_runtime_dirs", lambda *a, **k: None)

    with pytest.raises(GitCommandError):
        mgr.ensure_workspace(
            repo="o/r",
            number=1,
            title="t",
            clone_url="https://x/o/r.git",
            default_branch="main",
            author_name="n",
            author_email="e@e",
            existing_branch="feature/x",
            slot_uid=None,
        )


def test_ensure_workspace_raises_when_remote_branch_probe_times_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mgr = SandboxManager(tmp_path)
    mgr.natives_cache = None
    mgr.transport = SimpleNamespace(
        clone_pool=lambda **k: None,
        fetch_pool=lambda **k: None,
        fetch_base_ref=lambda **k: None,
        fetch_pr_head=lambda **k: None,
    )  # type: ignore

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        if "rev-parse" in cmd and cmd[-1].startswith("refs/heads/"):
            return subprocess.CompletedProcess(cmd, 128, "", "")
        if "rev-parse" in cmd and cmd[-1].startswith("refs/remotes/origin/"):
            return subprocess.CompletedProcess(cmd, 124, "", "timed out")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)
    monkeypatch.setattr("robomp.sandbox._run", lambda *a, **k: subprocess.CompletedProcess(["x"], 0, "", ""))
    monkeypatch.setattr("robomp.sandbox._chown_workspace", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._share_git_metadata_with_slots", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._provision_runtime_dirs", lambda *a, **k: None)

    with pytest.raises(GitCommandError):
        mgr.ensure_workspace(
            repo="o/r",
            number=1,
            title="t",
            clone_url="https://x/o/r.git",
            default_branch="main",
            author_name="n",
            author_email="e@e",
            existing_branch="feature/x",
            slot_uid=None,
        )


def test_ensure_workspace_raises_when_symbolic_ref_probe_times_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mgr = SandboxManager(tmp_path)
    mgr.natives_cache = None
    mgr.transport = SimpleNamespace(
        clone_pool=lambda **k: None,
        fetch_pool=lambda **k: None,
        fetch_base_ref=lambda **k: None,
        fetch_pr_head=lambda **k: None,
    )  # type: ignore

    # Force the repo_exists=True branch: the worktree already has a .git.
    repo_dir = mgr.workspace_root("o/r", 1) / "repo"
    (repo_dir / ".git").mkdir(parents=True)

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        if cmd[:2] == ["git", "symbolic-ref"]:
            return subprocess.CompletedProcess(cmd, 124, "", "timed out")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)
    monkeypatch.setattr("robomp.sandbox._run", lambda *a, **k: subprocess.CompletedProcess(["x"], 0, "", ""))
    monkeypatch.setattr("robomp.sandbox._chown_workspace", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._share_git_metadata_with_slots", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._provision_runtime_dirs", lambda *a, **k: None)
    monkeypatch.setattr("robomp.sandbox._git_env_for_repo", lambda *a, **k: {})

    with pytest.raises(GitCommandError):
        mgr.ensure_workspace(
            repo="o/r",
            number=1,
            title="t",
            clone_url="https://x/o/r.git",
            default_branch="main",
            author_name="n",
            author_email="e@e",
            existing_branch="feature/x",
            slot_uid=None,
        )


def test_remove_workspace_real_prune_clears_dangling_registration(
    tmp_path: Path, upstream_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Integration guard: the other prune tests fully mock `_safe_run`, so the
    # REAL `git worktree prune` never runs and the stale-metadata risk this
    # patch targets is not actually exercised. Here we build a real workspace
    # (real pool clone + real worktree registration), fake ONLY the
    # `git worktree remove` to "time out" (124), and let the real rmtree+prune
    # run. The dangling registration must actually be gone afterward, and a
    # fresh add at the same path must succeed — the real integration risk.
    import robomp.sandbox as s

    mgr = SandboxManager(tmp_path / "workspaces")
    ws = mgr.ensure_workspace(
        repo="octo/widget",
        number=21,
        title="t",
        clone_url=str(upstream_repo),
        default_branch="main",
        author_name="robomp-bot",
        author_email="robomp-bot@example.invalid",
    )
    pool = mgr.pool_path("octo/widget")
    repo_dir = ws.repo_dir
    assert repo_dir.exists()
    listed = subprocess.run(
        ["git", "-C", str(pool), "worktree", "list", "--porcelain"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert str(repo_dir) in listed  # sanity: registration exists

    real_safe_run = s._safe_run

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        if cmd[:3] == ["git", "worktree", "remove"]:
            # A remove that "times out" without unregistering — the source must
            # then rmtree the checkout and run the REAL prune to clear metadata.
            return subprocess.CompletedProcess(cmd, 124, "", "timed out")
        return real_safe_run(cmd, **k)  # type: ignore[arg-type]

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    mgr.remove_workspace(repo="octo/widget", number=21)

    listed_after = subprocess.run(
        ["git", "-C", str(pool), "worktree", "list", "--porcelain"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert str(repo_dir) not in listed_after, listed_after
    # The path is genuinely reusable again — the actual failure the fix prevents.
    subprocess.run(
        ["git", "-C", str(pool), "worktree", "add", "--detach", str(repo_dir), "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    assert repo_dir.exists()


def test_worktree_add_cleans_partial_state_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # A `git worktree add` killed mid-op (124) or otherwise failing must leave no
    # partial checkout and no dangling registration, or the event retry poisons
    # itself on the same path.
    import robomp.sandbox as s

    pool = tmp_path / "pool"
    pool.mkdir()
    repo_dir = tmp_path / "ws" / "repo"
    repo_dir.mkdir(parents=True)
    (repo_dir / "leftover").write_text("partial", encoding="utf-8")

    def boom_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        raise s.GitCommandError(cmd, 124, "", "timed out")

    pruned: list[list[str]] = []

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        pruned.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._run", boom_run)
    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    with pytest.raises(GitCommandError) as exc:
        s._worktree_add(["git", "worktree", "add", str(repo_dir), "main"], pool=pool, repo_dir=repo_dir)

    assert exc.value.returncode == 124  # the original add failure is surfaced
    assert not repo_dir.exists()  # partial checkout removed
    assert ["git", "worktree", "prune"] in pruned  # pool pruned


def test_worktree_add_raises_prune_failure_chained_from_add_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # If the cleanup prune ALSO fails, that failure must be raised (a dangling
    # registration left behind is what poisons the retry) — chained from the
    # original add error so the root cause is not lost.
    import robomp.sandbox as s

    pool = tmp_path / "pool"
    pool.mkdir()
    repo_dir = tmp_path / "ws" / "repo"
    repo_dir.mkdir(parents=True)

    add_err = s.GitCommandError(["git", "worktree", "add"], 1, "", "add failed")

    def boom_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        raise add_err

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(cmd, 124, "", "prune timed out")

    monkeypatch.setattr("robomp.sandbox._run", boom_run)
    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    with pytest.raises(GitCommandError) as exc:
        s._worktree_add(["git", "worktree", "add", str(repo_dir), "main"], pool=pool, repo_dir=repo_dir)

    assert exc.value.returncode == 124  # the PRUNE failure (124), not the add (1)
    assert exc.value.__cause__ is add_err  # chained from the add error


def test_ensure_clone_fails_before_fetch_when_origin_probe_times_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # An older deploy may have baked `https://user:pass@…` into origin;
    # `_reset_origin_url` rewrites it before fetch so the PAT never persists. A
    # timed-out `git remote get-url origin` (124) is indeterminate — ensure_clone
    # must fail closed BEFORE fetch_pool rather than fetch against a possibly-
    # credentialed origin.
    mgr = SandboxManager(tmp_path / "workspaces")
    pool = mgr.pool_path("octo/widget")
    (pool / ".git").mkdir(parents=True)  # take the idempotent-refresh path

    fetched = {"called": False}
    mgr.transport = SimpleNamespace(
        fetch_pool=lambda **k: fetched.__setitem__("called", True),
        clone_pool=lambda **k: None,
    )  # type: ignore

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        if cmd[:4] == ["git", "remote", "get-url", "origin"]:
            return subprocess.CompletedProcess(cmd, 124, "", "timed out")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    with pytest.raises(GitCommandError):
        mgr.ensure_clone(repo="octo/widget", clone_url="https://github.com/octo/widget.git", default_branch="main")
    assert fetched["called"] is False, (
        "fetch_pool ran despite an indeterminate origin probe — a legacy credential could persist and be reused"
    )


def test_remove_workspace_raises_when_prune_times_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # After a failed `git worktree remove`, `git worktree prune` is the step that
    # clears the dangling registration. If prune ITSELF fails (incl. a 124
    # timeout), remove_workspace must raise so the cleanup event retries — not
    # record success while stale metadata still blocks the next add.
    mgr = SandboxManager(tmp_path)
    ws_root = mgr.workspace_root("o/r", 31)
    repo_dir = ws_root / "repo"
    repo_dir.mkdir(parents=True, exist_ok=True)
    pool = mgr.pool_path("o/r")
    pool.mkdir(parents=True, exist_ok=True)
    (pool / ".git").mkdir(exist_ok=True)  # mark as a real git pool for the cleanup gate

    calls: list[list[str]] = []

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        calls.append(list(cmd))
        if cmd[:3] == ["git", "worktree", "remove"]:
            # Distinct code (1, NOT 124) so the assertion below proves the raised
            # error came from PRUNE, not from the remove failure.
            return subprocess.CompletedProcess(cmd, 1, "", "remove failed")
        if cmd[:3] == ["git", "worktree", "prune"]:
            return subprocess.CompletedProcess(cmd, 124, "", "prune timed out")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    with pytest.raises(GitCommandError) as exc:
        mgr.remove_workspace(repo="o/r", number=31)
    # Prune actually ran, and the surfaced error is prune's (124) — not remove's (1).
    assert ["git", "worktree", "prune"] in calls, "prune did not run after a failed remove"
    assert exc.value.returncode == 124


def test_remove_workspace_prunes_when_checkout_already_gone_on_entry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A prior remove/worktree-add killed mid-flight can leave the checkout gone
    # but the pool's worktree registration dangling. On the NEXT remove_workspace
    # the checkout is already missing on entry, yet the stale registration must
    # still be pruned — the old `if repo_dir.exists()` guard skipped it entirely.
    mgr = SandboxManager(tmp_path)
    ws_root = mgr.workspace_root("o/r", 33)
    repo_dir = ws_root / "repo"
    ws_root.mkdir(parents=True, exist_ok=True)  # ws_root present, but NO repo_dir
    pool = mgr.pool_path("o/r")
    pool.mkdir(parents=True, exist_ok=True)
    (pool / ".git").mkdir(exist_ok=True)  # mark as a real git pool for the cleanup gate
    assert not repo_dir.exists()  # precondition: checkout already gone

    calls: list[list[str]] = []

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        calls.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    mgr.remove_workspace(repo="o/r", number=33)

    # No `git worktree remove` (nothing to remove), but prune MUST run to clear
    # any dangling registration for the missing path.
    assert ["git", "worktree", "prune"] in calls, (
        "prune was skipped for a checkout already gone on entry — dangling registration would persist"
    )
    assert not any(c[:3] == ["git", "worktree", "remove"] for c in calls)
    assert not ws_root.exists()  # ws_root still cleaned up


def test_remove_workspace_no_git_ops_when_pool_is_not_a_real_clone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # `ensure_clone` mkdir's the pool dir BEFORE cloning, so a failed first clone
    # can leave a non-git dir at pool_path. A later remove_workspace (e.g. on
    # reopen) must NOT run `git worktree prune` there — it would error on a
    # non-git dir and raise. It must be a clean no-op that still clears ws_root.
    mgr = SandboxManager(tmp_path)
    ws_root = mgr.workspace_root("o/r", 41)
    ws_root.mkdir(parents=True, exist_ok=True)
    pool = mgr.pool_path("o/r")
    pool.mkdir(parents=True, exist_ok=True)  # exists but is NOT a git repo (no .git/HEAD)

    calls: list[list[str]] = []

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        calls.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 128, "", "not a git repository")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    # Must NOT raise despite the pool dir existing.
    mgr.remove_workspace(repo="o/r", number=41)

    assert calls == [], "ran git in a non-git pool dir — would error and raise on cleanup"
    assert not ws_root.exists()  # ws_root still cleaned up


def test_remove_workspace_skips_prune_on_repeat_close_after_full_cleanup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A fully-cleaned workspace has no ws_root. A duplicate/repeat close (GitHub
    # can redeliver a close webhook) must NOT run a speculative `git worktree
    # prune` on the shared pool every time — there is no dangling registration
    # once the first cleanup succeeded. Guarded by `ws_root.exists()`.
    mgr = SandboxManager(tmp_path)
    ws_root = mgr.workspace_root("o/r", 43)
    repo_dir = ws_root / "repo"
    pool = mgr.pool_path("o/r")
    pool.mkdir(parents=True, exist_ok=True)
    (pool / ".git").mkdir(exist_ok=True)  # a REAL git pool (persists across closes)
    assert not ws_root.exists() and not repo_dir.exists()  # already fully cleaned

    calls: list[list[str]] = []

    def fake_safe_run(cmd: list[str], **k: object) -> subprocess.CompletedProcess[str]:
        calls.append(list(cmd))
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("robomp.sandbox._safe_run", fake_safe_run)

    mgr.remove_workspace(repo="o/r", number=43)

    assert calls == [], "repeat close ran a spurious git worktree prune on an already-clean workspace"


def _seed_reclaimable_workspace(mgr: SandboxManager, repo: str, number: int) -> Path:
    """Lay out a workspace with dep caches, session state, and source files."""
    ws_root = mgr.workspace_root(repo, number)
    for rel in (
        "repo/node_modules/left-pad",
        "repo/packages/tui/node_modules/dep",
        "repo/src",
        ".omp-session",
        ".omp-xdg/cache/bun-install",
        ".omp-xdg/state/omp",
        ".omp-tmp",
        "artifacts",
    ):
        (ws_root / rel).mkdir(parents=True)
    (ws_root / "repo/node_modules/left-pad/index.js").write_text("x", encoding="utf-8")
    (ws_root / "repo/packages/tui/node_modules/dep/index.js").write_text("x", encoding="utf-8")
    (ws_root / "repo/src/keep.ts").write_text("keep", encoding="utf-8")
    (ws_root / ".omp-session/session.jsonl").write_text("{}", encoding="utf-8")
    (ws_root / ".omp-xdg/cache/bun-install/pkg.tgz").write_text("x", encoding="utf-8")
    (ws_root / ".omp-xdg/state/omp/state.json").write_text("{}", encoding="utf-8")
    (ws_root / ".omp-tmp/scratch").write_text("x", encoding="utf-8")
    (ws_root / "artifacts/run.log").write_text("x", encoding="utf-8")
    return ws_root


def test_reclaim_workspace_caches_strips_dep_caches_and_preserves_state(tmp_path: Path) -> None:
    # Contract: node_modules (root + nested) and the XDG cache/tmp go away;
    # everything a `--continue` resume needs (session, source, artifacts,
    # non-cache XDG state) survives; no `.trash-*` staging dirs are left.
    mgr = SandboxManager(tmp_path / "workspaces")
    ws_root = _seed_reclaimable_workspace(mgr, "octo/widget", 7)

    assert mgr.reclaim_workspace_caches(repo="octo/widget", number=7) is True

    assert not (ws_root / "repo/node_modules").exists()
    assert not (ws_root / "repo/packages/tui/node_modules").exists()
    assert not (ws_root / ".omp-xdg/cache").exists()
    assert not (ws_root / ".omp-tmp").exists()
    assert (ws_root / "repo/src/keep.ts").read_text(encoding="utf-8") == "keep"
    assert (ws_root / ".omp-session/session.jsonl").exists()
    assert (ws_root / ".omp-xdg/state/omp/state.json").exists()
    assert (ws_root / "artifacts/run.log").exists()
    assert not list(ws_root.glob(".trash-*"))

    # Second pass: nothing left to reclaim.
    assert mgr.reclaim_workspace_caches(repo="octo/widget", number=7) is False


def test_reclaim_workspace_caches_missing_workspace_is_noop(tmp_path: Path) -> None:
    mgr = SandboxManager(tmp_path / "workspaces")
    assert mgr.reclaim_workspace_caches(repo="octo/widget", number=404) is False


def test_reclaim_all_caches_sweeps_workspaces_not_pool(tmp_path: Path) -> None:
    # Startup sweep: every workspace dir is stripped (including `.trash-*`
    # leftovers from a reclaim that died mid-delete); the shared clone pool
    # is never touched.
    mgr = SandboxManager(tmp_path / "workspaces")
    ws_a = _seed_reclaimable_workspace(mgr, "octo/widget", 1)
    ws_b = _seed_reclaimable_workspace(mgr, "octo/gadget", 2)
    (ws_b / ".trash-dead").mkdir()
    (ws_b / ".trash-dead/junk").write_text("x", encoding="utf-8")
    pool_marker = mgr.pool / "octo__widget" / "node_modules"
    pool_marker.mkdir(parents=True)

    assert mgr.reclaim_all_caches() == 2

    for ws_root in (ws_a, ws_b):
        assert not (ws_root / "repo/node_modules").exists()
        assert (ws_root / ".omp-session/session.jsonl").exists()
        assert not list(ws_root.glob(".trash-*"))
    assert pool_marker.exists(), "sweep must never touch the shared clone pool"
    assert mgr.reclaim_all_caches() == 0


# ---- transport parameterization ----


def test_ensure_clone_uses_provided_transport(tmp_path: Path) -> None:
    """ensure_clone with explicit transport= uses it rather than self.transport."""
    from unittest.mock import Mock

    # Mock(spec=[]) denies all attributes, so only the explicitly-attached
    # methods (clone_pool/fetch_pool) are callable — any other transport method
    # the sandbox reaches for fails loudly instead of silently succeeding.
    mock_tr = Mock(spec=[])
    mock_tr.clone_pool = Mock()
    mock_tr.fetch_pool = Mock()
    default_tr = Mock(spec=[])
    default_tr.clone_pool = Mock()
    default_tr.fetch_pool = Mock()

    mgr = SandboxManager(tmp_path / "ws", transport=default_tr)

    # First call: pool dir does not exist yet → clone_pool on explicit transport.
    mgr.ensure_clone(
        repo="octo/widget",
        clone_url="https://github.com/octo/widget.git",
        default_branch="main",
        transport=mock_tr,
    )
    assert mock_tr.clone_pool.called, "clone_pool should be called on explicit transport"
    assert not default_tr.clone_pool.called, "default transport should NOT be used"

    # Idempotent path (pool has .git marker) also routes to explicit transport.
    pool_path = mgr.pool_path("octo/widget")
    _git(["init", "--bare"], pool_path)
    mock_tr.reset_mock()
    default_tr.reset_mock()
    mgr.ensure_clone(
        repo="octo/widget",
        clone_url="https://github.com/octo/widget.git",
        default_branch="main",
        transport=mock_tr,
    )
    assert mock_tr.fetch_pool.called, "fetch_pool should be called on explicit transport (idempotent)"
    assert not default_tr.fetch_pool.called, "default transport should NOT be used"


def test_ensure_workspace_threads_transport_to_ensure_clone(tmp_path: Path) -> None:
    """ensure_workspace passes transport= through to ensure_clone."""
    from unittest.mock import Mock, patch

    mock_tr = Mock(spec=[])
    mock_tr.clone_pool = Mock()
    mock_tr.fetch_pool = Mock()
    mock_tr.fetch_base_ref = Mock()
    mock_tr.fetch_pr_head = Mock()

    mgr = SandboxManager(tmp_path / "ws", transport=Mock())
    pool_dir = mgr.pool_path("octo/widget")
    pool_dir.mkdir(parents=True, exist_ok=True)
    _git(["init"], pool_dir)
    _git(["config", "user.email", "bot@test"], pool_dir)
    _git(["config", "user.name", "Bot"], pool_dir)
    _git(["commit", "--allow-empty", "-m", "root"], pool_dir)
    _git(["branch", "-m", "main"], pool_dir)

    with patch.object(mgr, "ensure_clone", return_value=pool_dir) as mock_ec:
        try:
            mgr.ensure_workspace(
                repo="octo/widget",
                number=1,
                title="Fix bug",
                clone_url="https://github.com/octo/widget.git",
                default_branch="main",
                author_name="bot",
                author_email="bot@example.com",
                transport=mock_tr,
            )
        except GitCommandError:
            pass  # ensure_clone was already called before the git op failed
    assert mock_ec.called
    _, kwargs = mock_ec.call_args
    assert kwargs.get("transport") is mock_tr, "ensure_clone should receive the explicit transport"


def test_ensure_workspace_falls_back_to_self_transport(tmp_path: Path) -> None:
    """ensure_workspace without explicit transport uses self.transport."""
    from unittest.mock import Mock, patch

    default_tr = Mock(spec=[])
    default_tr.clone_pool = Mock()
    default_tr.fetch_pool = Mock()
    default_tr.fetch_base_ref = Mock()
    default_tr.fetch_pr_head = Mock()

    mgr = SandboxManager(tmp_path / "ws", transport=default_tr)
    pool_dir = mgr.pool_path("octo/widget")
    pool_dir.mkdir(parents=True, exist_ok=True)
    _git(["init"], pool_dir)
    _git(["config", "user.email", "bot@test"], pool_dir)
    _git(["config", "user.name", "Bot"], pool_dir)
    _git(["commit", "--allow-empty", "-m", "root"], pool_dir)
    _git(["branch", "-m", "main"], pool_dir)

    with patch.object(mgr, "ensure_clone", return_value=pool_dir) as mock_ec:
        try:
            mgr.ensure_workspace(
                repo="octo/widget",
                number=2,
                title="Another fix",
                clone_url="https://github.com/octo/widget.git",
                default_branch="main",
                author_name="bot",
                author_email="bot@example.com",
            )
        except GitCommandError:
            pass  # ensure_clone was already called before the git op failed
    assert mock_ec.called
    _, kwargs = mock_ec.call_args
    assert kwargs.get("transport") is None, "ensure_clone should receive transport=None when omitted"
