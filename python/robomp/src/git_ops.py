"""Low-level git primitives with ephemeral PAT injection.

The PAT is supplied through `git --config-env=http.<url>.extraHeader=ENVVAR`
when a verified HTTPS remote is known, or the legacy global `http.extraHeader`
path for older direct callers. Git expands the env var inside the spawned
process; the secret never appears in argv visible to other UIDs via
`/proc/<pid>/cmdline`.

Used by:
- `robomp.sandbox.LocalGitTransport` for in-process git operations when no
  proxy is configured.
- `robomp.proxy.server` for proxied operations on the gh-proxy side.
"""

from __future__ import annotations

import base64
import logging
import os
import platform
import re
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

log = logging.getLogger(__name__)

# Per-call env var name. `git --config-env` reads the header value from this
# env entry inside the spawned process — never persisted into `.git/config`.
AUTH_ENV_VAR = "ROBOMP_GIT_HTTP_AUTH"
_TOKEN_ALLOWED_PROTOCOLS = "https"
_TOKEN_SAFE_CONFIG = [
    "protocol.allow=never",
    "protocol.https.allow=always",
    "protocol.http.allow=never",
    "protocol.git.allow=never",
    "protocol.ssh.allow=never",
    "protocol.file.allow=never",
    "protocol.ext.allow=never",
    "credential.helper=",
    "core.askPass=",
    "core.hooksPath=/dev/null",
    "http.proxy=",
    "http.sslVerify=true",
    "http.extraHeader=",
]
_GIT_SUBPROCESS_SCRUBBED_ENV_KEYS = (
    AUTH_ENV_VAR,
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "ROBOMP_REPLAY_TOKEN",
    "ROBOMP_GH_PROXY_HMAC_KEY",
)


def _git_subprocess_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in _GIT_SUBPROCESS_SCRUBBED_ENV_KEYS:
        env.pop(key, None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_ASKPASS"] = ""
    env["SSH_ASKPASS"] = ""
    return env



# git matches `http.<url>.*` / `credential.<url>.*` against the FULL request
# URL, and the longest path-prefix wins — so a base-only override loses to an
# agent-planted repo-local key like `http.<url>/info/refs.proxy=http://evil`,
# which would route the token-bearing fetch through an attacker proxy and read
# the injected Authorization header. Override every git smart-HTTP request path
# the fetch/push can actually hit. The set is exhaustive: a repo-local key
# longer than the real request path can't match it, and `GIT_CONFIG_SYSTEM`/
# `GLOBAL` are already nulled, so repo-local `.git/config` is the only competing
# source. We blank `proxy` and force `sslVerify=true` — no proxy plus verified
# TLS leaves no interception point, so the PAT can't be captured — and blank
# `credential.helper` (a forced 401 would otherwise run a repo-configured
# `!cmd` helper with the PAT still in the environment). We deliberately do NOT
# touch `sslCAInfo`/`sslCAPath`: blanking them makes libcurl fail with "error
# setting certificate verify locations" before any TLS, breaking every real
# github fetch; and with the proxy neutralized an attacker-set CA only yields a
# self-inflicted fetch failure, never interception. `extraHeader` is blanked
# only at the base — the real header is injected right after via `--config-env`,
# and a path-scoped blank would strip it (auth failure).
_GIT_SMART_HTTP_PATHS = ("", "/info", "/info/refs", "/git-upload-pack", "/git-receive-pack")


def _token_url_safe_config(auth_url: str | None) -> list[str]:
    if auth_url is None:
        return []
    items: list[str] = []
    for suffix in _GIT_SMART_HTTP_PATHS:
        scoped = f"{auth_url}{suffix}"
        items += [
            f"http.{scoped}.proxy=",
            f"http.{scoped}.sslVerify=true",
            f"credential.{scoped}.helper=",
        ]
    items.append(f"http.{auth_url}.extraHeader=")
    return items


def _http_extra_header_key(auth_url: str | None) -> str:
    if auth_url is None:
        return "http.extraHeader"
    return f"http.{auth_url}.extraHeader"


_CRED_URL = re.compile(r"(https?://)([^:/@\s]+):([^@/\s]+)@")
_BAD_OBJECT_REF_RE = re.compile(
    r"(?:fatal: bad object (?P<bad>refs/[^\s]+)|error: (?P<invalid>refs/[^\s]+) does not point to a valid object!)"
)
_FETCH_PRUNE_REPAIR_ATTEMPTS = 8

_SHARED_OMP_GID = 2000
_AGENT_HOME = Path("/srv/agent-home")


def _slot_permissions_active(slot_uid: int | None) -> bool:
    return slot_uid is not None and platform.system() == "Linux" and os.geteuid() == 0


def _slot_subprocess_kwargs(slot_uid: int | None) -> dict[str, Any]:
    if not _slot_permissions_active(slot_uid):
        return {}
    assert slot_uid is not None
    return {"user": slot_uid, "group": slot_uid, "extra_groups": [_SHARED_OMP_GID], "umask": 0o002}


def _append_safe_directory(env: dict[str, str], repo_dir: Path) -> None:
    count = int(env.get("GIT_CONFIG_COUNT", "0"))
    env[f"GIT_CONFIG_KEY_{count}"] = "safe.directory"
    env[f"GIT_CONFIG_VALUE_{count}"] = str(repo_dir)
    env["GIT_CONFIG_COUNT"] = str(count + 1)


def _local_remote_safe_directory(remote_url: str, *, cwd: Path) -> Path | None:
    """Return a local filesystem remote path that git may need whitelisted."""
    raw = remote_url.strip()
    if not raw:
        return None
    if raw.startswith("file://"):
        parsed = urlparse(raw)
        if parsed.netloc not in ("", "localhost"):
            return None
        return Path(parsed.path)
    if "://" in raw or re.match(r"^[^/\\s]+:", raw):
        return None
    path = Path(raw)
    return path if path.is_absolute() else (cwd / path).resolve()


def redact_credentials(text: str | None) -> str:
    """Strip `user:password@` from any embedded URL in `text`."""
    if not text:
        return text or ""
    return _CRED_URL.sub(r"\1***@", text)


def _redacted_cmd(cmd: list[str]) -> list[str]:
    return [redact_credentials(part) for part in cmd]


class GitCommandError(RuntimeError):
    """Wraps a failed git subprocess with credentials redacted from argv and stderr."""

    def __init__(self, cmd: list[str], returncode: int, stdout: str, stderr: str) -> None:
        self.returncode = returncode
        self.stdout = redact_credentials(stdout)
        self.stderr = redact_credentials(stderr)
        self.cmd = _redacted_cmd(cmd)
        msg = self.stderr.strip() or self.stdout.strip() or f"exit {returncode}"
        super().__init__(f"git {' '.join(self.cmd[1:])} failed: {msg}")


def _basic_auth_header(token: str) -> str:
    """Build the `Authorization: Basic …` header value for a PAT.

    GitHub accepts `x-access-token:<PAT>` over HTTPS Basic auth; that form
    works for fine-grained tokens, classic PATs, and GitHub App installation
    tokens alike.
    """
    raw = f"x-access-token:{token}".encode()
    return f"Authorization: Basic {base64.b64encode(raw).decode('ascii')}"


_DEFAULT_GIT_TIMEOUT_SECONDS = 120.0
"""Hard wall-clock cap on any one `git` invocation. Overridable per-call.

A hung child (auth prompt, network stall, server-side packfile generation
that never finishes) MUST NOT pin the calling thread forever — especially
when the gh-proxy invokes `_run_git` from an executor and bounds its OWN
wait via `asyncio.wait_for`. The asyncio bound returns control to the
event loop, but only this `timeout=` + kill below frees the OS process.
"""


def _run_git(
    args: list[str],
    *,
    cwd: Path | None,
    token: str | None,
    auth_url: str | None = None,
    extra_env: Mapping[str, str] | None = None,
    safe_directory: Path | None = None,
    user: int | None = None,
    group: int | None = None,
    extra_groups: list[int] | tuple[int, ...] | None = None,
    umask: int | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run `git <args>` with optional PAT injection via `--config-env`.

    When `auth_url` is supplied, the PAT header is scoped to that exact
    HTTPS URL (`http.<url>.extraHeader`) and git is restricted to the HTTPS
    transport. That keeps a token-bearing invocation from handing the header
    to another host, following `url.*.insteadOf` to `ext::`/ssh/file helpers,
    or running workspace hooks with the token in the environment.

    A returncode of 0 returns the populated `CompletedProcess`. Non-zero exit
    returns the same shape; callers either `_check` it or inspect manually
    (e.g. when probing for ref existence). Stdout/stderr are always
    credential-redacted before being returned.
    """
    env = _git_subprocess_env()
    if user is not None and _AGENT_HOME.is_dir():
        env["HOME"] = str(_AGENT_HOME)
    if extra_env:
        env.update(extra_env)
    if safe_directory is not None:
        _append_safe_directory(env, safe_directory)

    cmd: list[str] = ["git", "-c", "protocol.ext.allow=never"]
    if token:
        env[AUTH_ENV_VAR] = _basic_auth_header(token)
        if auth_url is not None:
            env["GIT_ALLOW_PROTOCOL"] = _TOKEN_ALLOWED_PROTOCOLS
            env["GIT_CONFIG_NOSYSTEM"] = "1"
            env["GIT_CONFIG_SYSTEM"] = os.devnull
            env["GIT_CONFIG_GLOBAL"] = os.devnull
            for item in [*_TOKEN_SAFE_CONFIG, *_token_url_safe_config(auth_url)]:
                cmd.extend(["-c", item])
        cmd.extend(["--config-env", f"{_http_extra_header_key(auth_url)}={AUTH_ENV_VAR}"])
    cmd.extend(args)
    log.debug("git", extra={"cmd": _redacted_cmd(cmd), "cwd": str(cwd) if cwd else None})
    effective_timeout = _DEFAULT_GIT_TIMEOUT_SECONDS if timeout is None else timeout
    subprocess_kwargs: dict[str, Any] = {}
    if user is not None:
        subprocess_kwargs["user"] = user
    if group is not None:
        subprocess_kwargs["group"] = group
    if extra_groups is not None:
        subprocess_kwargs["extra_groups"] = extra_groups
    if umask is not None:
        subprocess_kwargs["umask"] = umask
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=effective_timeout,
            **subprocess_kwargs,
        )
    except subprocess.TimeoutExpired as exc:
        # `subprocess.run` already kills the direct child when the timeout
        # fires, but we explicitly re-raise as `GitCommandError` so callers
        # don't have to special-case `TimeoutExpired` alongside the regular
        # non-zero-exit error path. 124 mirrors GNU `timeout`.
        stdout = redact_credentials(exc.stdout or "") if isinstance(exc.stdout, str) else ""
        stderr_msg = f"git timed out after {effective_timeout:.0f}s: {' '.join(_redacted_cmd(cmd))}"
        raise GitCommandError(cmd, 124, stdout, stderr_msg) from exc
    if proc.stdout:
        proc.stdout = redact_credentials(proc.stdout)
    if proc.stderr:
        proc.stderr = redact_credentials(proc.stderr)
    return proc


def _check(proc: subprocess.CompletedProcess[str], cmd: list[str]) -> subprocess.CompletedProcess[str]:
    if proc.returncode != 0:
        raise GitCommandError(cmd, proc.returncode, proc.stdout, proc.stderr)
    return proc


def _git_dir(repo_dir: Path) -> Path | None:
    dot_git = repo_dir / ".git"
    if dot_git.is_dir():
        return dot_git
    if dot_git.is_file():
        try:
            text = dot_git.read_text(encoding="utf-8").strip()
        except OSError:
            return None
        prefix = "gitdir:"
        if not text.startswith(prefix):
            return None
        git_dir = Path(text[len(prefix) :].strip())
        return git_dir if git_dir.is_absolute() else (repo_dir / git_dir).resolve()
    if (repo_dir / "HEAD").exists() and (repo_dir / "objects").is_dir():
        return repo_dir
    return None


def _resolve_alternate_path(objects_dir: Path, raw: str) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path
    return (objects_dir / path).resolve()


def _prune_missing_alternates(repo_dir: Path) -> bool:
    """Drop object alternates that point at directories no longer mounted.

    The bot never configures alternates for pool clones. If one leaks in from
    an external git invocation and points at a temp directory, every later
    fetch emits warnings and refs whose objects lived only there become
    unreadable. Removing the dead alternate lets the repair path below delete
    those broken refs and recover the pool without recloning it.
    """
    git_dir = _git_dir(repo_dir)
    if git_dir is None:
        return False
    objects_dir = git_dir / "objects"
    alternates = objects_dir / "info" / "alternates"
    try:
        lines = alternates.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return False

    kept: list[str] = []
    changed = False
    for line in lines:
        raw = line.strip()
        if not raw:
            changed = True
            continue
        if _resolve_alternate_path(objects_dir, raw).is_dir():
            kept.append(line)
        else:
            changed = True

    if not changed:
        return False
    try:
        if kept:
            alternates.write_text("\n".join(kept) + "\n", encoding="utf-8")
        else:
            alternates.unlink()
    except OSError as exc:
        log.warning("failed to prune missing git alternates", extra={"repo_dir": str(repo_dir), "error": str(exc)})
        return False
    log.warning("pruned missing git alternates", extra={"repo_dir": str(repo_dir)})
    return True


def _is_safe_ref_name(ref: str) -> bool:
    if not ref.startswith("refs/"):
        return False
    if any(ch in ref for ch in "\0\r\n\t "):
        return False
    return all(part not in ("", ".", "..") for part in ref.split("/"))


def _bad_refs_from_fetch_output(output: str) -> tuple[str, ...]:
    refs: list[str] = []
    seen: set[str] = set()
    for match in _BAD_OBJECT_REF_RE.finditer(output):
        ref = match.group("bad") or match.group("invalid") or ""
        if ref in seen or not _is_safe_ref_name(ref):
            continue
        seen.add(ref)
        refs.append(ref)
    return tuple(refs)


def _worktrees_holding_refs(repo_dir: Path, refs: tuple[str, ...]) -> dict[str, list[str]]:
    """Map each ref in ``refs`` to the worktree paths whose ``HEAD`` is on it.

    A worktree that has the soon-to-be-deleted branch checked out keeps a
    stale ``HEAD`` pointer after ``update-ref -d`` succeeds in the shared
    refs store. The next ``git fetch`` then re-reports the same "bad object"
    error because git inspects every worktree's ``HEAD`` for connectivity.
    Removing the offending worktree (or running ``git worktree remove
    --force`` on it) clears that pointer so the fetch can recover.
    """
    if not refs:
        return {}
    proc = _run_git(["worktree", "list", "--porcelain"], cwd=repo_dir, token=None)
    if proc.returncode != 0:
        return {}
    refs_set = set(refs)
    by_ref: dict[str, list[str]] = {}
    current: dict[str, str] = {}

    def _flush() -> None:
        branch = current.get("branch")
        path = current.get("worktree")
        if branch in refs_set and path:
            by_ref.setdefault(branch, []).append(path)

    for line in proc.stdout.splitlines():
        if not line.strip():
            _flush()
            current.clear()
            continue
        key, _, val = line.partition(" ")
        if key and val:
            current[key] = val
    _flush()
    return by_ref


def _remove_worktrees(repo_dir: Path, paths: list[str]) -> None:
    for path in paths:
        proc = _run_git(["worktree", "remove", "--force", path], cwd=repo_dir, token=None)
        if proc.returncode != 0:
            log.warning(
                "failed to remove worktree during fetch repair",
                extra={"repo_dir": str(repo_dir), "worktree": path, "stderr": proc.stderr[:500]},
            )
            continue
        log.warning(
            "removed worktree during fetch repair",
            extra={"repo_dir": str(repo_dir), "worktree": path},
        )
    if paths:
        _run_git(["worktree", "prune"], cwd=repo_dir, token=None)


def _delete_bad_refs(repo_dir: Path, output: str) -> bool:
    bad_refs = _bad_refs_from_fetch_output(output)
    if not bad_refs:
        return False
    holding = _worktrees_holding_refs(repo_dir, bad_refs)
    changed = False
    for ref in bad_refs:
        worktrees = holding.get(ref) or []
        if worktrees:
            _remove_worktrees(repo_dir, worktrees)
            changed = True
        proc = _run_git(["update-ref", "-d", ref], cwd=repo_dir, token=None)
        if proc.returncode == 0:
            changed = True
            log.warning(
                "deleted invalid git ref during fetch repair",
                extra={"repo_dir": str(repo_dir), "git_ref": ref},
            )
            continue
        log.warning(
            "failed to delete invalid git ref during fetch repair",
            extra={"repo_dir": str(repo_dir), "git_ref": ref, "stderr": proc.stderr[:500]},
        )
    return changed


def _repair_fetch_prune_failure(repo_dir: Path, output: str) -> bool:
    pruned_alternates = _prune_missing_alternates(repo_dir)
    deleted_refs = _delete_bad_refs(repo_dir, output)
    return pruned_alternates or deleted_refs


def _explicit_remote_env(remote_url: str | None, *, cwd: Path) -> dict[str, str] | None:
    if remote_url is None:
        return None
    local_remote = _local_remote_safe_directory(remote_url, cwd=cwd)
    if local_remote is None:
        return None
    env: dict[str, str] = {}
    _append_safe_directory(env, local_remote)
    return env


def _branch_refspec(ref: str) -> str:
    if ":" in ref or ref.startswith("refs/") and not ref.startswith("refs/heads/"):
        return ref
    branch = ref.removeprefix("refs/heads/")
    return f"+refs/heads/{branch}:refs/remotes/origin/{branch}"


# ---------- Public primitives ----------


def clone(
    target: Path,
    *,
    clone_url: str,
    default_branch: str,
    token: str | None,
    auth_url: str | None = None,
    safe_directory: Path | None = None,
) -> None:
    """Fresh `git clone --filter=blob:none` into `target`."""
    target.parent.mkdir(parents=True, exist_ok=True)
    args = [
        "clone",
        "--filter=blob:none",
        "--no-tags",
        "--branch",
        default_branch,
        clone_url,
        str(target),
    ]
    _check(_run_git(args, cwd=None, token=token, auth_url=auth_url, safe_directory=safe_directory), ["git", *args])


def fetch_prune(
    repo_dir: Path,
    *,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    safe_directory: Path | None = None,
) -> None:
    """Refresh `refs/remotes/origin/*` on the shared pool clone.

    When `remote_url` is supplied the fetch bypasses on-disk `origin` and uses
    an explicit branch refspec so checkout and push-lease logic still see
    fresh `refs/remotes/origin/*`.
    """
    _prune_missing_alternates(repo_dir)
    last_proc: subprocess.CompletedProcess[str] | None = None
    extra_env = _explicit_remote_env(remote_url, cwd=repo_dir)
    args = (
        ["fetch", "--prune", "origin"]
        if remote_url is None
        else [
            "fetch",
            "--prune",
            "--no-tags",
            "--filter=blob:none",
            remote_url,
            "+refs/heads/*:refs/remotes/origin/*",
        ]
    )
    for _ in range(_FETCH_PRUNE_REPAIR_ATTEMPTS):
        proc = _run_git(
            args,
            cwd=repo_dir,
            token=token,
            auth_url=auth_url,
            extra_env=extra_env,
            safe_directory=safe_directory,
        )
        if proc.returncode == 0:
            return
        last_proc = proc
        output = f"{proc.stderr}\n{proc.stdout}"
        if not _repair_fetch_prune_failure(repo_dir, output):
            _check(proc, ["git", *args])
    assert last_proc is not None
    _check(last_proc, ["git", *args])


def fetch_ref(
    repo_dir: Path,
    ref: str,
    *,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    safe_directory: Path | None = None,
) -> None:
    """Fetch ``<ref>`` from origin AND materialize every reachable blob locally.

    Callers invoke this immediately before a ``git worktree add`` / checkout
    that needs the working-tree contents, so the blobs MUST be present after
    this returns. ``<repo_dir>`` is typically a ``--filter=blob:none`` partial
    clone: a plain ``git fetch origin <ref>`` would inherit
    ``remote.origin.partialclonefilter`` from the pool, bringing the commit
    and tree but no blobs, leaving the subsequent ``worktree add`` to trigger
    a lazy promisor fetch — which in proxy-transport deployments has no PAT
    in the orchestrator process and dies with::

        fatal: could not read Username for 'https://github.com'
        fatal: could not fetch <sha> from promisor remote

    (oh-my-pi#1818). ``--refetch`` forces a fresh negotiation that ignores
    "we already have this commit", and ``--no-filter`` overrides the inherited
    filter for this one invocation without touching the on-disk config — so
    ``fetch_prune`` keeps its cheap blob-skipping semantics on the next pool
    refresh. Best-effort: a non-zero exit is logged and swallowed because the
    caller still attempts the checkout (and a stale-ref worktree add will
    surface a more actionable error than this fetch ever could).
    """
    remote = remote_url or "origin"
    args = ["fetch", "--refetch", "--no-filter", remote, _branch_refspec(ref) if remote_url else ref]
    proc = _run_git(
        args,
        cwd=repo_dir,
        token=token,
        auth_url=auth_url,
        extra_env=_explicit_remote_env(remote_url, cwd=repo_dir),
        safe_directory=safe_directory,
    )
    if proc.returncode != 0:
        log.debug(
            "fetch_ref non-fatal failure",
            extra={"ref": ref, "stderr": proc.stderr},
        )


def fetch_pr_head(
    repo_dir: Path,
    pr_number: int,
    *,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    safe_directory: Path | None = None,
) -> None:
    """Fetch ``refs/pull/<n>/head`` into FETCH_HEAD with all reachable blobs.

    Immediately followed by ``git worktree add --detach FETCH_HEAD`` for PR
    review checkouts. See :func:`fetch_ref` for why ``--refetch --no-filter``
    is required: without the blob backfill, the worktree-add triggers a
    promisor lazy fetch that fails under proxy-transport deployments
    (oh-my-pi#1818).
    """
    if pr_number <= 0:
        raise ValueError(f"invalid PR number: {pr_number!r}")
    remote = remote_url or "origin"
    ref = f"refs/pull/{pr_number}/head" if remote_url else f"pull/{pr_number}/head"
    args = ["fetch", "--refetch", "--no-filter", remote, ref]
    _check(
        _run_git(
            args,
            cwd=repo_dir,
            token=token,
            auth_url=auth_url,
            extra_env=_explicit_remote_env(remote_url, cwd=repo_dir),
            safe_directory=safe_directory,
        ),
        ["git", *args],
    )


@dataclass(slots=True, frozen=True)
class PushResult:
    head: str
    branch: str


@dataclass(slots=True, frozen=True)
class DirtyState:
    """Summary of the workspace's uncommitted + unpushed state.

    `uncommitted` counts entries from `git status --porcelain`. `unpushed`
    counts commits in `HEAD` not reachable from any `origin/*` ref — i.e.
    commits that would be lost if the workspace were thrown away. `summary`
    is a human-friendly multi-line description for embedding in a reminder
    prompt; empty when both counts are zero.
    """

    uncommitted: int
    unpushed: int
    summary: str

    @property
    def is_dirty(self) -> bool:
        return self.uncommitted > 0 or self.unpushed > 0


class HeadDriftError(GitCommandError):
    """Raised when `expected_head` no longer matches the current HEAD.

    Defends against an attacker landing a commit between the orchestrator's
    preflight gates and the actual push.
    """


def rev_parse_head(
    repo_dir: Path,
    *,
    safe_directory: Path | None = None,
    user: int | None = None,
    group: int | None = None,
    extra_groups: list[int] | tuple[int, ...] | None = None,
    umask: int | None = None,
) -> str:
    """Return the SHA of HEAD or raise GitCommandError."""
    args = ["rev-parse", "HEAD"]
    proc = _run_git(
        args,
        cwd=repo_dir,
        token=None,
        safe_directory=safe_directory,
        user=user,
        group=group,
        extra_groups=extra_groups,
        umask=umask,
    )
    if proc.returncode != 0:
        raise GitCommandError(["git", *args], proc.returncode, proc.stdout, proc.stderr)
    return proc.stdout.strip()


def inspect_dirty_state(
    repo_dir: Path,
    *,
    slot_uid: int | None = None,
    safe_directory: Path | None = None,
) -> DirtyState:
    """Probe the worktree at `repo_dir` for uncommitted/unpushed work.

    Returns a {@link DirtyState}. Errors from the underlying git invocations
    are swallowed — the caller treats "we couldn't tell" as clean so a broken
    git binary can't pin the agent in a reminder loop forever.
    """
    slot_kwargs = _slot_subprocess_kwargs(slot_uid)
    uncommitted = 0
    uncommitted_sample: list[str] = []
    status = _run_git(
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        cwd=repo_dir,
        token=None,
        safe_directory=safe_directory,
        **slot_kwargs,
    )
    if status.returncode == 0 and status.stdout.strip():
        lines = status.stdout.splitlines()
        uncommitted = len(lines)
        uncommitted_sample = lines[:10]

    unpushed = 0
    unpushed_sample: list[str] = []
    count = _run_git(
        ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"],
        cwd=repo_dir,
        token=None,
        safe_directory=safe_directory,
        **slot_kwargs,
    )
    if count.returncode == 0:
        try:
            unpushed = int(count.stdout.strip() or "0")
        except ValueError:
            unpushed = 0
    if unpushed > 0:
        log_proc = _run_git(
            ["log", f"--max-count={min(unpushed, 5)}", "--oneline", "HEAD", "--not", "--remotes=origin"],
            cwd=repo_dir,
            token=None,
            safe_directory=safe_directory,
            **slot_kwargs,
        )
        if log_proc.returncode == 0:
            unpushed_sample = [line for line in log_proc.stdout.splitlines() if line.strip()]

    if uncommitted == 0 and unpushed == 0:
        return DirtyState(uncommitted=0, unpushed=0, summary="")

    parts: list[str] = []
    if uncommitted:
        more = f"\n… and {uncommitted - len(uncommitted_sample)} more" if uncommitted > len(uncommitted_sample) else ""
        parts.append(f"Uncommitted changes ({uncommitted}):\n" + "\n".join(uncommitted_sample) + more)
    if unpushed:
        log_text = "\n".join(unpushed_sample) if unpushed_sample else "(no log available)"
        parts.append(f"Unpushed commits ({unpushed}):\n{log_text}")
    return DirtyState(uncommitted=uncommitted, unpushed=unpushed, summary="\n\n".join(parts))


def push(
    repo_dir: Path,
    *,
    branch: str,
    expected_head: str | None,
    token: str | None,
    remote_url: str | None = None,
    auth_url: str | None = None,
    slot_uid: int | None = None,
    safe_directory: Path | None = None,
) -> PushResult:
    """Push `HEAD` with a lease, optionally to an explicit remote URL.

    The lease is pinned to whatever SHA the local `refs/remotes/origin/<branch>`
    currently records — i.e. what the workspace last fetched. The push only
    succeeds if origin's `<branch>` still matches that SHA, so a parallel
    writer to the same ref (between our last fetch and this push) is detected
    and refused even when the push is a fast-forward of HEAD. For a brand-new
    branch the local remote-tracking ref is absent, so the lease expects "no
    ref on origin" (empty expected value).

    `--force-with-lease` (vs plain `--force`) lets us recover from local
    history rewrites (e.g. the agent doing `git commit --amend --reset-author
    --no-edit` to fix author identity) while still refusing the push if origin
    has moved since our last fetch — i.e. it never clobbers work the bot
    didn't see.

    When `expected_head` is supplied, this verifies the *local* HEAD matches
    before pushing — anything else means an unexpected commit raced in inside
    our own worktree between the orchestrator's preflight and this call, and
    the push is aborted with `HeadDriftError`. This is a separate concern from
    `--force-with-lease`, which compares against the remote ref.
    """
    slot_kwargs = _slot_subprocess_kwargs(slot_uid)
    git_safe_directory = safe_directory
    if git_safe_directory is None and slot_kwargs:
        git_safe_directory = repo_dir

    head = rev_parse_head(repo_dir, safe_directory=git_safe_directory, **slot_kwargs)
    if expected_head and head != expected_head:
        raise HeadDriftError(
            ["git", "push"],
            128,
            "",
            f"HEAD changed since preflight ({expected_head[:12]} → {head[:12]}); aborting push.",
        )
    # Probe the local remote-tracking ref. Missing → first push; we pin the
    # lease to the empty value so the push only succeeds if origin still has
    # no `<branch>`. Present → pin to that SHA.
    probe = _run_git(
        ["rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}"],
        cwd=repo_dir,
        token=None,
        safe_directory=git_safe_directory,
        **slot_kwargs,
    )
    expected_remote = probe.stdout.strip() if probe.returncode == 0 else ""
    if remote_url is None:
        push_extra_env: dict[str, str] | None = None
        origin = _run_git(
            ["remote", "get-url", "origin"], cwd=repo_dir, token=None, safe_directory=git_safe_directory, **slot_kwargs
        )
        if origin.returncode == 0:
            local_remote = _local_remote_safe_directory(origin.stdout, cwd=repo_dir)
            if local_remote is not None:
                push_extra_env = {}
                _append_safe_directory(push_extra_env, local_remote)
        destination = "origin"
        refspec = branch
        set_upstream = True
    else:
        push_extra_env = _explicit_remote_env(remote_url, cwd=repo_dir)
        destination = remote_url
        refspec = f"HEAD:refs/heads/{branch}"
        set_upstream = False
    lease = f"--force-with-lease=refs/heads/{branch}:{expected_remote}"
    args = ["push"]
    if token:
        args.append("--no-verify")
    args.append(lease)
    if set_upstream:
        args.append("--set-upstream")
    args.extend([destination, refspec])
    _check(
        _run_git(
            args,
            cwd=repo_dir,
            token=token,
            auth_url=auth_url,
            extra_env=push_extra_env,
            safe_directory=git_safe_directory,
            **slot_kwargs,
        ),
        ["git", *args],
    )
    if remote_url is not None:
        update = _run_git(
            ["update-ref", f"refs/remotes/origin/{branch}", head],
            cwd=repo_dir,
            token=None,
            safe_directory=git_safe_directory,
            **slot_kwargs,
        )
        if update.returncode != 0:
            log.warning(
                "failed to refresh remote-tracking ref after explicit-url push",
                extra={"repo_dir": str(repo_dir), "branch": branch, "stderr": update.stderr[:500]},
            )
    return PushResult(head=head, branch=branch)


__all__ = [
    "AUTH_ENV_VAR",
    "DirtyState",
    "GitCommandError",
    "HeadDriftError",
    "PushResult",
    "clone",
    "fetch_pr_head",
    "fetch_prune",
    "fetch_ref",
    "inspect_dirty_state",
    "push",
    "redact_credentials",
    "rev_parse_head",
]
