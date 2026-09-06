"""Per-issue workspace lifecycle: clone pool + git worktrees.

The remote-facing git operations (clone, fetch, push) go through a pluggable
`GitTransport` so a deploy can keep the PAT entirely in a separate `gh-proxy`
container. The default `LocalGitTransport` runs git in-process with ephemeral
PAT injection via `--config-env` (see `robomp.git_ops`); the `ProxyGitTransport`
in `robomp.proxy_client` forwards the same set of operations over HMAC RPC.

Per-issue worktree add/remove stays local — those operations only touch the
shared on-disk pool clone, no remote authentication required.

Permission model
----------------
There are four ownership zones on disk; do not let them blur:

1. **Workspace tree** (`/data/workspaces/<key>/`, including `repo/`,
   `.omp-session/`, `context/`, `artifacts/`, `.omp-tmp/`, `.omp-xdg`):
   single-owner. Owned by the active slot UID/GID (`omp-N`) when slot
   isolation is enabled, otherwise by the orchestrator's own UID/GID. Modes
   stay `u=rwX,g=rwX,o=` (effectively `0770` dirs / `0660` files). The
   orchestrator (root) reads/writes via uid-0 bypass when it must, and drops
   to the slot for any subprocess that touches paths the agent will revisit.
   `ensure_workspace` + `_chown_workspace` are the single point of truth for
   this zone — no other helper sets ownership inside `ws_root`.
2. **Clone pool** (`/data/workspaces/_pool/<owner>__<repo>/`): genuinely
   multi-slot. Owned by `root:omp` (gid 2000) with setgid `02770`; cross-slot
   writes are bridged by `_share_git_metadata_with_slots`.
3. **Language tool caches** (`/data/cache/{cargo,cargo-target,rustup,bun-cache}`):
   multi-slot. Owned by `root:omp` with setgid `02770`; provisioned by
   `entrypoint.sh`.
4. **Agent HOME template** (`/srv/agent-home`): read-only, `root:root`
   `0755/0644`.

Bun's install cache stays workspace-private (zone 1) on purpose — bun
chmod/utimes its own cache root, which breaks any shared-cache scheme.
"""

from __future__ import annotations

import hashlib
import logging
import os
import platform
import re
import secrets
import shutil
import signal
import stat
import subprocess
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from robomp.git_ops import (
    GitCommandError,
    PushResult,
    redact_credentials,
)
from robomp.git_ops import (
    clone as git_clone,
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
from robomp.git_ops import (
    push as git_push,
)
from robomp.git_ops import (
    push_release as git_push_release,
)
from robomp.natives_cache import CacheHit, NativesCache
from robomp.natives_cache import compute_key as natives_compute_key

log = logging.getLogger(__name__)


@dataclass(slots=True)
class Workspace:
    """Resolved per-issue scratch space."""

    root: Path
    repo_dir: Path
    session_dir: Path
    context_dir: Path
    artifacts_dir: Path
    branch: str
    repo_full_name: str
    issue_number: int | str

    @property
    def repro_dir(self) -> Path:
        return self.context_dir / "repro"

    @property
    def workspace_key(self) -> str:
        return workspace_key(self.repo_full_name, self.issue_number)


def _slug(text: str, *, length: int = 40) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if not cleaned:
        cleaned = "issue"
    return cleaned[:length]


def _short_hex(seed: str | None = None) -> str:
    if seed:
        return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:8]
    return secrets.token_hex(4)


def workspace_key(repo: str, number: int | str) -> str:
    return f"{repo.replace('/', '__')}__{number}"


def _safe_directory_env(repo_dir: Path) -> dict[str, str]:
    """Return a Git config env overlay whitelisting ``repo_dir`` as safe."""
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "safe.directory",
        "GIT_CONFIG_VALUE_0": str(repo_dir),
    }


def _git_env_for_repo(repo_dir: Path) -> dict[str, str]:
    env = os.environ.copy()
    env.update(_safe_directory_env(repo_dir))
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def make_branch(*, issue_number: int, title: str, seed: str | None = None) -> str:
    return f"farm/{_short_hex(seed or f'{issue_number}-{title}')}/{_slug(title or f'issue-{issue_number}')}"


_BRANCH_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def validate_branch_slug(slug: object) -> str:
    """Return ``slug`` if it is a valid kebab-case branch slug, else raise.

    Rules: 1-50 chars, only ``[a-z0-9-]``, no leading/trailing hyphen, no
    double hyphen. Raises ``ValueError`` otherwise.
    """
    if not isinstance(slug, str) or not _BRANCH_SLUG_RE.fullmatch(slug) or len(slug) > 50:
        raise ValueError(
            f"invalid branch slug {slug!r}: expected kebab-case [a-z0-9-], 1-50 chars, no leading/trailing/double hyphen"
        )
    return slug


def rename_workspace_branch(
    workspace: Workspace,
    new_slug: str,
    *,
    pr_number: int | None = None,
    slot_uid: int | None = None,
) -> str:
    """Rename the workspace's local branch to ``farm/<hex>/<new_slug>``.

    The 8-hex disambiguator stays untouched; only the trailing slug after
    the second `/` changes. Runs ``git branch -m`` inside the worktree
    (which updates the shared refs in the pool) and mutates
    ``workspace.branch`` in place.

    Idempotent when the computed branch already matches ``workspace.branch``.
    Raises ``ValueError`` for syntactically invalid slugs or for a
    workspace whose branch isn't on the ``farm/<hex>/<slug>`` shape.
    Raises ``GitCommandError`` if the underlying ``git`` invocation fails
    (e.g. the target branch name is already taken).

    When ``pr_number`` is provided (non-None), the rename is a no-op: an
    open PR on origin still tracks ``workspace.branch``, and renaming it
    locally would orphan the PR by leaving its head on a branch that no
    longer receives pushes. The slug is still validated so callers see
    the same input errors as the rename path.
    """
    validate_branch_slug(new_slug)
    parts = workspace.branch.split("/", 2)
    if len(parts) != 3 or parts[0] != "farm" or not parts[1]:
        raise ValueError(f"refusing to rename non-farm branch {workspace.branch!r}")
    new_branch = f"farm/{parts[1]}/{new_slug}"
    if new_branch == workspace.branch:
        return new_branch
    if pr_number is not None:
        log.warning(
            "rename_workspace_branch skipped: PR #%d already tracks %r; refusing to rename to %r",
            pr_number,
            workspace.branch,
            new_branch,
        )
        return workspace.branch
    proc = _safe_run(
        ["git", "branch", "-m", workspace.branch, new_branch],
        cwd=workspace.repo_dir,
        env=_git_env_for_repo(workspace.repo_dir),
        **_slot_subprocess_kwargs(slot_uid),
    )
    if proc.returncode != 0:
        raise GitCommandError(
            ["git", "branch", "-m", workspace.branch, new_branch],
            proc.returncode,
            proc.stdout,
            proc.stderr,
        )
    _share_git_metadata_with_slots(workspace.repo_dir, slot_uid)
    workspace.branch = new_branch
    return new_branch


# ---------- GitTransport (transport abstraction over clone/fetch/push) ----------


class GitTransport(Protocol):
    """Pluggable remote-facing git operations.

    Two implementations ship in-tree:
    - `LocalGitTransport`: in-process git with PAT injected per invocation.
    - `robomp.proxy_client.ProxyGitTransport`: forwards over HMAC RPC.
    """

    def clone_pool(self, *, repo: str, clone_url: str, default_branch: str, target: Path) -> None:
        """Fresh clone into `target`. `target` must not exist (or be empty)."""
        ...

    def fetch_pool(self, *, repo: str, pool_dir: Path) -> None:
        """`git fetch --prune origin` against the shared pool clone."""
        ...

    def fetch_base_ref(self, *, repo: str, pool_dir: Path, ref: str) -> None:
        """Best-effort `git fetch origin <ref>` to ensure the base branch is local."""
        ...

    def fetch_pr_head(self, *, repo: str, pool_dir: Path, pr_number: int) -> None:
        """Fetch `refs/pull/<n>/head` into FETCH_HEAD for detached PR review checkouts."""
        ...

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
        """Push `branch` to origin. MUST refuse if HEAD has drifted from `expected_head`."""
        ...

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
        """Atomically push a release branch and move its tag."""
        ...


class LocalGitTransport:
    """Default GitTransport: run git in-process with ephemeral PAT injection.

    `token` MAY be `None` for tests against a local bare repo (no auth) or in
    deploys where the orchestrator does not hold a PAT (but then the proxy
    transport should be used instead).
    """

    __slots__ = ("_token",)

    def __init__(self, token: str | None) -> None:
        self._token = token

    def clone_pool(self, *, repo: str, clone_url: str, default_branch: str, target: Path) -> None:
        del repo  # unused; URL identifies the remote
        git_clone(target, clone_url=clone_url, default_branch=default_branch, token=self._token)

    def fetch_pool(self, *, repo: str, pool_dir: Path) -> None:
        del repo
        git_fetch_prune(pool_dir, token=self._token)

    def fetch_base_ref(self, *, repo: str, pool_dir: Path, ref: str) -> None:
        del repo
        git_fetch_ref(pool_dir, ref, token=self._token)

    def fetch_pr_head(self, *, repo: str, pool_dir: Path, pr_number: int) -> None:
        del repo
        git_fetch_pr_head(pool_dir, pr_number, token=self._token)

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
        del repo, workspace_key
        return git_push(repo_dir, branch=branch, expected_head=expected_head, token=self._token, slot_uid=slot_uid)

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
        del repo, workspace_key
        return git_push_release(
            repo_dir,
            branch=branch,
            tag=tag,
            expected_head=expected_head,
            token=self._token,
            slot_uid=slot_uid,
        )


# ---------- low-level helpers retained for callers expecting old shape ----------


_DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT = 120.0


def _safe_run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    timeout: float | None = _DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT,
    **kwargs: Any,
) -> subprocess.CompletedProcess[str]:
    """Run without raising; caller decides on returncode. Credentials are redacted from any captured output."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            **kwargs,
        )
    except subprocess.TimeoutExpired as exc:
        out = redact_credentials(exc.stdout or "") if isinstance(exc.stdout, str) else ""
        err = redact_credentials(exc.stderr or "") if isinstance(exc.stderr, str) else ""
        return subprocess.CompletedProcess(cmd, 124, out, f"{err}\ntimed out after {timeout:.0f}s")
    if proc.stdout:
        proc.stdout = redact_credentials(proc.stdout)
    if proc.stderr:
        proc.stderr = redact_credentials(proc.stderr)
    return proc


def _run(
    cmd: list[str],
    *,
    cwd: Path | None = None,
    timeout: float | None = _DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT,
) -> subprocess.CompletedProcess[str]:
    """Legacy raising helper (still used by a sandbox test). Forwards to subprocess.run."""
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise GitCommandError(cmd, 124, "", f"git timed out after {timeout:.0f}s") from exc
    if proc.returncode != 0:
        raise GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr)
    return proc


def _worktree_add(add_cmd: list[str], *, pool: Path, repo_dir: Path) -> None:
    """Run `git worktree add`, cleaning partial state on failure.

    A worktree-add killed mid-operation (the 120s `_run` timeout surfaces as
    GitCommandError 124, or any nonzero git failure) can leave a partial
    checkout at `repo_dir` and/or a dangling pool worktree registration. Left
    behind, the event retry hits stale metadata and fails again on the same
    path. Best-effort remove the checkout and prune the pool, then re-raise so the
    retry starts from a clean path. If the prune itself fails (incl. a 124
    timeout), raise that instead — chained from the add error — since a
    dangling registration left behind is exactly what poisons the retry.
    """
    try:
        _run(add_cmd, cwd=pool)
    except GitCommandError as add_err:
        shutil.rmtree(repo_dir, ignore_errors=True)
        pruned = _safe_run(["git", "worktree", "prune"], cwd=pool)
        if pruned.returncode != 0:
            raise GitCommandError(
                ["git", "worktree", "prune"], pruned.returncode, pruned.stdout, pruned.stderr
            ) from add_err
        raise


_SHARED_OMP_GID = 2000


def _slot_permissions_active(slot_uid: int | None) -> bool:
    return slot_uid is not None and platform.system() == "Linux" and os.geteuid() == 0


def _slot_pids(slot_uid: int, proc_root: Path = Path("/proc")) -> tuple[int, ...]:
    """Return non-zombie process ids owned by the slot UID.

    Debian's slim image does not include procps/pkill. Reading `/proc` keeps
    slot cleanup self-contained and avoids adding a runtime package only for
    this one operation.
    """
    try:
        entries = tuple(proc_root.iterdir())
    except OSError as exc:
        log.warning("failed to scan %s for slot user %s: %s", proc_root, slot_uid, exc)
        return ()

    pids: list[int] = []
    for entry in entries:
        if not entry.name.isdecimal():
            continue
        try:
            status = (entry / "status").read_text(encoding="utf-8")
        except OSError:
            # The process may have exited between `iterdir` and `read_text`.
            continue

        state = ""
        uids: tuple[int, ...] = ()
        for line in status.splitlines():
            if line.startswith("State:"):
                parts = line.split(maxsplit=1)
                state = parts[1] if len(parts) == 2 else ""
            elif line.startswith("Uid:"):
                try:
                    uids = tuple(int(part) for part in line.split()[1:5])
                except ValueError:
                    uids = ()

        if state.startswith("Z"):
            continue
        if slot_uid in uids:
            pids.append(int(entry.name))
    return tuple(pids)


def _reap_slot(slot_uid: int | None) -> None:
    """Kill any processes still running as a slot UID.

    Slot UIDs are reused. A previous task's straggler process must not survive
    long enough to observe or interfere with the next task assigned to that UID.
    """
    if not _slot_permissions_active(slot_uid):
        return
    assert slot_uid is not None
    for pid in _slot_pids(slot_uid):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            continue
        except OSError as exc:
            log.warning("failed to kill slot user %s process %s: %s", slot_uid, pid, exc)


def _prepare_slot_tmpdir(workspace: Workspace, slot_uid: int | None) -> Path:
    """Return the per-workspace tmpdir path, idempotently provisioning it.

    Ownership/mode is set by ``_chown_workspace`` as part of the workspace's
    single-ownership invariant; this helper only:

    - replaces any non-directory at ``.omp-tmp`` (symlink-protection: a user
      who plants a symlink there could redirect later writes outside the
      workspace regardless of who owns the destination), and
    - ``mkdir(mode=0o700, exist_ok=True)`` as a safety net for callers that
      run before ``ensure_workspace`` (e.g. unit tests with ``slot_uid=None``).
    """
    del slot_uid  # ownership is _chown_workspace's job; kept for call-site parity
    tmpdir = workspace.root / ".omp-tmp"
    try:
        st = tmpdir.lstat()
    except FileNotFoundError:
        pass
    else:
        if not stat.S_ISDIR(st.st_mode):
            tmpdir.unlink()
    tmpdir.mkdir(mode=0o700, parents=True, exist_ok=True)
    return tmpdir


def _slot_subprocess_kwargs(slot_uid: int | None) -> dict[str, Any]:
    """Return subprocess identity kwargs for commands that should run as a slot.

    `preexec_fn` is intentionally avoided: the worker runs tasks in threads,
    and `subprocess` warns that `preexec_fn` is unsafe in multithreaded
    parents. Python's native `user` / `group` / `extra_groups` parameters do
    the setuid/setgid work in the child safely.
    """
    if not _slot_permissions_active(slot_uid):
        return {}
    assert slot_uid is not None
    return {"user": slot_uid, "group": slot_uid, "extra_groups": [_SHARED_OMP_GID], "umask": 0o002}


def _prepare_slot_runtime_env(workspace: Workspace, slot_uid: int | None) -> dict[str, str]:
    """Compute the env overlay (TMPDIR + XDG_*) for slot-side subprocesses.

    Pure env helper: ownership of the workspace tree (including these XDG
    paths and the bun install cache) is the single responsibility of
    ``ensure_workspace``/``_chown_workspace``. The mkdir calls here exist
    only as a safety net for callers that bypass ``ensure_workspace`` (unit
    tests) or for the case where a runtime dir was deleted mid-process.

    Cargo/rustup/target caches live under ``/data/cache/*`` (container ENV)
    and are group-shared via ``omp``. Bun's install cache is explicitly
    workspace-private because bun chmod/chowns its cache root, which makes a
    cross-slot shared cache a permanent source of permission failures.
    """
    tmpdir = _prepare_slot_tmpdir(workspace, slot_uid)
    xdg_root = workspace.root / ".omp-xdg"
    xdg_data = xdg_root / "data"
    xdg_state = xdg_root / "state"
    xdg_cache = xdg_root / "cache"
    bun_cache = xdg_cache / "bun-install"

    for base in (xdg_data, xdg_state, xdg_cache):
        base.mkdir(parents=True, exist_ok=True)
        (base / "omp").mkdir(parents=True, exist_ok=True)
    bun_cache.mkdir(parents=True, exist_ok=True)

    return {
        "TMPDIR": str(tmpdir),
        "TMP": str(tmpdir),
        "TEMP": str(tmpdir),
        "XDG_DATA_HOME": str(xdg_data),
        "XDG_STATE_HOME": str(xdg_state),
        "XDG_CACHE_HOME": str(xdg_cache),
        "BUN_INSTALL_CACHE_DIR": str(bun_cache),
    }


def _provision_runtime_dirs(ws_root: Path) -> None:
    """Create the runtime dirs that ``_chown_workspace`` will hand to the slot.

    Runs immediately before ``_chown_workspace`` so the recursive chown sweep
    picks up ``.omp-tmp`` and the per-workspace XDG tree. Without this,
    ``_prepare_slot_runtime_env`` would create them later from the orchestrator
    process — leaving root-owned cache roots that bun/biome/cargo cannot
    chmod/utime, the original source of the recurring permission failures.

    Symlink-safe on ``.omp-tmp`` (replaces a planted non-directory in place).
    """
    tmpdir = ws_root / ".omp-tmp"
    try:
        st = tmpdir.lstat()
    except FileNotFoundError:
        pass
    else:
        if not stat.S_ISDIR(st.st_mode):
            tmpdir.unlink()
    tmpdir.mkdir(mode=0o700, parents=True, exist_ok=True)

    xdg_root = ws_root / ".omp-xdg"
    for sub in ("data", "state", "cache"):
        base = xdg_root / sub
        base.mkdir(parents=True, exist_ok=True)
        (base / "omp").mkdir(parents=True, exist_ok=True)
    (xdg_root / "cache" / "bun-install").mkdir(parents=True, exist_ok=True)


def _grant_group_bits(path: Path, *, gid: int, bits: int) -> None:
    try:
        st = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(st.st_mode):
        return
    os.chown(path, -1, gid)
    path.chmod(stat.S_IMODE(st.st_mode) | bits)


def _grant_tree(path: Path, *, gid: int, files_group_writable: bool) -> None:
    if not path.exists():
        return
    if path.is_file():
        bits = stat.S_IRGRP | (stat.S_IWGRP if files_group_writable else 0)
        _grant_group_bits(path, gid=gid, bits=bits)
        return
    for root, dirs, files in os.walk(path, followlinks=False):
        root_path = Path(root)
        _grant_group_bits(root_path, gid=gid, bits=stat.S_IRWXG | stat.S_ISGID)
        for dirname in dirs:
            _grant_group_bits(root_path / dirname, gid=gid, bits=stat.S_IRWXG | stat.S_ISGID)
        file_bits = stat.S_IRGRP | (stat.S_IWGRP if files_group_writable else 0)
        for filename in files:
            _grant_group_bits(root_path / filename, gid=gid, bits=file_bits)


def _resolve_worktree_git_dirs(repo_dir: Path) -> tuple[Path, Path] | None:
    marker = repo_dir / ".git"
    if marker.is_dir():
        return marker, marker
    try:
        text = marker.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    prefix = "gitdir:"
    if not text.startswith(prefix):
        return None
    raw_git_dir = text[len(prefix) :].strip()
    git_dir = Path(raw_git_dir)
    if not git_dir.is_absolute():
        git_dir = (repo_dir / git_dir).resolve()
    try:
        raw_common_dir = (git_dir / "commondir").read_text(encoding="utf-8").strip()
    except OSError:
        return git_dir, git_dir
    common_dir = Path(raw_common_dir)
    if not common_dir.is_absolute():
        common_dir = (git_dir / common_dir).resolve()
    return git_dir, common_dir


def _share_git_metadata_with_slots(repo_dir: Path, slot_uid: int | None) -> None:
    """Keep shared Git metadata writable by whichever slot gets the retry.

    The worktree checkout itself is slot-private, but `.git` in a Git worktree
    points back into the shared clone pool. A retry may run as a different
    `omp-N` user, so the pool-side worktree gitdir, refs, reflogs, and object
    directories must stay writable through the shared `omp` group.
    """
    if not _slot_permissions_active(slot_uid):
        return
    dirs = _resolve_worktree_git_dirs(repo_dir)
    if dirs is None:
        return
    git_dir, common_dir = dirs
    gid = _SHARED_OMP_GID
    _grant_tree(git_dir, gid=gid, files_group_writable=True)
    _grant_group_bits(common_dir, gid=gid, bits=stat.S_IRWXG | stat.S_ISGID)
    for rel, files_group_writable in (
        ("objects", False),
        ("refs", True),
        ("logs", True),
        ("worktrees", True),
    ):
        _grant_tree(common_dir / rel, gid=gid, files_group_writable=files_group_writable)
    for rel in ("config", "packed-refs", "HEAD", "FETCH_HEAD", "ORIG_HEAD"):
        _grant_tree(common_dir / rel, gid=gid, files_group_writable=True)


def _chown_workspace(ws_root: Path, slot_uid: int | None) -> None:
    """Hand the workspace tree to the identity that will run repo-local git.

    With slot isolation enabled, that identity is ``slot_uid:slot_uid``.
    Without slots, the agent and host-side repo commands run as the
    orchestrator user itself. Existing workspaces may still be owned by an
    old slot UID from a prior deploy; normalizing them back to the current
    euid/egid keeps Git's ownership check satisfied without persistent
    ``safe.directory`` config.

    Single-ownership invariant: every file under ``ws_root`` ends up owned by
    the active runner with mode ``u=rwX,g=rwX,o=`` (``0770`` dirs / ``0660``
    files).

    The orchestrator (root) keeps read/write access via uid-0 bypass; any
    subprocess that touches paths the agent will revisit MUST either run as
    the same owner or call this helper before invoking Git/tools that enforce
    owner-sensitive state.
    """
    if platform.system() != "Linux":
        return
    if os.geteuid() != 0:
        return
    uid = slot_uid if slot_uid is not None else os.geteuid()
    gid = slot_uid if slot_uid is not None else os.getegid()
    subprocess.run(
        ["chown", "-R", f"{uid}:{gid}", str(ws_root)],
        check=True,
        timeout=_DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT,
    )
    subprocess.run(
        ["chmod", "-R", "u=rwX,g=rwX,o=", str(ws_root)],
        check=True,
        timeout=_DEFAULT_SANDBOX_SUBPROCESS_TIMEOUT,
    )


# ---------- workspace cache reclamation ----------


_TRASH_PREFIX = ".trash-"
# ws/repo/node_modules is depth 2 from ws_root's repo dir; nested workspace
# installs (packages/x/node_modules, python/x/web/node_modules) sit at 3-4.
_NODE_MODULES_SCAN_DEPTH = 4


def _find_node_modules(repo_dir: Path, *, max_depth: int = _NODE_MODULES_SCAN_DEPTH) -> list[Path]:
    """Locate `node_modules` dirs in a checkout without descending into them.

    Depth-limited (bun's hoisted linker keeps everything at the root; nested
    workspace installs sit a couple of levels down) and prunes `.git` plus the
    matches themselves, so the walk stays cheap on a large tree.
    """
    found: list[Path] = []
    if not repo_dir.is_dir():
        return found
    base_depth = len(repo_dir.parts)
    for current, dirnames, _files in os.walk(repo_dir):
        current_path = Path(current)
        if "node_modules" in dirnames:
            found.append(current_path / "node_modules")
        if len(current_path.parts) - base_depth + 1 >= max_depth:
            dirnames[:] = []
        else:
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules")]
    return found


def _stage_workspace_trash(ws_root: Path) -> tuple[Path, ...]:
    """Rename reclaimable cache dirs into `.trash-*` staging dirs.

    Rename is atomic and near-free on the same filesystem, so a caller can
    hold a lock across this and defer the slow ``rmtree`` to after the lock
    is dropped. Targets: every ``node_modules`` in the checkout, the
    workspace-private XDG cache (bun install cache lives there) and the
    tmpdir — all re-created by ``ensure_workspace`` +
    ``ensure_workspace_dependencies`` on the next run. Session transcripts,
    context, artifacts and the git worktree are never touched.

    Returns every staged trash dir, including leftovers from a previous
    interrupted reclaim.
    """
    if not ws_root.is_dir():
        return ()
    staged = [p for p in ws_root.iterdir() if p.name.startswith(_TRASH_PREFIX)]
    candidates = [
        ws_root / ".omp-xdg" / "cache",
        ws_root / ".omp-tmp",
        *_find_node_modules(ws_root / "repo"),
    ]
    trash_root: Path | None = None
    for index, victim in enumerate(candidates):
        try:
            st = victim.lstat()
        except FileNotFoundError:
            continue
        if not (stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode)):
            continue
        if trash_root is None:
            trash_root = ws_root / f"{_TRASH_PREFIX}{secrets.token_hex(4)}"
            trash_root.mkdir(mode=0o700)
            staged.append(trash_root)
        try:
            victim.rename(trash_root / f"{index}-{victim.name}")
        except OSError as exc:
            log.warning("cache reclaim rename failed", extra={"path": str(victim), "err": str(exc)})
    return tuple(staged)


def _purge_trash(staged: Iterable[Path]) -> None:
    for path in staged:
        shutil.rmtree(path, ignore_errors=True)


# ---------- SandboxManager ----------


class SandboxManager:
    """Manages a shared clone pool and per-issue worktrees.

    Remote-facing git operations are delegated to a `GitTransport`; the rest
    (worktree add/remove, identity config, directory layout) is purely local.
    """

    def __init__(
        self,
        root: Path,
        *,
        transport: GitTransport | None = None,
        natives_cache: NativesCache | None = None,
    ) -> None:
        self.root = root
        self.pool = root / "_pool"
        self.transport: GitTransport = transport or LocalGitTransport(token=None)
        self.natives_cache = natives_cache
        root.mkdir(parents=True, exist_ok=True)
        self.pool.mkdir(parents=True, exist_ok=True)
        self._repo_locks: dict[str, threading.RLock] = {}
        self._repo_locks_guard = threading.Lock()

    def _repo_lock(self, repo: str) -> threading.RLock:
        with self._repo_locks_guard:
            lock = self._repo_locks.get(repo)
            if lock is None:
                lock = threading.RLock()
                self._repo_locks[repo] = lock
            return lock

    # ---- pool ----
    def pool_path(self, repo: str) -> Path:
        return self.pool / repo.replace("/", "__")

    def ensure_clone(
        self,
        *,
        repo: str,
        clone_url: str,
        default_branch: str,
        refresh: bool = True,
    ) -> Path:
        """Create or refresh the shared clone for `repo`.

        `clone_url` MUST be a plain `https://github.com/<owner>/<repo>.git`
        (no embedded credentials). Auth is supplied per-call by the transport.
        """
        target = self.pool_path(repo)
        if (target / ".git").exists() or (target / "HEAD").exists():
            self._reset_origin_url(target, clone_url)
            if refresh:
                self.transport.fetch_pool(repo=repo, pool_dir=target)
            return target
        target.mkdir(parents=True, exist_ok=True)
        self.transport.clone_pool(
            repo=repo,
            clone_url=clone_url,
            default_branch=default_branch,
            target=target,
        )
        return target

    @staticmethod
    def _reset_origin_url(repo_dir: Path, clone_url: str) -> None:
        """`git remote set-url origin <clone_url>` if origin exists and differs.

        Best-effort: silent no-op on a "no origin" failure (probe `get-url`
        first so we don't spam logs on first-time clones). A timed-out probe
        (124) is indeterminate and raises instead — see below.
        """
        probe = _safe_run(["git", "remote", "get-url", "origin"], cwd=repo_dir)
        if probe.returncode == 124:
            # A timed-out probe is indeterminate: we cannot tell whether origin
            # embeds a legacy credential that must be rewritten before fetch.
            # Fail closed so the event retries rather than fetching against a
            # possibly-credentialed origin.
            raise GitCommandError(["git", "remote", "get-url", "origin"], probe.returncode, probe.stdout, probe.stderr)
        if probe.returncode != 0:
            return
        if probe.stdout.strip() == clone_url:
            return
        _safe_run(["git", "remote", "set-url", "origin", clone_url], cwd=repo_dir)

    # ---- per-issue workspace ----
    def workspace_root(self, repo: str, number: int | str) -> Path:
        return self.root / workspace_key(repo, number)

    def ensure_workspace(
        self,
        *,
        repo: str,
        number: int,
        title: str,
        clone_url: str,
        default_branch: str,
        existing_branch: str | None = None,
        pr_head: int | None = None,
        author_name: str,
        author_email: str,
        slot_uid: int | None = None,
    ) -> Workspace:
        """Create or resume a per-issue worktree."""
        with self._repo_lock(repo):
            if pr_head is not None and existing_branch is not None:
                raise ValueError("ensure_workspace accepts either pr_head or existing_branch, not both")
            pool = self.ensure_clone(repo=repo, clone_url=clone_url, default_branch=default_branch)
            ws_root = self.workspace_root(repo, number)
            repo_dir = ws_root / "repo"
            session_dir = ws_root / ".omp-session"
            context_dir = ws_root / "context"
            artifacts_dir = ws_root / "artifacts"
            for path in (ws_root, session_dir, context_dir, context_dir / "repro", artifacts_dir):
                path.mkdir(parents=True, exist_ok=True)

            branch = (
                f"review/pr-{pr_head}"
                if pr_head is not None
                else existing_branch
                or make_branch(
                    issue_number=number,
                    title=title,
                    seed=f"{repo}#{number}",
                )
            )

            repo_exists = (repo_dir / ".git").exists()
            workspace_prepared = False
            slot_git_kwargs = _slot_subprocess_kwargs(slot_uid)
            slot_git_env: dict[str, str] | None = None
            if repo_exists:
                # Existing workspaces are already slot-owned from the previous run.
                # Refresh pool-side group bits, then hand the tree to the current
                # slot before running any git command inside the worktree; root's
                # uid-0 bypass does not bypass git's safe.directory ownership check.
                _share_git_metadata_with_slots(repo_dir, slot_uid)
                _provision_runtime_dirs(ws_root)
                _chown_workspace(ws_root, slot_uid)
                workspace_prepared = True
            if not repo_exists:
                if pr_head is not None:
                    self.transport.fetch_pr_head(repo=repo, pool_dir=pool, pr_number=pr_head)
                    _worktree_add(
                        ["git", "worktree", "add", "--detach", str(repo_dir), "FETCH_HEAD"],
                        pool=pool,
                        repo_dir=repo_dir,
                    )
                else:
                    # Make sure the requested start point exists locally (best-effort).
                    # For follow-ups on an existing PR, `existing_branch` is the remote
                    # head branch we need to amend; starting from default would silently
                    # lose the PR's current commits if the local pool branch is absent.
                    self.transport.fetch_base_ref(repo=repo, pool_dir=pool, ref=existing_branch or default_branch)
                    probe = ["git", "rev-parse", "--verify", f"refs/heads/{branch}"]
                    check = _safe_run(probe, cwd=pool)
                    if check.returncode == 124:
                        # A timed-out probe is indeterminate, not "branch absent".
                        # Falling through would create the worktree from the wrong
                        # start point; fail instead so the event retries.
                        raise GitCommandError(probe, check.returncode, check.stdout, check.stderr)
                    if check.returncode == 0:
                        _worktree_add(
                            ["git", "worktree", "add", str(repo_dir), branch],
                            pool=pool,
                            repo_dir=repo_dir,
                        )
                    else:
                        start_point = f"origin/{default_branch}"
                        if existing_branch:
                            remote_probe = ["git", "rev-parse", "--verify", f"refs/remotes/origin/{existing_branch}"]
                            remote = _safe_run(remote_probe, cwd=pool)
                            if remote.returncode == 124:
                                # Same: an indeterminate probe must not silently fall
                                # back to origin/default and lose the PR's commits.
                                raise GitCommandError(remote_probe, remote.returncode, remote.stdout, remote.stderr)
                            if remote.returncode == 0:
                                start_point = f"origin/{existing_branch}"
                        _worktree_add(
                            ["git", "worktree", "add", "-b", branch, str(repo_dir), start_point],
                            pool=pool,
                            repo_dir=repo_dir,
                        )
            else:
                slot_git_env = _git_env_for_repo(repo_dir)
                symref = ["git", "symbolic-ref", "--quiet", "--short", "HEAD"]
                current = _safe_run(
                    symref,
                    cwd=repo_dir,
                    env=slot_git_env,
                    **slot_git_kwargs,
                )
                if current.returncode == 124:
                    # A timed-out probe is indeterminate, not "detached HEAD".
                    # Silently keeping the caller-supplied branch could mismatch
                    # the real checkout; fail so the event retries.
                    raise GitCommandError(symref, current.returncode, current.stdout, current.stderr)
                if current.returncode == 0 and current.stdout.strip():
                    branch = current.stdout.strip()
                    if existing_branch is not None and existing_branch != branch:
                        log.warning(
                            "workspace branch mapping %r differs from checked-out branch %r; using checkout",
                            existing_branch,
                            branch,
                        )
            if not workspace_prepared:
                _share_git_metadata_with_slots(repo_dir, slot_uid)
                _provision_runtime_dirs(ws_root)
                _chown_workspace(ws_root, slot_uid)
            if slot_git_env is None:
                slot_git_env = _git_env_for_repo(repo_dir)
            # Identity is set on the worktree's shared config; idempotent. Run as
            # the slot after the chown so git never trips over safe.directory.
            for command in (["git", "config", "user.email", author_email], ["git", "config", "user.name", author_name]):
                proc = _safe_run(command, cwd=repo_dir, env=slot_git_env, **slot_git_kwargs)
                if proc.returncode != 0:
                    raise GitCommandError(command, proc.returncode, proc.stdout, proc.stderr)
            _share_git_metadata_with_slots(repo_dir, slot_uid)
            workspace = Workspace(
                root=ws_root,
                repo_dir=repo_dir,
                session_dir=session_dir,
                context_dir=context_dir,
                artifacts_dir=artifacts_dir,
                branch=branch,
                repo_full_name=repo,
                issue_number=number,
            )
            # Best-effort: hardlink pre-built natives in if we've cached this
            # source state before. Runs AFTER the slot chown so the cache inode
            # keeps its `root:omp` ownership (the slot reads through group `omp`);
            # write-temp + rename in the napi build replaces with a new inode if
            # the agent rebuilds, so the cached file is never mutated.
            self._populate_natives_cache(workspace, slot_uid=slot_uid)
            return workspace

    def ensure_release_workspace(
        self,
        *,
        repo: str,
        clone_url: str,
        default_branch: str,
        tag: str,
        author_name: str,
        author_email: str,
        slot_uid: int | None = None,
    ) -> Workspace:
        """Create or reset the repository's reusable main-branch release worktree."""
        with self._repo_lock(repo):
            pool = self.ensure_clone(
                repo=repo,
                clone_url=clone_url,
                default_branch=default_branch,
                refresh=False,
            )
            self.transport.fetch_pool(repo=repo, pool_dir=pool)
            ws_root = self.workspace_root(repo, "release")
            repo_dir = ws_root / "repo"
            session_dir = ws_root / f".omp-session-{tag}"
            context_dir = ws_root / "context"
            artifacts_dir = ws_root / "artifacts"
            for path in (ws_root, session_dir, context_dir, context_dir / "repro", artifacts_dir):
                path.mkdir(parents=True, exist_ok=True)

            detach = ["git", "checkout", "--detach"]
            detached = _safe_run(detach, cwd=pool)
            if detached.returncode != 0:
                raise GitCommandError(detach, detached.returncode, detached.stdout, detached.stderr)

            if not (repo_dir / ".git").exists():
                _worktree_add(
                    [
                        "git",
                        "worktree",
                        "add",
                        "-B",
                        default_branch,
                        str(repo_dir),
                        f"origin/{default_branch}",
                    ],
                    pool=pool,
                    repo_dir=repo_dir,
                )

            _share_git_metadata_with_slots(repo_dir, slot_uid)
            _provision_runtime_dirs(ws_root)
            _chown_workspace(ws_root, slot_uid)
            slot_git_kwargs = _slot_subprocess_kwargs(slot_uid)
            slot_git_env = _git_env_for_repo(repo_dir)
            commands = (
                ["git", "checkout", "-B", default_branch, f"origin/{default_branch}"],
                ["git", "reset", "--hard", f"origin/{default_branch}"],
                ["git", "clean", "-fd"],
                ["git", "config", "user.email", author_email],
                ["git", "config", "user.name", author_name],
            )
            for command in commands:
                proc = _safe_run(command, cwd=repo_dir, env=slot_git_env, **slot_git_kwargs)
                if proc.returncode != 0:
                    raise GitCommandError(command, proc.returncode, proc.stdout, proc.stderr)
            _share_git_metadata_with_slots(repo_dir, slot_uid)
            workspace = Workspace(
                root=ws_root,
                repo_dir=repo_dir,
                session_dir=session_dir,
                context_dir=context_dir,
                artifacts_dir=artifacts_dir,
                branch=default_branch,
                repo_full_name=repo,
                issue_number="release",
            )
            self._populate_natives_cache(workspace, slot_uid=slot_uid)
            return workspace

    def _populate_natives_cache(self, workspace: Workspace, *, slot_uid: int | None = None) -> None:
        """Try to hardlink cached pi-natives artifacts into the worktree.

        Best-effort: any failure (no cache configured, non-git worktree,
        cache miss, link error) is logged at debug and swallowed. The agent
        falls back to a fresh napi build, exactly as it would without the
        cache.

        Post-populate, the populated `packages/natives/native/` directory
        and the COPIED companion files are chowned to the slot so the slot
        can rebuild via temp + rename in that directory. The hardlinked
        `.node` files are LEFT at `root:omp` ownership — chowning them
        would chown the cache file too (shared inode), breaking the
        cross-slot sharing model. The slot reads them via group `omp`.
        """
        cache = self.natives_cache
        if cache is None:
            return
        native_dir = workspace.repo_dir / "packages" / "natives" / "native"
        # NOTE: we deliberately do NOT require `native_dir.exists()` here. On
        # a cache miss `populate_workspace` returns None without creating any
        # directory; on a hit it mkdirs and copies in. That's the right
        # behavior — a hit by definition implies this repo's source state
        # produces natives, so creating the dir is correct.
        try:
            key = natives_compute_key(workspace.repo_dir)
        except (subprocess.SubprocessError, RuntimeError, OSError) as exc:
            log.debug(
                "natives_cache key compute failed",
                extra={"workspace": workspace.workspace_key, "err": redact_credentials(str(exc))},
            )
            return
        try:
            hit = cache.populate_workspace(workspace.repo_full_name, key, native_dir)
        except OSError as exc:
            log.warning(
                "natives_cache populate failed",
                extra={"workspace": workspace.workspace_key, "key": key, "err": str(exc)},
            )
            return
        if hit is not None and _slot_permissions_active(slot_uid):
            assert slot_uid is not None
            self._chown_natives_for_slot(native_dir, hit, slot_uid=slot_uid)
        log.info(
            "natives_cache",
            extra={
                "action": "hit" if hit is not None else "miss",
                "workspace": workspace.workspace_key,
                "repo": workspace.repo_full_name,
                "key": key,
                "files": [str(p.name) for p in hit.files] if hit is not None else [],
            },
        )

    @staticmethod
    def _chown_natives_for_slot(native_dir: Path, hit: CacheHit, *, slot_uid: int) -> None:
        """Hand the populated native dir to the slot WITHOUT touching the
        hardlinked `.node` inodes (those are shared with the cache).

        Files whose names match a cached `.node` are skipped — they are
        hardlinks back into the root:omp cache and the slot reads them via
        group `omp`. Everything else (the directory itself, copied
        companions) is chowned to the slot so the slot can rebuild via
        temp + rename.
        """
        try:
            os.chown(native_dir, slot_uid, slot_uid)
        except OSError as exc:
            log.warning("natives_cache chown dir failed", extra={"err": str(exc)})
            return
        node_basenames = {p.name for p in hit.files if p.name.endswith(".node")}
        for child in native_dir.iterdir():
            if child.name in node_basenames:
                continue  # hardlink to cache — must not chown
            try:
                os.chown(child, slot_uid, slot_uid, follow_symlinks=False)
            except OSError as exc:
                log.warning(
                    "natives_cache chown companion failed",
                    extra={"file": str(child), "err": str(exc)},
                )

    def remove_workspace(self, *, repo: str, number: int | str) -> None:
        with self._repo_lock(repo):
            ws_root = self.workspace_root(repo, number)
            repo_dir = ws_root / "repo"
            pool = self.pool_path(repo)
            # `repo_dir.exists()` is not a reliable proxy for "nothing to clean
            # up in the pool": a worktree-add or a prior remove killed mid-flight
            # can leave the checkout gone but the pool's worktree registration
            # dangling, which fails the next `git worktree add` for this path.
            # Only run git in a REAL pool clone: `ensure_clone` mkdir's the pool
            # dir BEFORE cloning, so a failed first clone can leave a non-git dir
            # here, and `git worktree prune` in it would error. Mirror
            # `ensure_clone`'s own `.git`/`HEAD` validity check.
            if (pool / ".git").exists() or (pool / "HEAD").exists():
                needs_prune = False
                if repo_dir.exists():
                    removed = _safe_run(["git", "worktree", "remove", "--force", str(repo_dir)], cwd=pool)
                    if removed.returncode != 0:
                        shutil.rmtree(repo_dir, ignore_errors=True)
                        needs_prune = True
                elif ws_root.exists():
                    # Checkout gone but the workspace root remains -> a prior op
                    # was killed mid-flight and may have left a dangling
                    # registration. A fully-cleaned workspace has no ws_root, so
                    # a plain repeat close prunes nothing.
                    needs_prune = True
                if needs_prune:
                    pruned = _safe_run(["git", "worktree", "prune"], cwd=pool)
                    if pruned.returncode != 0:
                        # Prune is the step that clears the dangling registration.
                        # If it fails (incl. a 124 timeout), report it so the
                        # cleanup event retries instead of recording success with
                        # stale metadata still blocking the next add.
                        raise GitCommandError(
                            ["git", "worktree", "prune"], pruned.returncode, pruned.stdout, pruned.stderr
                        )
            if ws_root.exists():
                shutil.rmtree(ws_root, ignore_errors=True)

    def reclaim_workspace_caches(self, *, repo: str, number: int | str) -> bool:
        """Strip re-creatable dependency caches from an idle workspace.

        Every task run reinstalls ``node_modules`` (see
        ``host_tools.ensure_workspace_dependencies``), so between runs the
        checkout's ``node_modules`` and the workspace-private bun install
        cache are dead weight — multiple GB per issue that would otherwise
        persist until the issue closes, which is exactly how the host runs
        out of disk. ``--continue`` resumes are unaffected: session
        transcripts, context, artifacts and the worktree survive.

        The rename pass runs under the per-repo lock (serialized against
        ``ensure_workspace``); the slow deletes happen after the lock is
        dropped. Returns True when anything was reclaimed.
        """
        with self._repo_lock(repo):
            staged = _stage_workspace_trash(self.workspace_root(repo, number))
        _purge_trash(staged)
        return bool(staged)

    def reclaim_all_caches(self) -> int:
        """Sweep dependency caches from every workspace under ``root``.

        Crash-leftover recovery: called from ``WorkerPool.start()`` before
        the dispatch loop comes online, so no task can be touching a
        workspace and the per-repo locks are deliberately skipped. Returns
        the number of workspaces that had something to reclaim.
        """
        if not self.root.is_dir():
            return 0
        count = 0
        for entry in sorted(self.root.iterdir()):
            if entry.name == "_pool" or entry.name.startswith(".") or not entry.is_dir():
                continue
            staged = _stage_workspace_trash(entry)
            if staged:
                _purge_trash(staged)
                count += 1
        return count


__all__ = [
    "GitCommandError",
    "GitTransport",
    "LocalGitTransport",
    "SandboxManager",
    "Workspace",
    "make_branch",
    "rename_workspace_branch",
    "validate_branch_slug",
    "redact_credentials",
    "workspace_key",
]
