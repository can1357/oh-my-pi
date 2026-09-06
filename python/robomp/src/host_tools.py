"""Host tools exposed to the agent through `omp_rpc.host_tool`.

The agent uses these for any side effect that touches GitHub, the
reproduction transcript store, or the orchestrator's bookkeeping.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, NoReturn

from omp_rpc import HostTool, HostToolContext, RpcCommandError, host_tool

from robomp import persona
from robomp.config import Settings
from robomp.db import Database, IssueState, issue_key
from robomp.git_ops import GitCommandError, HeadDriftError
from robomp.github_backend import GitHubBackend
from robomp.github_client import GitHubError, IssueInfo, PullRequestFileInfo, RepoInfo
from robomp.issue_index import parse_search_query
from robomp.sandbox import (
    GitTransport,
    Workspace,
    _prepare_slot_runtime_env,
    _safe_directory_env,
    _share_git_metadata_with_slots,
    _slot_permissions_active,
    _slot_subprocess_kwargs,
    rename_workspace_branch,
    validate_branch_slug,
    workspace_key,
)

log = logging.getLogger(__name__)
_PRE_PR_FIX_COMMAND = ("bun", "run", "fix")
_PRE_PR_CHECK_COMMAND = ("bun", "check")
_PRE_PR_TEST_COMMAND = ("bun", "run", "test")
_BUN_INSTALL_COMMAND = ("bun", "install", "--frozen-lockfile", "--ignore-scripts")
_BUN_INSTALL_TIMEOUT_SECONDS = 300.0
_REPO_COMMAND_SCRUBBED_ENV_KEYS: tuple[str, ...] = (
    "FORGEJO_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "ROBOMP_REPLAY_TOKEN",
    "ROBOMP_GH_PROXY_HMAC_KEY",
)
_NEEDS_INFO_LABEL = "needs-info"
_AGENT_HOME = Path("/srv/agent-home")
_PRE_PR_FIX_TIMEOUT_SECONDS = 600.0
_PRE_PR_CHECK_TIMEOUT_SECONDS = 600.0
_PRE_PR_CHECK_MAX_OUTPUT = 12_000
# The suite is the slowest gate by an order of magnitude — CI splits this repo's
# run across five 20-25 minute jobs — so it gets its own budget rather than
# sharing the formatter/typecheck one.
_PRE_PR_TEST_TIMEOUT_SECONDS = 3600.0
_DIFF_HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


@dataclass(slots=True)
class AbortController:
    """Mutable handoff between the `abort_task` host tool and the worker.

    `signal()` is called from the host-tool thread to request an irrecoverable
    teardown of the omp subprocess. The worker pre-populates `stop` with a
    thread-safe terminator (the same one used for queue cancellation and the
    hard-timeout watchdog), and inspects `triggered` after `prompt_and_wait`
    unblocks to decide whether the resulting `RpcError` is an intentional
    abort (swallow, mark event `done`) vs an actual failure (propagate).
    """

    triggered: bool = False
    reason: str = ""
    stop: Callable[[], None] | None = None

    def signal(self, reason: str) -> None:
        # Idempotent. Only the first call records its reason; later calls are
        # silent no-ops so a retry inside the tool can't overwrite the
        # original diagnosis with a generic follow-up message.
        if self.triggered:
            return
        self.triggered = True
        self.reason = reason
        if self.stop is not None:
            self.stop()


@dataclass(slots=True, frozen=True)
class ReleaseToolContext:
    """Release identity and remote-drift snapshot for host tools."""

    repo: str
    tag: str
    version: str
    key: str
    expected_sha: str
    default_branch: str


@dataclass(slots=True, frozen=True)
class ToolBindings:
    """Per-task closure that the host tools capture."""

    db: Database
    github: GitHubBackend
    git_transport: GitTransport
    repo: RepoInfo
    issue: IssueInfo | None
    workspace: Workspace
    loop: asyncio.AbstractEventLoop
    author_name: str
    author_email: str
    settings: Settings | None = None
    # Number of the GitHub thread the inbound webhook arrived on. For an
    # issue comment this is the issue; for a PR conversation or review
    # comment it's the PR. `gh_post_comment` defaults its target here so
    # the agent's reply lands on the thread the human is actually reading.
    # `None` for tasks with no inbound thread (e.g. initial triage), in
    # which case the originating issue is used.
    inbound_thread_number: int | None = None
    # True iff the inbound thread is a pull request. Triage tools
    # (`classify_issue`, `set_issue_labels`) are not exposed on PR threads
    # — the originating issue has already been classified and the PR
    # itself does not carry triage labels.
    inbound_is_pr: bool = False
    # True for incoming-PR review tasks. Review tools require it; git push / PR
    # publication tools check block_git_push instead (separate flag so handle_review
    # can access review tools without blocking push).
    review_mode: bool = False
    # True when git push / PR publication should be refused (e.g. review_pr tasks).
    # Separated from review_mode because handle_review needs review tools but must
    # still be able to push fixes in response to inline review feedback.
    block_git_push: bool = False
    # Current task is driven by an allowlist/OWNER maintainer directive that
    # authorizes implementation. Gates first-PR creation on non-bug/doc issues.
    impl_authorized: bool = False
    slot_uid: int | None = None
    # Set by the worker before launching omp. Carries the abort-task signal
    # back out to the worker; `None` for unit tests that exercise tools
    # without a live RpcClient.
    abort: AbortController | None = None
    release: ReleaseToolContext | None = None

    @property
    def issue_key(self) -> str:
        if self.release is not None:
            return self.release.key
        issue = _require_issue(self)
        return issue_key(issue.repo, issue.number)

    @property
    def default_comment_number(self) -> int:
        issue = _require_issue(self)
        return self.inbound_thread_number if self.inbound_thread_number is not None else issue.number


def _run_coro(loop: asyncio.AbstractEventLoop, coro: Any) -> Any:
    """Block the agent thread until an async call completes on the worker loop."""
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result()


def _issue_needs_info(bindings: ToolBindings) -> bool:
    row = bindings.db.get_issue(bindings.issue_key)
    return row is not None and row.state == "needs_info"


def _optional_label_error(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"


def _remove_needs_info_label(bindings: ToolBindings) -> bool:
    try:
        _run_coro(
            bindings.loop,
            bindings.github.remove_issue_label(
                bindings.repo.full_name, _require_issue(bindings).number, _NEEDS_INFO_LABEL
            ),
        )
    except GitHubError as exc:
        if exc.status == 404:
            return True
        log.warning("needs-info label cleanup failed", extra={"issue": bindings.issue_key, "err": str(exc)})
        return False
    except Exception as exc:  # noqa: BLE001 - best-effort optional label cleanup
        log.warning(
            "needs-info label cleanup failed",
            extra={"issue": bindings.issue_key, "err": _optional_label_error(exc)},
        )
        return False
    return True


def _advance_needs_info(bindings: ToolBindings, state: IssueState) -> bool:
    if not _issue_needs_info(bindings):
        return False
    label_cleared = _remove_needs_info_label(bindings)
    bindings.db.set_issue_state(bindings.issue_key, state)
    return label_cleared


def _audit(
    bindings: ToolBindings, name: str, args: Mapping[str, Any], result: Any | None = None, error: str | None = None
) -> None:
    bindings.db.log_tool_call(
        issue_key=bindings.issue_key,
        tool=name,
        args=args,
        result=result if isinstance(result, Mapping) else ({"value": result} if result is not None else None),
        error=error,
    )


def _raise_command(message: str) -> NoReturn:
    raise RpcCommandError(message, error={"message": message})


def _require_issue(bindings: ToolBindings) -> IssueInfo:
    if bindings.issue is None:
        _raise_command("this tool requires issue context")
    return bindings.issue


def _require_release(bindings: ToolBindings) -> ReleaseToolContext:
    if bindings.release is None:
        _raise_command("this tool requires release context")
    return bindings.release


def _git_identity_env(author_name: str, author_email: str) -> dict[str, str]:
    """Environment forcing agent git commits to use the configured bot identity."""
    return {
        "GIT_AUTHOR_NAME": author_name,
        "GIT_AUTHOR_EMAIL": author_email,
        "GIT_COMMITTER_NAME": author_name,
        "GIT_COMMITTER_EMAIL": author_email,
    }


def _repo_command_env(bindings: ToolBindings) -> dict[str, str]:
    """Environment for repo-owned commands (`bun`, formatter, local git).

    These commands execute code from the checked-out repository, so they must
    not inherit GitHub credentials from the orchestrator. They also need the
    exact same HOME/XDG/TMP/Bun cache paths as the agent process; otherwise
    host-side pre-publish gates validate a different machine than the agent saw.
    """
    env = os.environ.copy()
    for key in _REPO_COMMAND_SCRUBBED_ENV_KEYS:
        env[key] = ""
    if _AGENT_HOME.is_dir():
        env["HOME"] = str(_AGENT_HOME)
    env.update(_prepare_slot_runtime_env(bindings.workspace, bindings.slot_uid))
    env.update(_safe_directory_env(bindings.workspace.repo_dir))
    env.update(_git_identity_env(bindings.author_name, bindings.author_email))
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _run_repo_command(
    bindings: ToolBindings,
    cmd: list[str] | tuple[str, ...],
    *,
    timeout: float | None = None,
    extra_env: Mapping[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    """Run a repo-local command with agent-equivalent permissions and env."""
    env = _repo_command_env(bindings)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        list(cmd),
        cwd=str(bindings.workspace.repo_dir),
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
        **_slot_subprocess_kwargs(bindings.slot_uid),
    )


def _has_bun_script(repo_dir: Path, name: str) -> bool:
    """Return True iff `package.json` defines a `scripts.<name>` entry.

    A malformed or unreadable `package.json` is treated as "present" so the
    repository-native error surfaces from `bun` instead of being silently
    swallowed here.
    """
    package_json = repo_dir / "package.json"
    if not package_json.is_file():
        return False
    try:
        package = json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return True
    if not isinstance(package, Mapping):
        return True
    scripts = package.get("scripts")
    return isinstance(scripts, Mapping) and isinstance(scripts.get(name), str)


def _format_process_output(stdout: Any, stderr: Any) -> str:
    parts: list[str] = []
    for stream in (stdout, stderr):
        if isinstance(stream, bytes):
            text = stream.decode(errors="replace")
        elif isinstance(stream, str):
            text = stream
        elif stream is None:
            continue
        else:
            text = str(stream)
        text = text.strip()
        if text:
            parts.append(text)
    output = "\n".join(parts)
    if not output:
        return "(no output)"
    if len(output) <= _PRE_PR_CHECK_MAX_OUTPUT:
        return output
    return (
        f"... output truncated to last {_PRE_PR_CHECK_MAX_OUTPUT} characters ...\n{output[-_PRE_PR_CHECK_MAX_OUTPUT:]}"
    )


def ensure_workspace_dependencies(bindings: ToolBindings) -> None:
    """Bootstrap ``node_modules`` so the agent can resolve workspace packages.

    A per-issue worktree is a bare source checkout (``git worktree add`` off
    the shared clone pool): it has the repo's ``package.json``/``bun.lock`` but
    no ``node_modules``. With bun's ``hoisted`` linker the workspace links
    (``@oh-my-pi/pi-*``) only exist after an install, so without one any
    ``bun test``/``bun check`` the agent runs fails instantly with "Cannot find
    package" — the agent then reports it could not verify. We install before
    the agent starts, mirroring how the natives cache pre-populates ``.node``
    artifacts. The links resolve into *this* worktree's ``packages/*`` (not the
    orchestrator's read-only ``/work/pi``), so tests exercise the PR's edited
    source.

    ``--frozen-lockfile`` keeps the lockfile pristine (no spurious diff for the
    agent to commit) and ``--ignore-scripts`` skips lifecycle scripts so an
    untrusted PR's ``postinstall``/``prepare`` cannot execute as the slot and
    the cached native build is not redone. Runs with the same scrubbed,
    slot-owned env as the other repo-owned bun commands (``bun run fix`` /
    ``bun check``).

    Skips non-bun repos. Otherwise runs unconditionally on every launch
    (including ``--continue`` resumes): a frozen install verifies an intact
    tree in ~20ms and re-links anything missing, so a previous install that
    timed out or crashed half-way self-heals instead of being skipped forever
    on a mere ``node_modules/`` directory existing. Best-effort: any failure
    (offline, or a PR that bumped deps so the frozen lockfile is stale) is
    logged and swallowed — the agent can still install itself or report the gap.
    """
    repo_dir = bindings.workspace.repo_dir
    if not (repo_dir / "package.json").is_file() or not (repo_dir / "bun.lock").is_file():
        return
    try:
        proc = _run_repo_command(bindings, _BUN_INSTALL_COMMAND, timeout=_BUN_INSTALL_TIMEOUT_SECONDS)
    except FileNotFoundError:
        log.warning("bun_install bootstrap skipped: bun not on PATH", extra={"issue": bindings.issue_key})
        return
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("bun_install bootstrap failed", extra={"issue": bindings.issue_key, "err": str(exc)})
        return
    if proc.returncode != 0:
        log.warning(
            "bun_install bootstrap nonzero exit",
            extra={
                "issue": bindings.issue_key,
                "code": proc.returncode,
                "output": _format_process_output(proc.stdout, proc.stderr),
            },
        )
        return
    log.info("bun_install bootstrap ok", extra={"issue": bindings.issue_key})


def _run_pre_publish_bun_fix(
    bindings: ToolBindings,
    args: Mapping[str, Any],
    *,
    tool_name: str,
    stage: str,
    skip_checks: bool = False,
) -> None:
    """Run `bun run fix` then amend any working-tree diff into HEAD.

    Silently no-ops when the repository does not define a `scripts.fix`
    entry. Anything the formatter touches gets amended into the agent's HEAD
    commit so the downstream cleanliness gate sees a pristine worktree
    without littering PR history with standalone `style:` commits. Amending
    an already-pushed HEAD is safe: the push transport uses
    `--force-with-lease`, which exists precisely to recover from local
    history rewrites. When there is no commit that may safely absorb the
    diff — HEAD sits on `origin/<base>` (pre-existing formatter drift) or is
    foreign-authored — the tool refuses with instructions instead of
    guessing.

    `tool_name` is the host tool calling this (audit attribution).
    `stage` is the human-readable verb used in error wording — "open PR"
    when called from `gh_open_pr`, "push" when called from `gh_push_branch`.

    `skip_checks` is the agent-supplied escape hatch: when True, the
    formatter is NOT invoked and any post-fix commit is skipped, so a
    broken-formatter situation on `main` (unrelated to the agent's diff)
    doesn't strand the push forever. The dirty-tree gate still runs — we
    never let uncommitted changes leak into a remote ref.
    """
    if not _has_bun_script(bindings.workspace.repo_dir, "fix"):
        return
    # Dirty-tree gate BEFORE the formatter so any pre-existing uncommitted
    # edit isn't silently swept into the formatter amend by the
    # `git add -A` below. The agent owns the worktree end-to-end; any diff
    # not already in a commit is a workflow bug it must resolve before we
    # mutate the tree further.
    pre_status = _run_repo_command(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"])
    if pre_status.stdout.strip():
        dirty = "\n  ".join(pre_status.stdout.strip().splitlines())
        msg = (
            f"refusing to {stage}: dirty worktree before `bun run fix`.\n  "
            f"{dirty}\n"
            "Commit (or `git stash`) every change before invoking the formatter — "
            "anything left uncommitted would be amended into your HEAD commit "
            "and silently land in the PR."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    if skip_checks:
        _audit(
            bindings,
            tool_name,
            args,
            result={"skipped": "bun_run_fix", "reason": "skip_checks=true"},
        )
        return
    try:
        proc = _run_repo_command(bindings, _PRE_PR_FIX_COMMAND, timeout=_PRE_PR_FIX_TIMEOUT_SECONDS)
    except FileNotFoundError:
        msg = f"refusing to {stage}: `bun run fix` is required before {stage}, but `bun` is not on PATH."
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    except subprocess.TimeoutExpired as exc:
        output = _format_process_output(exc.stdout, exc.stderr)
        msg = (
            f"refusing to {stage}: `bun run fix` timed out before {stage}.\n"
            f"{output}\n\n"
            f"Investigate the hang, rerun the formatter, commit any resulting changes, "
            f"and retry."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    if proc.returncode != 0:
        output = _format_process_output(proc.stdout, proc.stderr)
        msg = (
            f"refusing to {stage}: `bun run fix` failed before {stage} (exit {proc.returncode}).\n"
            f"{output}\n\n"
            f"Resolve the formatter failure, rerun `bun run fix` successfully, commit any "
            f"resulting changes, and retry."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)

    status = _run_repo_command(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"])
    if not status.stdout.strip():
        return

    # The formatter produced a diff. Fold it into the agent's HEAD commit —
    # but only when HEAD is a bot-authored commit not already on the base
    # branch. Amending a commit `origin/<base>` contains would rewrite
    # shared history; amending a foreign-authored commit would bury our
    # diff in someone else's work.
    base = bindings.repo.default_branch
    ahead = _run_repo_command(bindings, ["git", "rev-list", "-n", "1", f"origin/{base}..HEAD"])
    if ahead.returncode != 0 or not ahead.stdout.strip():
        msg = (
            f"refusing to {stage}: `bun run fix` changed files, but there is no commit of "
            f"yours to fold them into — the checkout matches `origin/{base}`, so the "
            f"formatter drift pre-exists on `{base}`. Inspect with `git status` / `git diff`; "
            "either commit the formatter output yourself or discard it "
            "(`git checkout -- . && git clean -fd`) and retry with `skip_checks=true`, "
            "documenting the bypass."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    head_identity = _run_repo_command(bindings, ["git", "log", "-1", "--format=%an%x1f%ae", "HEAD"])
    if head_identity.returncode != 0 or head_identity.stdout.strip("\n").split("\x1f") != [
        bindings.author_name,
        bindings.author_email,
    ]:
        author = head_identity.stdout.strip("\n").replace("\x1f", " <") + ">"
        msg = (
            f"refusing to {stage}: `bun run fix` changed files, but HEAD is authored by "
            f"{author} — refusing to fold the formatter diff into a foreign commit. "
            "Fix the identity first (`git commit --amend --reset-author --no-edit`) and retry."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)

    add = _run_repo_command(bindings, ["git", "add", "-A"])
    if add.returncode != 0:
        err = (add.stderr or add.stdout).strip()
        msg = f"refusing to {stage}: `git add -A` failed after `bun run fix`: {err}"
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    commit = _run_repo_command(bindings, ["git", "commit", "--amend", "--no-edit"])
    if commit.returncode != 0:
        err = (commit.stderr or commit.stdout).strip()
        msg = f"refusing to {stage}: failed to amend `bun run fix` changes into HEAD: {err}"
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)


def _run_pre_publish_bun_check(
    bindings: ToolBindings,
    args: Mapping[str, Any],
    *,
    tool_name: str,
    stage: str,
    skip_checks: bool = False,
) -> None:
    """Run `bun check` before publishing. When `skip_checks=True` the check
    is not invoked — used to escape pre-existing breakage on `main` that
    the agent's diff did not cause.
    """
    if skip_checks:
        _audit(
            bindings,
            tool_name,
            args,
            result={"skipped": "bun_check", "reason": "skip_checks=true"},
        )
        return
    if not _has_bun_script(bindings.workspace.repo_dir, "check"):
        return
    try:
        proc = _run_repo_command(bindings, _PRE_PR_CHECK_COMMAND, timeout=_PRE_PR_CHECK_TIMEOUT_SECONDS)
    except FileNotFoundError:
        msg = f"refusing to {stage}: `bun check` is required before {stage}, but `bun` is not on PATH."
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    except subprocess.TimeoutExpired as exc:
        output = _format_process_output(exc.stdout, exc.stderr)
        msg = (
            f"refusing to {stage}: `bun check` timed out before {stage}.\n"
            f"{output}\n\n"
            f"Fix the check hang/failure, rerun `bun check`, commit any resulting changes, "
            f"and retry."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    if proc.returncode != 0:
        output = _format_process_output(proc.stdout, proc.stderr)
        msg = (
            f"refusing to {stage}: `bun check` failed before {stage} (exit {proc.returncode}).\n"
            f"{output}\n\n"
            f"Fix the reported failures, rerun `bun check` successfully, commit any resulting changes, "
            f"and retry."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)


def _run_pre_publish_bun_test(
    bindings: ToolBindings,
    args: Mapping[str, Any],
    *,
    tool_name: str,
    stage: str,
    skip_checks: bool = False,
) -> None:
    """Run `bun run test` before opening a PR.

    Same shape as the `bun check` gate: no-op when the repository defines no
    `scripts.test`, bypassed by `skip_checks=True` for breakage the agent's
    diff did not cause, and any failure comes back to the agent as a
    `RpcCommandError` instead of becoming a red PR.
    """
    if skip_checks:
        _audit(
            bindings,
            tool_name,
            args,
            result={"skipped": "bun_run_test", "reason": "skip_checks=true"},
        )
        return
    if not _has_bun_script(bindings.workspace.repo_dir, "test"):
        return
    try:
        proc = _run_repo_command(bindings, _PRE_PR_TEST_COMMAND, timeout=_PRE_PR_TEST_TIMEOUT_SECONDS)
    except FileNotFoundError:
        msg = f"refusing to {stage}: `bun run test` is required before {stage}, but `bun` is not on PATH."
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    except subprocess.TimeoutExpired as exc:
        output = _format_process_output(exc.stdout, exc.stderr)
        msg = (
            f"refusing to {stage}: `bun run test` timed out after "
            f"{_PRE_PR_TEST_TIMEOUT_SECONDS:.0f}s.\n"
            f"{output}\n\n"
            f"Investigate the hang (a test that never exits blocks every future run), "
            f"rerun `bun run test`, and retry."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    if proc.returncode != 0:
        output = _format_process_output(proc.stdout, proc.stderr)
        msg = (
            f"refusing to {stage}: `bun run test` failed before {stage} (exit {proc.returncode}).\n"
            f"{output}\n\n"
            f"Fix the failing tests, commit, and retry — no PR is opened while the suite is red."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)


_AUTOCLOSE_INELIGIBLE_STATES: frozenset[str] = frozenset({"closed", "merged", "needs_info", "abandoned"})


def _should_schedule_autoclose(bindings: ToolBindings, target_number: int) -> float | None:
    """Return the configured close window (hours) when this comment should
    schedule the question auto-close job: feature enabled, same issue,
    classified as `question`, and the issue is not already in a terminal or
    waiting-for-reporter state.
    """
    settings = bindings.settings
    if settings is None or not settings.question_autoclose_enabled:
        return None
    hours = float(settings.question_autoclose_hours)
    if hours <= 0:
        return None
    if target_number != _require_issue(bindings).number:
        return None
    if bindings.inbound_is_pr:
        return None
    row = bindings.db.get_issue(bindings.issue_key)
    if row is None or row.classification != "question":
        return None
    if row.state in _AUTOCLOSE_INELIGIBLE_STATES:
        return None
    return hours


def _schedule_autoclose(bindings: ToolBindings, *, comment_id: int, hours: float) -> str | None:
    """Insert (or refresh) a `pending_closures` row for the bot's answer.

    Failures are logged but never poisoned back to the agent — the human has
    already seen the comment and the orchestrator's bookkeeping shouldn't
    surface as a tool error.
    """
    close_at_dt = datetime.now(UTC) + timedelta(hours=hours)
    close_at = close_at_dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    try:
        bindings.db.upsert_pending_closure(
            issue_key=bindings.issue_key,
            repo=_require_issue(bindings).repo,
            number=_require_issue(bindings).number,
            comment_id=comment_id,
            issue_author=_require_issue(bindings).author,
            close_at=close_at,
        )
    except Exception as exc:  # pragma: no cover - defensive
        log.exception(
            "autoclose schedule failed",
            extra={"issue_key": bindings.issue_key, "comment_id": comment_id, "error": str(exc)},
        )
        return None
    return close_at


# ---------- gh_post_comment ----------
def _build_post_comment(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        body = args.get("body")
        if not isinstance(body, str) or not body.strip():
            _raise_command("gh_post_comment requires a non-empty 'body'.")
        target_number = bindings.default_comment_number
        if isinstance(args.get("number"), int):
            target_number = int(args["number"])
        # If this comment answers the originating question issue, append the
        # 👎-to-keep-open suffix so the auto-close scheduler has a reaction
        # surface to consult.
        schedule_close = _should_schedule_autoclose(bindings, target_number)
        body_to_post = body
        if schedule_close is not None:
            body_to_post = f"{body.rstrip()}\n\n{persona.question_autoclose_suffix(schedule_close)}"
        try:
            comment = _run_coro(
                bindings.loop,
                bindings.github.post_comment(bindings.repo.full_name, target_number, body_to_post),
            )
        except GitHubError as exc:
            _audit(bindings, "gh_post_comment", args, error=str(exc))
            _raise_command(f"GitHub rejected comment: {exc.status} {exc.message}")
        audit_result: dict[str, Any] = {"comment_id": comment.id}
        if schedule_close is not None:
            scheduled_at = _schedule_autoclose(
                bindings,
                comment_id=comment.id,
                hours=schedule_close,
            )
            if scheduled_at is not None:
                audit_result["scheduled_close_at"] = scheduled_at
        _audit(bindings, "gh_post_comment", args, result=audit_result)
        return f"comment posted: id={comment.id}"

    return host_tool(
        name="gh_post_comment",
        description=persona.host_tool_description("gh_post_comment"),
        parameters={
            "type": "object",
            "properties": {
                "body": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("gh_post_comment", "body"),
                },
                "number": {
                    "type": "integer",
                    "description": persona.host_tool_parameter_description("gh_post_comment", "number"),
                },
            },
            "required": ["body"],
            "additionalProperties": False,
        },
        execute=execute,
    )


def _repair_message_escapes(message: str) -> str | None:
    """Convert shell-literal ``\\n`` escapes in a commit message to newlines.

    Agents regularly run ``git commit -m 'subject\\n\\nbody'`` with single
    quotes, recording the two-character backslash-n sequence instead of a
    newline — the message then renders as one line of ``\\n``-littered text on
    GitHub. Escapes inside backtick code spans (`` `\\n` ``) are genuine
    content and are preserved.

    Returns the repaired message, or ``None`` when nothing needs repair.
    """
    if "\\n" not in message:
        return None
    parts = message.split("`")
    changed = False
    for i in range(0, len(parts), 2):  # even indexes sit outside code spans
        fixed = parts[i].replace("\\r\\n", "\n").replace("\\n", "\n")
        if fixed != parts[i]:
            parts[i] = fixed
            changed = True
    return "`".join(parts) if changed else None


def _repair_commit_message_escapes(bindings: ToolBindings, args: Mapping[str, Any], *, tool_name: str) -> None:
    """Rewrite unpushed commits whose messages carry literal ``\\n`` escapes.

    Rebuilds ``origin/<base>..HEAD`` with ``git commit-tree``, preserving
    every tree, parent topology, identity, and date — only messages change.
    Safe against already-pushed commits: the push transport uses
    ``--force-with-lease``. Once a broken message is detected the repair is
    mandatory — a git failure mid-rewrite refuses the push (the branch ref
    itself only ever moves via the compare-and-swap ``update-ref`` at the
    very end, so a refusal never leaves partial state).
    """

    def fail(step: str, proc: subprocess.CompletedProcess[str]) -> NoReturn:
        err = (proc.stderr or proc.stdout).strip() or f"exit {proc.returncode}"
        msg = (
            f"refusing to push: commit messages contain literal `\\n` escapes and the "
            f"automatic repair failed at `{step}`: {err}\n"
            "Reword the affected commits yourself (`git rebase -i origin/"
            + bindings.repo.default_branch
            + "`, real newlines via `git commit -F <file>` or multiple `-m` flags) and retry."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)

    base = bindings.repo.default_branch
    rev_list = _run_repo_command(bindings, ["git", "rev-list", "--reverse", f"origin/{base}..HEAD"])
    if rev_list.returncode != 0:
        return
    shas = rev_list.stdout.split()
    if not shas:
        return
    messages: dict[str, str] = {}
    repaired: list[str] = []
    for sha in shas:
        show = _run_repo_command(bindings, ["git", "log", "-1", "--format=%B", sha])
        if show.returncode != 0:
            if repaired:
                fail("git log", show)
            return
        message = show.stdout
        fixed = _repair_message_escapes(message)
        if fixed is not None:
            message = fixed
            repaired.append(sha)
        messages[sha] = message
    if not repaired:
        return

    needs_fix = set(repaired)
    rewritten: dict[str, str] = {}
    for sha in shas:
        meta = _run_repo_command(
            bindings,
            ["git", "log", "-1", "--format=%T%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI", sha],
        )
        if meta.returncode != 0:
            fail("git log", meta)
        fields = meta.stdout.strip("\n").split("\x1f")
        if len(fields) != 8:
            fail("git log", meta)
        tree, parents_raw, a_name, a_email, a_date, c_name, c_email, c_date = fields
        parents_old = parents_raw.split()
        parents_new = [rewritten.get(p, p) for p in parents_old]
        if sha not in needs_fix and parents_new == parents_old:
            rewritten[sha] = sha
            continue
        cmd = ["git", "commit-tree", tree]
        for parent in parents_new:
            cmd += ["-p", parent]
        cmd += ["-m", messages[sha].rstrip("\n")]
        made = _run_repo_command(
            bindings,
            cmd,
            extra_env={
                "GIT_AUTHOR_NAME": a_name,
                "GIT_AUTHOR_EMAIL": a_email,
                "GIT_AUTHOR_DATE": a_date,
                "GIT_COMMITTER_NAME": c_name,
                "GIT_COMMITTER_EMAIL": c_email,
                "GIT_COMMITTER_DATE": c_date,
            },
        )
        if made.returncode != 0 or not made.stdout.strip():
            fail("git commit-tree", made)
        rewritten[sha] = made.stdout.strip()

    old_head, new_head = shas[-1], rewritten[shas[-1]]
    update = _run_repo_command(
        bindings,
        ["git", "update-ref", "-m", "robomp: repaired commit message escapes", "HEAD", new_head, old_head],
    )
    if update.returncode != 0:
        fail("git update-ref", update)
    _audit(bindings, tool_name, args, result={"repaired_commit_messages": [sha[:12] for sha in repaired]})
    log.info(
        "repaired commit message escapes",
        extra={"issue": bindings.issue_key, "commits": [sha[:12] for sha in repaired]},
    )


def _guarded_push_branch(bindings: ToolBindings, args: Mapping[str, Any], tool_name: str, branch: str) -> str:
    if bindings.block_git_push:
        msg = "refusing to push: PR review worktrees are read-only."
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    if branch != bindings.workspace.branch:
        _raise_command(
            f"refusing to push: branch={branch!r} does not match workspace branch {bindings.workspace.branch!r}."
        )
    # Re-pin the configured identity right before push (cheap; idempotent).
    _run_repo_command(bindings, ["git", "config", "user.email", bindings.author_email])
    _run_repo_command(bindings, ["git", "config", "user.name", bindings.author_name])
    # Cosmetic repair BEFORE the head snapshot: commits whose messages carry
    # shell-literal `\n` escapes are rewritten in place (message-only).
    _repair_commit_message_escapes(bindings, args, tool_name=tool_name)
    repo_dir_path = bindings.workspace.repo_dir
    head_proc = _run_repo_command(bindings, ["git", "rev-parse", "HEAD"])
    if head_proc.returncode != 0:
        err = (head_proc.stderr or head_proc.stdout).strip() or f"exit {head_proc.returncode}"
        _audit(bindings, tool_name, args, error=err)
        _raise_command(f"git rev-parse failed: {err}")
    head_sha = head_proc.stdout.strip()

    # Identity gate: every commit between the base branch and HEAD must
    # carry the configured author. Refuse to push otherwise so the agent
    # fixes it (`git commit --amend --reset-author --no-edit`).
    base = bindings.repo.default_branch
    identities = _run_repo_command(
        bindings,
        ["git", "log", "--format=%H%x09%ae%x09%an", f"origin/{base}..HEAD"],
    )
    if identities.returncode != 0:
        err = (identities.stderr or identities.stdout).strip()
        msg = f"refusing to push: could not inspect commit authors for origin/{base}..HEAD: {err}"
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    offending: list[str] = []
    for line in (identities.stdout or "").strip().splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        sha, email, name = parts[0], parts[1], parts[2]
        if email != bindings.author_email or name != bindings.author_name:
            offending.append(f"{sha[:12]} {name} <{email}>")
    if offending:
        details = "\n  ".join(offending)
        msg = (
            "refusing to push: commit author identity mismatch. "
            f"Expected `{bindings.author_name} <{bindings.author_email}>`. "
            f"Offending commits:\n  {details}\n"
            "Amend each commit with `git commit --amend --reset-author --no-edit` "
            "(or rebase with `git rebase -i origin/" + base + " --exec "
            "'git commit --amend --reset-author --no-edit'`) and try again."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)

    # Working-tree cleanliness gate. Any uncommitted change (edits the agent
    # forgot to `git add && git commit`, files dropped by package managers, etc.)
    # would silently land in the PR review delta but not in the commit history.
    # Reject so the agent either commits or stashes them.
    status = _run_repo_command(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"])
    if status.stdout.strip():
        dirty = "\n  ".join(status.stdout.strip().splitlines())
        msg = (
            "refusing to push: working tree is dirty.\n  "
            f"{dirty}\n"
            "Commit (or `git stash`) every change before pushing — anything in the "
            "worktree that isn't in a commit won't appear in the PR."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)

    try:
        result = bindings.git_transport.push_branch(
            repo=bindings.repo.full_name,
            workspace_key=workspace_key(bindings.repo.full_name, _require_issue(bindings).number),
            repo_dir=repo_dir_path,
            branch=branch,
            expected_head=head_sha,
            slot_uid=bindings.slot_uid,
        )
    except HeadDriftError:
        msg = (
            "refusing to push: HEAD changed between preflight and push "
            "(another commit landed; rerun the gate by re-issuing the push)."
        )
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    except GitCommandError as exc:
        err = (exc.stderr or exc.stdout).strip() or f"exit {exc.returncode}"
        _audit(bindings, tool_name, args, error=err)
        _raise_command(f"git push failed: {err}")
    except GitHubError as exc:
        msg = f"gh-proxy rejected push: {exc.status} {exc.message}"
        _audit(bindings, tool_name, args, error=msg)
        _raise_command(msg)
    _share_git_metadata_with_slots(repo_dir_path, bindings.slot_uid)
    _audit(bindings, tool_name, args, result={"head": result.head, "branch": result.branch})
    return result.head


_NON_FAILURE_JOB_CONCLUSIONS = frozenset({"success", "skipped", "neutral"})


# ---------- release_ci_status ----------
def _build_release_ci_status(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        release = _require_release(bindings)
        try:
            runs = _run_coro(
                bindings.loop,
                bindings.github.list_workflow_runs(release.repo, head_sha=release.expected_sha),
            )
            rendered_runs: list[dict[str, Any]] = []
            for run in runs:
                jobs = _run_coro(
                    bindings.loop,
                    bindings.github.list_workflow_jobs(release.repo, run.id),
                )
                failed_jobs = [
                    {
                        "id": job.id,
                        "name": job.name,
                        "conclusion": job.conclusion,
                        "failed_steps": list(job.failed_steps),
                        "url": job.html_url,
                    }
                    for job in jobs
                    if job.conclusion not in _NON_FAILURE_JOB_CONCLUSIONS
                ]
                rendered_runs.append(
                    {
                        "id": run.id,
                        "name": run.name,
                        "status": run.status,
                        "conclusion": run.conclusion,
                        "url": run.html_url,
                        "failed_jobs": failed_jobs,
                    }
                )
        except GitHubError as exc:
            msg = f"GitHub Actions lookup failed: {exc.status} {exc.message}"
            _audit(bindings, "release_ci_status", args, error=msg)
            _raise_command(msg)
        result = {"sha": release.expected_sha, "runs": rendered_runs}
        _audit(bindings, "release_ci_status", args, result=result)
        return json.dumps(result)

    return host_tool(
        name="release_ci_status",
        description=persona.host_tool_description("release_ci_status"),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        execute=execute,
    )


# ---------- release_job_log ----------
def _build_release_job_log(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        release = _require_release(bindings)
        job_id = args.get("job_id")
        if not isinstance(job_id, int) or isinstance(job_id, bool):
            _raise_command("release_job_log requires an integer 'job_id'.")
        tail_raw = args.get("tail_lines", 200)
        if not isinstance(tail_raw, int) or isinstance(tail_raw, bool):
            _raise_command("release_job_log 'tail_lines' must be an integer.")
        tail_lines = max(1, min(tail_raw, 1000))
        try:
            log_tail = _run_coro(
                bindings.loop,
                bindings.github.get_job_log_tail(release.repo, job_id, tail_lines=tail_lines),
            )
        except GitHubError as exc:
            msg = f"GitHub Actions log lookup failed: {exc.status} {exc.message}"
            _audit(bindings, "release_job_log", args, error=msg)
            _raise_command(msg)
        _audit(
            bindings,
            "release_job_log",
            args,
            result={"job_id": job_id, "tail_lines": tail_lines, "returned_lines": len(log_tail.splitlines())},
        )
        return log_tail

    return host_tool(
        name="release_job_log",
        description=persona.host_tool_description("release_job_log"),
        parameters={
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "integer",
                    "description": persona.host_tool_parameter_description("release_job_log", "job_id"),
                },
                "tail_lines": {
                    "type": "integer",
                    "description": persona.host_tool_parameter_description("release_job_log", "tail_lines"),
                },
            },
            "required": ["job_id"],
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- release_retag ----------
def _build_release_retag(bindings: ToolBindings) -> HostTool[Any, Any]:
    def refuse(args: Mapping[str, Any], message: str) -> NoReturn:
        _audit(bindings, "release_retag", args, error=message)
        _raise_command(message)

    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> dict[str, Any]:
        release = _require_release(bindings)
        summary = args.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            _raise_command("release_retag requires a non-empty 'summary'.")
        summary = summary.strip()
        if bindings.workspace.branch != release.default_branch:
            refuse(
                args,
                "refusing to retag: workspace branch "
                f"{bindings.workspace.branch!r} does not match release branch {release.default_branch!r}.",
            )

        skip_checks = bool(args.get("skip_checks", False))
        _run_pre_publish_bun_fix(
            bindings,
            args,
            tool_name="release_retag",
            stage="retag",
            skip_checks=skip_checks,
        )
        _run_pre_publish_bun_check(
            bindings,
            args,
            tool_name="release_retag",
            stage="retag",
            skip_checks=skip_checks,
        )

        status = _run_repo_command(bindings, ["git", "status", "--porcelain", "--untracked-files=normal"])
        if status.returncode != 0:
            err = (status.stderr or status.stdout).strip() or f"exit {status.returncode}"
            refuse(args, f"refusing to retag: could not inspect working tree: {err}")
        if status.stdout.strip():
            dirty = "\n  ".join(status.stdout.strip().splitlines())
            refuse(
                args,
                "refusing to retag: working tree is dirty.\n  "
                f"{dirty}\n"
                "Commit (or `git stash`) every change before retagging.",
            )

        identities = _run_repo_command(
            bindings,
            ["git", "log", "--format=%H%x09%ae%x09%an", f"origin/{release.default_branch}..HEAD"],
        )
        if identities.returncode != 0:
            err = (identities.stderr or identities.stdout).strip() or f"exit {identities.returncode}"
            refuse(
                args,
                f"refusing to retag: could not inspect commit authors for origin/{release.default_branch}..HEAD: {err}",
            )
        offending: list[str] = []
        for line in identities.stdout.strip().splitlines():
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            sha, email, name = parts[0], parts[1], parts[2]
            if email != bindings.author_email or name != bindings.author_name:
                offending.append(f"{sha[:12]} {name} <{email}>")
        if offending:
            details = "\n  ".join(offending)
            refuse(
                args,
                "refusing to retag: commit author identity mismatch. "
                f"Expected `{bindings.author_name} <{bindings.author_email}>`. "
                f"Offending commits:\n  {details}\n"
                "Amend each commit with `git commit --amend --reset-author --no-edit` "
                f"(or rebase with `git rebase -i origin/{release.default_branch} --exec "
                "'git commit --amend --reset-author --no-edit'`) and try again.",
            )

        subject_proc = _run_repo_command(bindings, ["git", "log", "-1", "--format=%s"])
        if subject_proc.returncode != 0:
            err = (subject_proc.stderr or subject_proc.stdout).strip() or f"exit {subject_proc.returncode}"
            refuse(args, f"refusing to retag: could not inspect HEAD subject: {err}")
        prefix = bindings.settings.release_commit_prefix if bindings.settings is not None else "chore: bump version to "
        if not subject_proc.stdout.strip().startswith(prefix):
            refuse(
                args,
                f"refusing to retag: HEAD subject must start with {prefix!r} — "
                "CI's release concurrency group keys on it (#2564); reword the body, not the subject.",
            )

        head_proc = _run_repo_command(bindings, ["git", "rev-parse", "HEAD"])
        if head_proc.returncode != 0:
            err = (head_proc.stderr or head_proc.stdout).strip() or f"exit {head_proc.returncode}"
            refuse(args, f"refusing to retag: git rev-parse failed: {err}")
        new_head = head_proc.stdout.strip()
        if new_head == release.expected_sha:
            refuse(args, "refusing to retag: HEAD still points at the failing release sha; commit the fix first.")

        try:
            remote_tag_sha = _run_coro(
                bindings.loop,
                bindings.github.get_tag_sha(release.repo, release.tag),
            )
        except GitHubError as exc:
            refuse(args, f"GitHub tag lookup failed: {exc.status} {exc.message}")
        if remote_tag_sha != release.expected_sha:
            refuse(args, "refusing to retag: tag moved remotely — a human intervened; aborting.")

        try:
            pushed = bindings.git_transport.push_release(
                repo=release.repo,
                workspace_key=workspace_key(release.repo, "release"),
                repo_dir=bindings.workspace.repo_dir,
                branch=release.default_branch,
                tag=release.tag,
                expected_head=new_head,
                slot_uid=bindings.slot_uid,
            )
        except HeadDriftError:
            refuse(
                args,
                "refusing to retag: HEAD changed between preflight and push "
                "(another commit landed; rerun the gate by re-issuing release_retag).",
            )
        except GitCommandError as exc:
            err = (exc.stderr or exc.stdout).strip() or f"exit {exc.returncode}"
            refuse(args, f"git push failed: {err}")
        except GitHubError as exc:
            refuse(args, f"gh-proxy rejected push: {exc.status} {exc.message}")

        _share_git_metadata_with_slots(bindings.workspace.repo_dir, bindings.slot_uid)
        row = bindings.db.get_release(release.key)
        if row is None:
            refuse(args, f"release state missing for {release.key}")
        bindings.db.set_release_sha(release.key, pushed.head)
        bindings.db.set_release_state(release.key, "awaiting_ci")
        result: dict[str, Any] = {
            "pushed": pushed.head,
            "tag": release.tag,
            "round": row.rounds,
        }
        _audit(bindings, "release_retag", args, result={**result, "summary": summary})
        return result

    return host_tool(
        name="release_retag",
        description=persona.host_tool_description("release_retag"),
        parameters={
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("release_retag", "summary"),
                },
                "skip_checks": {
                    "type": "boolean",
                    "description": persona.host_tool_parameter_description("release_retag", "skip_checks"),
                },
            },
            "required": ["summary"],
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- gh_push_branch ----------
def _build_push_branch(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        if bindings.block_git_push:
            msg = "refusing to push: PR review worktrees are read-only."
            _audit(bindings, "gh_push_branch", args, error=msg)
            _raise_command(msg)
        _enforce_impl_authorization(bindings, "gh_push_branch", args, action="push branch")
        branch = str(args.get("branch") or bindings.workspace.branch)
        skip = bool(args.get("skip_checks", False))
        # Same gate as gh_open_pr — formatter + check before bytes leave the
        # workstation, so CI doesn't blow up on a follow-up commit. The fix
        # pass auto-commits any formatter diff so the push includes it.
        # `skip_checks=true` bypasses the formatter/check (e.g. when `main`
        # itself is broken); dirty-tree gate still runs unconditionally.
        # The suite itself is gated at `gh_open_pr`, not here: a push is not
        # yet a PR, and running it on every intermediate push would cost an
        # hour each time.
        _run_pre_publish_bun_fix(bindings, args, tool_name="gh_push_branch", stage="push", skip_checks=skip)
        _run_pre_publish_bun_check(bindings, args, tool_name="gh_push_branch", stage="push", skip_checks=skip)
        head = _guarded_push_branch(bindings, args, "gh_push_branch", branch)
        suffix = " (pre-push checks skipped)" if skip else ""
        return f"pushed {branch} at {head[:12]} as {bindings.author_name} <{bindings.author_email}>{suffix}"

    return host_tool(
        name="gh_push_branch",
        description=persona.host_tool_description("gh_push_branch"),
        parameters={
            "type": "object",
            "properties": {
                "branch": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("gh_push_branch", "branch"),
                },
                "skip_checks": {
                    "type": "boolean",
                    "description": persona.host_tool_parameter_description("gh_push_branch", "skip_checks"),
                },
            },
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- gh_open_pr ----------
def _build_open_pr(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        if bindings.block_git_push:
            msg = "refusing to open PR: PR review tasks are read-only."
            _audit(bindings, "gh_open_pr", args, error=msg)
            _raise_command(msg)
        _enforce_impl_authorization(bindings, "gh_open_pr", args, action="open PR")
        title = args.get("title")
        body = args.get("body")
        if not isinstance(title, str) or not title.strip():
            _raise_command("gh_open_pr requires a non-empty 'title'.")
        if not isinstance(body, str) or not body.strip():
            _raise_command("gh_open_pr requires a non-empty 'body'.")
        for required in ("## Repro", "## Cause", "## Fix", "## Verification"):
            if required not in body:
                _raise_command(
                    f"PR body missing required section header {required!r}. "
                    "Follow the template in the system prompt verbatim."
                )
        # Auto-close keyword. GitHub closes the linked issue on merge only when
        # one of `Fixes / Closes / Resolves #<n>` is present in the PR body.
        n = _require_issue(bindings).number
        accepted = [f"{kw} #{n}" for kw in ("Fixes", "Closes", "Resolves", "fixes", "closes", "resolves")]
        if not any(form in body for form in accepted):
            _raise_command(
                f"PR body must include `Fixes #{n}` (or `Closes #{n}` / `Resolves #{n}`) so "
                "GitHub auto-closes the issue when the PR merges. Put it at the end of the "
                "Verification section per the template."
            )
        skip = bool(args.get("skip_checks", False))
        _run_pre_publish_bun_fix(bindings, args, tool_name="gh_open_pr", stage="open PR", skip_checks=skip)
        _run_pre_publish_bun_check(bindings, args, tool_name="gh_open_pr", stage="open PR", skip_checks=skip)
        # Last and slowest: the suite runs against the tree that is actually
        # published, after the formatter amend, so a red PR cannot be created.
        _run_pre_publish_bun_test(bindings, args, tool_name="gh_open_pr", stage="open PR", skip_checks=skip)
        # Make sure the branch is pushed (idempotent) using the same preflight as gh_push_branch.
        _guarded_push_branch(bindings, args, "gh_open_pr", bindings.workspace.branch)
        base = args.get("base") or bindings.repo.default_branch
        was_needs_info = _issue_needs_info(bindings)
        try:
            pr = _run_coro(
                bindings.loop,
                bindings.github.open_pull_request(
                    repo=bindings.repo.full_name,
                    head=bindings.workspace.branch,
                    base=str(base),
                    title=title,
                    body=body,
                    draft=bool(args.get("draft", False)),
                ),
            )
        except GitHubError as exc:
            _audit(bindings, "gh_open_pr", args, error=str(exc))
            _raise_command(f"GitHub rejected PR: {exc.status} {exc.message}")
        bindings.db.set_issue_pr(bindings.issue_key, pr.number)
        bindings.db.set_issue_state(bindings.issue_key, "opened")
        needs_info_label_cleared = _remove_needs_info_label(bindings) if was_needs_info else False
        artifact = bindings.workspace.artifacts_dir / "pr.json"
        artifact.write_text(
            json.dumps(
                {
                    "repo": pr.repo,
                    "number": pr.number,
                    "url": pr.html_url,
                    "head": pr.head_ref,
                    "base": pr.base_ref,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        result: dict[str, Any] = {"pr_number": pr.number, "url": pr.html_url}
        if needs_info_label_cleared:
            result["cleared_needs_info"] = True
        _audit(bindings, "gh_open_pr", args, result=result)
        return f"opened #{pr.number}: {pr.html_url}"

    return host_tool(
        name="gh_open_pr",
        description=persona.host_tool_description("gh_open_pr"),
        parameters={
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "body": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("gh_open_pr", "body"),
                },
                "base": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("gh_open_pr", "base"),
                },
                "draft": {"type": "boolean", "default": False},
                "skip_checks": {
                    "type": "boolean",
                    "description": persona.host_tool_parameter_description("gh_open_pr", "skip_checks"),
                },
            },
            "required": ["title", "body"],
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- gh_request_review ----------
def _build_request_review(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        reviewers = args.get("reviewers") or []
        assignees = args.get("assignees") or []
        if not isinstance(reviewers, list) or not isinstance(assignees, list):
            _raise_command("gh_request_review expects 'reviewers' and 'assignees' to be arrays of logins.")
        issue_row = bindings.db.get_issue(bindings.issue_key)
        pr_number = issue_row.pr_number if issue_row else None
        if pr_number is None:
            _raise_command("no PR recorded for this issue yet; call gh_open_pr first.")
        try:
            if reviewers:
                _run_coro(
                    bindings.loop,
                    bindings.github.request_reviewers(
                        repo=bindings.repo.full_name,
                        pr_number=pr_number,
                        reviewers=[str(r) for r in reviewers],
                    ),
                )
            if assignees:
                _run_coro(
                    bindings.loop,
                    bindings.github.add_assignees(
                        bindings.repo.full_name,
                        pr_number,
                        [str(a) for a in assignees],
                    ),
                )
        except GitHubError as exc:
            _audit(bindings, "gh_request_review", args, error=str(exc))
            _raise_command(f"GitHub rejected review request: {exc.status} {exc.message}")
        _audit(bindings, "gh_request_review", args, result={"pr": pr_number})
        return f"updated review/assignees on #{pr_number}"

    return host_tool(
        name="gh_request_review",
        description=persona.host_tool_description("gh_request_review"),
        parameters={
            "type": "object",
            "properties": {
                "reviewers": {"type": "array", "items": {"type": "string"}},
                "assignees": {"type": "array", "items": {"type": "string"}},
            },
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- repro_record ----------
def _build_repro_record(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        title = args.get("title")
        command = args.get("command")
        output = args.get("output")
        exit_code = args.get("exit_code")
        if not isinstance(title, str) or not title.strip():
            _raise_command("repro_record requires a non-empty 'title'.")
        if not isinstance(command, str) or not command.strip():
            _raise_command("repro_record requires a non-empty 'command'.")
        if not isinstance(output, str):
            _raise_command("repro_record requires 'output' (may be empty string).")
        if not isinstance(exit_code, int):
            _raise_command("repro_record requires an integer 'exit_code'.")
        bindings.workspace.repro_dir.mkdir(parents=True, exist_ok=True)
        slug = "".join(c if c.isalnum() else "-" for c in title.lower()).strip("-")[:48] or "repro"
        ts = int(time.time())
        target = bindings.workspace.repro_dir / f"{ts}-{slug}.md"
        target.write_text(
            f"# {title}\n\n"
            f"- exit_code: {exit_code}\n"
            f"- command:\n\n```\n{command}\n```\n\n"
            f"## Output\n\n```\n{output}\n```\n",
            encoding="utf-8",
        )
        # Single-ownership invariant: workspace files belong to the active
        # slot. The orchestrator (root) wrote this file directly, so hand it
        # over before the audit row lands so the agent can edit/delete it.
        if _slot_permissions_active(bindings.slot_uid):
            assert bindings.slot_uid is not None
            os.chown(target, bindings.slot_uid, bindings.slot_uid)
        result: dict[str, Any] = {"path": str(target.relative_to(bindings.workspace.root))}
        if _advance_needs_info(bindings, "reproducing"):
            result["cleared_needs_info"] = True
        _audit(bindings, "repro_record", args, result=result)
        return "recorded"

    return host_tool(
        name="repro_record",
        description=persona.host_tool_description("repro_record"),
        parameters={
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "command": {"type": "string"},
                "output": {"type": "string"},
                "exit_code": {"type": "integer"},
                "reproduced": {
                    "type": "boolean",
                    "description": persona.host_tool_parameter_description("repro_record", "reproduced"),
                },
            },
            "required": ["title", "command", "output", "exit_code"],
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- mark_unable_to_reproduce ----------
def _build_mark_unable(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        diagnosis = args.get("diagnosis")
        needed = args.get("info_needed")
        if not isinstance(diagnosis, str) or not diagnosis.strip():
            _raise_command("mark_unable_to_reproduce requires a 'diagnosis'.")
        if not isinstance(needed, str) or not needed.strip():
            _raise_command("mark_unable_to_reproduce requires 'info_needed' explaining what to ask for.")
        body = persona.unable_to_reproduce_comment(
            diagnosis=diagnosis,
            info_needed=needed,
        )
        try:
            comment = _run_coro(
                bindings.loop,
                bindings.github.post_comment(bindings.repo.full_name, _require_issue(bindings).number, body),
            )
        except GitHubError as exc:
            _audit(bindings, "mark_unable_to_reproduce", args, error=str(exc))
            _raise_command(f"GitHub rejected comment: {exc.status} {exc.message}")
        result: dict[str, Any] = {"comment_id": comment.id, "state": "needs_info"}
        try:
            labels = _run_coro(
                bindings.loop,
                bindings.github.add_issue_labels(
                    bindings.repo.full_name, _require_issue(bindings).number, [_NEEDS_INFO_LABEL]
                ),
            )
            result["labels"] = list(labels)
        except GitHubError as exc:
            # Some repos have not created the optional status label yet. The
            # durable behavior is the non-terminal sqlite state plus the visible
            # info-request comment, so label setup must not block resumption.
            log.warning("needs-info label failed", extra={"issue": bindings.issue_key, "err": str(exc)})
            result["label_error"] = f"{exc.status} {exc.message}"
        except Exception as exc:  # noqa: BLE001 - best-effort optional label setup
            error = _optional_label_error(exc)
            log.warning("needs-info label failed", extra={"issue": bindings.issue_key, "err": error})
            result["label_error"] = error
        bindings.db.set_issue_state(bindings.issue_key, "needs_info")
        _audit(bindings, "mark_unable_to_reproduce", args, result=result)
        return f"posted needs-info comment id={comment.id}"

    return host_tool(
        name="mark_unable_to_reproduce",
        description=persona.host_tool_description("mark_unable_to_reproduce"),
        parameters={
            "type": "object",
            "properties": {
                "diagnosis": {"type": "string"},
                "info_needed": {"type": "string"},
            },
            "required": ["diagnosis", "info_needed"],
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- abort_task ----------
def _build_abort_task(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        reason = args.get("reason")
        if not isinstance(reason, str) or not reason.strip():
            _raise_command("abort_task requires a non-empty 'reason' string.")
        reason = reason.strip()
        # Audit FIRST so the diagnosis is durable even if anything below
        # races against the imminent omp teardown.
        _audit(bindings, "abort_task", args, result={"reason": reason})
        log.warning(
            "task_aborted",
            extra={"issue": bindings.issue_key, "reason": reason},
        )
        if bindings.release is not None:
            bindings.db.set_release_state(bindings.release.key, "failed", error=reason)
        else:
            bindings.db.set_issue_state(bindings.issue_key, "abandoned")
        if bindings.abort is not None:
            bindings.abort.signal(reason)
        return "aborted"

    return host_tool(
        name="abort_task",
        description=persona.host_tool_description("abort_task"),
        parameters={
            "type": "object",
            "properties": {
                "reason": {"type": "string"},
            },
            "required": ["reason"],
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- fetch_issue_thread ----------
def _build_fetch_thread(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        try:
            issue = _run_coro(
                bindings.loop,
                bindings.github.get_issue(bindings.repo.full_name, _require_issue(bindings).number),
            )
            comments = _run_coro(
                bindings.loop,
                bindings.github.list_comments(bindings.repo.full_name, _require_issue(bindings).number),
            )
        except GitHubError as exc:
            _audit(bindings, "fetch_issue_thread", args, error=str(exc))
            _raise_command(f"GitHub fetch failed: {exc.status} {exc.message}")
        lines = [
            f"# {issue.repo}#{issue.number} ({issue.state})",
            f"title: {issue.title}",
            f"author: @{issue.author}",
            f"labels: {', '.join(issue.labels) if issue.labels else '(none)'}",
            "",
            "## Body",
            issue.body.strip() or "(empty)",
            "",
            f"## Comments ({len(comments)})",
        ]
        for c in comments:
            lines.extend(["", f"### @{c.author} at {c.created_at}", c.body.strip()])
        rendered = "\n".join(lines)
        _audit(bindings, "fetch_issue_thread", args, result={"comments": len(comments)})
        return rendered

    return host_tool(
        name="fetch_issue_thread",
        description=persona.host_tool_description("fetch_issue_thread"),
        parameters={
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- gh_search_issues ----------
_REPO_QUALIFIER_RE = re.compile(r"(?i)\brepo:")


def _render_search_matches(
    query: str, repo: str, rows: list[tuple[bool, int, str, str, str, tuple[str, ...], str]]
) -> str:
    """Render (is_pr, number, state_display, title, author, labels, updated) rows."""
    lines = [f"# {len(rows)} match(es) for {query!r} in {repo}"]
    for is_pr, number, state, title, author, labels, updated in rows:
        kind = "PR" if is_pr else "issue"
        label_sfx = f" [{', '.join(labels)}]" if labels else ""
        lines.append(f"- #{number} ({kind}, {state}) {title} — @{author}, updated {updated[:10]}{label_sfx}")
    return "\n".join(lines)


def _build_search_issues(bindings: ToolBindings) -> HostTool[Any, Any]:
    """Issue/PR search scoped to the current repo, served from the local index.

    Exists so triage can find duplicates and already-merged fixes instead of
    classifying blind. Queries hit the webhook-fed SQLite FTS index (zero API
    cost); the GitHub search API is only used before the repo's first
    reconcile completes. The inbound issue is filtered out of results.
    """

    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            msg = "gh_search_issues requires a non-empty 'query'."
            _audit(bindings, "gh_search_issues", args, error=msg)
            _raise_command(msg)
        query = query.strip()
        if _REPO_QUALIFIER_RE.search(query):
            msg = "gh_search_issues scopes to the current repo automatically; drop the 'repo:' qualifier."
            _audit(bindings, "gh_search_issues", args, error=msg)
            _raise_command(msg)
        limit_raw = args.get("limit")
        limit = max(1, min(int(limit_raw), 20)) if isinstance(limit_raw, int) else 10
        repo = bindings.repo.full_name

        rows: list[tuple[bool, int, str, str, str, tuple[str, ...], str]]
        if bindings.db.issue_index_watermark(repo) is not None:
            parsed = parse_search_query(query)
            entries = bindings.db.search_issue_index(
                repo,
                keywords=parsed.keywords,
                is_pr=parsed.is_pr,
                state=parsed.state,
                merged=parsed.merged,
                label=parsed.label,
                author=parsed.author,
                limit=limit + 1,  # headroom for the self-filter below
            )
            entries = [e for e in entries if e.is_pull_request or e.number != _require_issue(bindings).number][:limit]
            rows = []
            for e in entries:
                if e.is_pull_request and e.merged_at:
                    state = "merged"
                elif e.state_reason:
                    state = f"{e.state} ({e.state_reason})"
                else:
                    state = e.state
                rows.append((e.is_pull_request, e.number, state, e.title, e.author, e.labels, e.updated_at))
            source = "local"
        else:
            # Index not backfilled yet — fall through to the GitHub search API.
            try:
                found = _run_coro(
                    bindings.loop,
                    bindings.github.search_issues(repo, query, limit=limit),
                )
            except GitHubError as exc:
                _audit(bindings, "gh_search_issues", args, error=str(exc))
                _raise_command(f"GitHub search failed: {exc.status} {exc.message}")
            found = [s for s in found if s.is_pull_request or s.number != _require_issue(bindings).number]
            rows = [
                (
                    s.is_pull_request,
                    s.number,
                    f"{s.state} ({s.state_reason})" if s.state_reason else s.state,
                    s.title,
                    s.author,
                    s.labels,
                    s.updated_at,
                )
                for s in found
            ]
            source = "remote"
        if not rows:
            _audit(bindings, "gh_search_issues", args, result={"matches": 0, "source": source})
            return f"No issues or PRs in {repo} match {query!r}."
        _audit(bindings, "gh_search_issues", args, result={"matches": len(rows), "source": source})
        return _render_search_matches(query, repo, rows)

    return host_tool(
        name="gh_search_issues",
        description=persona.host_tool_description("gh_search_issues"),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("gh_search_issues", "query"),
                },
                "limit": {
                    "type": "integer",
                    "description": persona.host_tool_parameter_description("gh_search_issues", "limit"),
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        execute=execute,
    )


# ---------- search_commits ----------
_COMMIT_SEARCH_TIMEOUT_SECONDS = 120.0


def _build_search_commits(bindings: ToolBindings) -> HostTool[Any, Any]:
    """Local `git log` search over the default branch's history.

    Two modes: `message` greps commit subjects/bodies (case-insensitive
    regex), `patch` runs the pickaxe (`-S`) to find commits whose diff adds or
    removes the literal string — the sharp tool for "was this already fixed".
    The search interface (query in, ranked commits out) is deliberately opaque
    about its backend so a semantic index can replace git plumbing later.
    """

    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            msg = "search_commits requires a non-empty 'query'."
            _audit(bindings, "search_commits", args, error=msg)
            _raise_command(msg)
        query = query.strip()
        mode = args.get("mode") or "message"
        if mode not in ("message", "patch"):
            msg = "search_commits 'mode' must be 'message' or 'patch'."
            _audit(bindings, "search_commits", args, error=msg)
            _raise_command(msg)
        limit_raw = args.get("limit")
        limit = max(1, min(int(limit_raw), 30)) if isinstance(limit_raw, int) else 10
        paths = [p for p in (args.get("paths") or ()) if isinstance(p, str) and p.strip()]

        rev = f"origin/{bindings.repo.default_branch}"
        probe = _run_repo_command(bindings, ["git", "rev-parse", "--verify", "--quiet", rev], timeout=30.0)
        if probe.returncode != 0:
            rev = "HEAD"
        cmd = ["git", "log", rev, "-n", str(limit), "--date=short", "--pretty=format:%h %ad %an — %s"]
        if mode == "message":
            cmd += [f"--grep={query}", "--regexp-ignore-case"]
        else:
            cmd += ["-S", query]
        if paths:
            cmd += ["--", *paths]
        try:
            proc = _run_repo_command(bindings, cmd, timeout=_COMMIT_SEARCH_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            msg = f"search_commits timed out after {_COMMIT_SEARCH_TIMEOUT_SECONDS:.0f}s; narrow with 'paths' or a shorter history window."
            _audit(bindings, "search_commits", args, error=msg)
            _raise_command(msg)
        if proc.returncode != 0:
            msg = f"git log failed: {(proc.stderr or proc.stdout).strip()[:500]}"
            _audit(bindings, "search_commits", args, error=msg)
            _raise_command(msg)
        out = proc.stdout.strip()
        if not out:
            _audit(bindings, "search_commits", args, result={"matches": 0})
            return f"No commits on {rev} match {query!r} (mode={mode})."
        matches = out.splitlines()
        _audit(bindings, "search_commits", args, result={"matches": len(matches)})
        header = f"# {len(matches)} commit(s) on {rev} matching {query!r} (mode={mode})"
        return "\n".join([header, *matches])

    return host_tool(
        name="search_commits",
        description=persona.host_tool_description("search_commits"),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("search_commits", "query"),
                },
                "mode": {
                    "type": "string",
                    "enum": ["message", "patch"],
                    "description": persona.host_tool_parameter_description("search_commits", "mode"),
                },
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": persona.host_tool_parameter_description("search_commits", "paths"),
                },
                "limit": {
                    "type": "integer",
                    "description": persona.host_tool_parameter_description("search_commits", "limit"),
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        execute=execute,
    )


_PRIMARY_TYPES = ("bug", "enhancement", "question", "proposal", "documentation", "wontfix", "invalid", "duplicate")
_AUTO_PR_CLASSIFICATIONS = frozenset({"bug", "documentation"})
_PRIORITIES = ("prio:p0", "prio:p1", "prio:p2", "prio:p3")
_FUNCTIONAL = ("agent", "tool", "tui", "cli", "prompting", "sdk", "auth", "setup", "ux", "providers")
_PLATFORMS = ("platform:linux", "platform:macos", "platform:windows", "platform:wsl")
_PR_RANKS = ("review:p0", "review:p1", "review:p2", "review:p3")
_PR_TYPES = ("feat", "fix", "docs", "refactor", "perf", "test", "chore", "ci", "build")
_CLOSING_ISSUE_RE = re.compile(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", re.IGNORECASE)


def _enforce_impl_authorization(
    bindings: ToolBindings,
    tool_name: str,
    args: Mapping[str, Any],
    *,
    action: str,
) -> None:
    """Refuse first publish on issue classes that require maintainer authorization."""
    if bindings.impl_authorized:
        return
    if bindings.db.has_authorized_impl_event(bindings.issue_key):
        return
    row = bindings.db.get_issue(bindings.issue_key)
    if row is not None:
        if row.pr_number is not None:
            return
        classification = row.classification
        if classification in _AUTO_PR_CLASSIFICATIONS:
            return
    else:
        classification = None
    classification_phrase = f"classified `{classification}`" if classification else "not classified"
    msg = (
        f"refusing to {action}: issue #{_require_issue(bindings).number} is {classification_phrase}; "
        "a repo OWNER or allowlisted maintainer must @-mention you with an explicit go-ahead "
        "before any branch/PR. Post your analysis with `gh_post_comment` and stop."
    )
    _audit(bindings, tool_name, args, error=msg)
    _raise_command(msg)


def _require_review_mode(bindings: ToolBindings, name: str, args: Mapping[str, Any]) -> None:
    if bindings.review_mode:
        return
    msg = f"{name} is only available during incoming PR review tasks."
    _audit(bindings, name, args, error=msg)
    _raise_command(msg)


def _format_pr_file(file: PullRequestFileInfo) -> str:
    return f"- `{file.path}` ({file.status}, +{file.additions}/-{file.deletions})"


def _build_fetch_pr(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        _require_review_mode(bindings, "fetch_pr", args)
        pr_number = bindings.default_comment_number
        try:
            pr = _run_coro(bindings.loop, bindings.github.get_pull_request(bindings.repo.full_name, pr_number))
            files = _run_coro(bindings.loop, bindings.github.list_pr_files(bindings.repo.full_name, pr_number))
        except GitHubError as exc:
            _audit(bindings, "fetch_pr", args, error=str(exc))
            _raise_command(f"GitHub fetch failed: {exc.status} {exc.message}")
        linked = tuple(sorted({int(match.group(1)) for match in _CLOSING_ISSUE_RE.finditer(pr.body)}))
        lines = [
            f"# {pr.repo}#{pr.number} ({pr.state})",
            f"title: {pr.title or '(untitled)'}",
            f"author: @{pr.author}",
            f"head: {pr.head_repo or pr.repo}:{pr.head_ref}",
            f"base: {pr.base_ref}",
            f"url: {pr.html_url}",
            "",
            "## Body",
            pr.body.strip() or "(empty)",
            "",
            "## Linked issues",
            ", ".join(f"#{n}" for n in linked) if linked else "(none found in PR body)",
            "",
            f"## Changed files ({len(files)})",
        ]
        lines.extend(_format_pr_file(file) for file in files)
        rendered = "\n".join(lines)
        _audit(bindings, "fetch_pr", args, result={"files": len(files), "linked_issues": list(linked)})
        return rendered

    return host_tool(
        name="fetch_pr",
        description=persona.host_tool_description("fetch_pr"),
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
        execute=execute,
    )


def _build_classify_pr(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        _require_review_mode(bindings, "classify_pr", args)
        rank = args.get("rank")
        if rank not in _PR_RANKS:
            msg = f"classify_pr 'rank' must be one of {_PR_RANKS}; got {rank!r}."
            _audit(bindings, "classify_pr", args, error=msg)
            _raise_command(msg)
        pr_type = args.get("type")
        if pr_type not in _PR_TYPES:
            msg = f"classify_pr 'type' must be one of {_PR_TYPES}; got {pr_type!r}."
            _audit(bindings, "classify_pr", args, error=msg)
            _raise_command(msg)
        rationale = args.get("rationale")
        if not isinstance(rationale, str) or not rationale.strip():
            msg = "classify_pr requires a one-sentence 'rationale'."
            _audit(bindings, "classify_pr", args, error=msg)
            _raise_command(msg)

        labels: list[str] = ["triaged", str(rank), str(pr_type)]
        for area in args.get("area") or ():
            if isinstance(area, str) and area in _FUNCTIONAL:
                labels.append(area)
        provider = args.get("provider")
        if isinstance(provider, str) and provider.strip() and provider.startswith("provider:"):
            labels.append("providers")
            labels.append(provider)
        try:
            applied = _run_coro(
                bindings.loop,
                bindings.github.add_issue_labels(bindings.repo.full_name, bindings.default_comment_number, labels),
            )
        except GitHubError as exc:
            _audit(bindings, "classify_pr", args, error=str(exc))
            _raise_command(f"GitHub rejected labels: {exc.status} {exc.message}")
        bindings.db.set_issue_classification(bindings.issue_key, str(rank))
        _audit(
            bindings,
            "classify_pr",
            args,
            result={"rank": rank, "type": pr_type, "labels": list(applied), "rationale": rationale},
        )
        return f"classified PR as {rank}; labels applied: {', '.join(applied)}."

    return host_tool(
        name="classify_pr",
        description=persona.host_tool_description("classify_pr"),
        parameters={
            "type": "object",
            "properties": {
                "rank": {
                    "type": "string",
                    "enum": list(_PR_RANKS),
                    "description": persona.host_tool_parameter_description("classify_pr", "rank"),
                },
                "type": {
                    "type": "string",
                    "enum": list(_PR_TYPES),
                    "description": persona.host_tool_parameter_description("classify_pr", "type"),
                },
                "area": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(_FUNCTIONAL)},
                    "description": persona.host_tool_parameter_description("classify_pr", "area"),
                },
                "provider": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("classify_pr", "provider"),
                },
                "rationale": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("classify_pr", "rationale"),
                },
            },
            "required": ["rank", "type", "rationale"],
            "additionalProperties": False,
        },
        execute=execute,
    )


def _review_comment_to_payload(comment: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "path": comment.path,
        "line": comment.line,
        "side": comment.side,
        "body": comment.body,
    }
    if comment.start_line is not None:
        payload["start_line"] = comment.start_line
    if comment.start_side is not None:
        payload["start_side"] = comment.start_side
    return payload


def _build_pr_review_comment(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        _require_review_mode(bindings, "pr_review_comment", args)
        path = args.get("path")
        line = args.get("line")
        body = args.get("body")
        if not isinstance(path, str) or not path.strip():
            msg = "pr_review_comment requires a non-empty 'path'."
            _audit(bindings, "pr_review_comment", args, error=msg)
            _raise_command(msg)
        if not isinstance(line, int) or line <= 0:
            msg = "pr_review_comment requires a positive integer 'line'."
            _audit(bindings, "pr_review_comment", args, error=msg)
            _raise_command(msg)
        if not isinstance(body, str) or not body.strip():
            msg = "pr_review_comment requires a non-empty 'body'."
            _audit(bindings, "pr_review_comment", args, error=msg)
            _raise_command(msg)
        side = str(args.get("side") or "RIGHT")
        if side not in ("RIGHT", "LEFT"):
            msg = "pr_review_comment 'side' must be RIGHT or LEFT."
            _audit(bindings, "pr_review_comment", args, error=msg)
            _raise_command(msg)
        start_line = args.get("start_line")
        if start_line is not None and (not isinstance(start_line, int) or start_line <= 0):
            msg = "pr_review_comment 'start_line' must be a positive integer when provided."
            _audit(bindings, "pr_review_comment", args, error=msg)
            _raise_command(msg)
        start_side_raw = args.get("start_side")
        start_side = str(start_side_raw) if start_side_raw is not None else None
        if start_side is not None and start_side not in ("RIGHT", "LEFT"):
            msg = "pr_review_comment 'start_side' must be RIGHT or LEFT when provided."
            _audit(bindings, "pr_review_comment", args, error=msg)
            _raise_command(msg)
        staged = bindings.db.stage_review_comment(
            issue_key=bindings.issue_key,
            path=path.strip(),
            line=line,
            side=side,
            start_line=start_line,
            start_side=start_side,
            body=body.strip(),
        )
        count = len(bindings.db.list_staged_review_comments(bindings.issue_key))
        _audit(bindings, "pr_review_comment", args, result={"id": staged.id, "staged": count})
        return f"staged review comment #{staged.id}; staged_count={count}"

    return host_tool(
        name="pr_review_comment",
        description=persona.host_tool_description("pr_review_comment"),
        parameters={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("pr_review_comment", "path"),
                },
                "line": {
                    "type": "integer",
                    "description": persona.host_tool_parameter_description("pr_review_comment", "line"),
                },
                "body": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("pr_review_comment", "body"),
                },
                "side": {
                    "type": "string",
                    "enum": ["RIGHT", "LEFT"],
                    "default": "RIGHT",
                    "description": persona.host_tool_parameter_description("pr_review_comment", "side"),
                },
                "start_line": {
                    "type": "integer",
                    "description": persona.host_tool_parameter_description("pr_review_comment", "start_line"),
                },
                "start_side": {
                    "type": "string",
                    "enum": ["RIGHT", "LEFT"],
                    "description": persona.host_tool_parameter_description("pr_review_comment", "start_side"),
                },
            },
            "required": ["path", "line", "body"],
            "additionalProperties": False,
        },
        execute=execute,
    )


def _diff_anchorable_lines(patch: str) -> tuple[frozenset[int], frozenset[int]]:
    """Map a unified-diff patch to (RIGHT, LEFT) anchorable line sets.

    RIGHT = new-file line numbers of added (+) lines and in-hunk context
    lines; LEFT = old-file line numbers of deleted (-) lines and in-hunk
    context lines. GitHub only anchors review comments on lines inside a
    hunk; a comment elsewhere 422s the whole review.
    """
    right: set[int] = set()
    left: set[int] = set()
    new_line: int | None = None
    old_line: int | None = None
    for raw in patch.splitlines():
        m = _DIFF_HUNK_RE.match(raw)
        if m:
            old_line = int(m.group(1))
            new_line = int(m.group(2))
            continue
        if raw.startswith("\\"):
            continue
        # `+++`/`---` are file headers only before the first hunk. Inside a
        # hunk a diff line's *content* may start with `++` (added) or `--`
        # (removed), and those lines must advance the counters.
        in_hunk = new_line is not None and old_line is not None
        if raw.startswith(("+++", "---")) and not in_hunk:
            continue
        if not in_hunk:
            continue
        if raw.startswith("+"):
            right.add(new_line)
            new_line += 1
        elif raw.startswith("-"):
            left.add(old_line)
            old_line += 1
        else:
            right.add(new_line)
            left.add(old_line)
            new_line += 1
            old_line += 1
    return frozenset(right), frozenset(left)


def _filter_anchorable_comments(staged: list[Any], files: list[PullRequestFileInfo]) -> tuple[list[Any], list[Any]]:
    """Partition staged comments into (anchorable, dropped) by diff hunk membership."""
    by_path = {f.path: f for f in files}
    cache: dict[str, tuple[frozenset[int], frozenset[int]]] = {}
    anchorable: list[Any] = []
    dropped: list[Any] = []
    for c in staged:
        entry = by_path.get(c.path)
        if entry is None:
            dropped.append(c)  # path not in the PR diff (stale/renamed path)
            continue
        if entry.path not in cache:
            cache[entry.path] = _diff_anchorable_lines(entry.patch)
        right, left = cache[entry.path]
        if not entry.patch:
            # Platform omitted the patch (binary file, no-op, API gap) —
            # fail open per handoff §3c; a genuine rejection is caught by
            # the 422/500 fallback after submit.
            anchorable.append(c)
            continue
        side = str(c.side or "RIGHT").upper()
        lines = right if side == "RIGHT" else left
        if c.start_line is not None:
            start_side = str(c.start_side or side).upper()
            if start_side != side or c.start_line > c.line:
                dropped.append(c)
                continue
            if c.start_line not in lines or c.line not in lines:
                dropped.append(c)
                continue
        elif c.line not in lines:
            dropped.append(c)
            continue
        anchorable.append(c)
    return anchorable, dropped


def _build_submit_pr_review(bindings: ToolBindings) -> HostTool[Any, Any]:
    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        _require_review_mode(bindings, "submit_pr_review", args)
        body = args.get("body")
        if not isinstance(body, str) or not body.strip():
            msg = "submit_pr_review requires a non-empty 'body'."
            _audit(bindings, "submit_pr_review", args, error=msg)
            _raise_command(msg)
        staged = bindings.db.list_staged_review_comments(bindings.issue_key)
        comments = [_review_comment_to_payload(comment) for comment in staged]
        # commit_id is only needed by Forgejo to anchor inline review comments.
        # GitHub's reviews endpoint ignores it, so skip the extra API call.
        commit_id: str | None = None
        if getattr(bindings.github, "_platform", "github") == "forgejo":
            try:
                pr = _run_coro(
                    bindings.loop,
                    bindings.github.get_pull_request(
                        repo=bindings.repo.full_name,
                        number=bindings.default_comment_number,
                    ),
                )
                commit_id = pr.head_sha or None
            except GitHubError:
                commit_id = None
        body = body.strip()
        dropped: list[Any] = []
        if staged:
            try:
                pr_files = _run_coro(
                    bindings.loop,
                    bindings.github.list_pr_files(
                        repo=bindings.repo.full_name,
                        pr_number=bindings.default_comment_number,
                    ),
                )
            except GitHubError as exc:
                # Fail open: patch fetch failed, submit unfiltered — the
                # 422/500 fallback below still catches a bad batch.
                _audit(
                    bindings,
                    "submit_pr_review",
                    args,
                    error=f"anchor validation skipped: {exc.status} {exc.message}",
                )
            else:
                filtered, dropped = _filter_anchorable_comments(staged, pr_files)
                if dropped:
                    _audit(
                        bindings,
                        "submit_pr_review",
                        args,
                        result={"dropped": [f"{c.path}:{c.line}" for c in dropped]},
                    )
                    body += "\n\n## Not anchored to diff"
                    for c in dropped:
                        body += f"\n- **`{c.path}:{c.line}`** — {c.body}"
                    comments = [_review_comment_to_payload(c) for c in filtered]
        try:
            review = _run_coro(
                bindings.loop,
                bindings.github.submit_pr_review(
                    repo=bindings.repo.full_name,
                    pr_number=bindings.default_comment_number,
                    body=body,
                    event="COMMENT",
                    comments=comments,
                    commit_id=commit_id,
                ),
            )
        except GitHubError as exc:
            _audit(bindings, "submit_pr_review", args, error=str(exc))
            # 422 = validation rejection (e.g. Forgejo can't anchor inline
            # comments). 500 = Forgejo internal error on the reviews endpoint
            # (observed on certain PRs — the server crashes instead of returning
            # a proper 422). Both mean the batched review can't land as-is.
            # Degrade to visible issue comments (mirrors mira) so findings still
            # surface and the model doesn't retry and degrade its own output.
            # Without this fallback, a 500 propagates to the model as a raw
            # error, triggering a retry-and-simplify loop where the model
            # strips newlines from its review body on subsequent attempts.
            if exc.status not in (422, 500):
                _raise_command(f"GitHub rejected PR review: {exc.status} {exc.message}")

            def _note(comment: Any) -> str:
                return f"**`{comment.path}:{comment.line}`**\n\n{comment.body}"

            posted_inline = 0
            try:
                _run_coro(
                    bindings.loop,
                    bindings.github.post_comment(bindings.repo.full_name, bindings.default_comment_number, body),
                )
                for comment in staged:
                    _run_coro(
                        bindings.loop,
                        bindings.github.post_comment(
                            bindings.repo.full_name, bindings.default_comment_number, _note(comment)
                        ),
                    )
                    posted_inline += 1
            except GitHubError as fexc:
                _audit(bindings, "submit_pr_review", args, error=str(fexc))
                _raise_command(
                    f"Review rejected ({exc.status}) and fallback comment posting failed: {fexc.status} {fexc.message}"
                )

            cleared = bindings.db.clear_staged_review_comments(bindings.issue_key)
            _audit(
                bindings,
                "submit_pr_review",
                args,
                result={
                    "fallback": "issue_comments",
                    "summary": True,
                    "inline": posted_inline,
                    "cleared": cleared,
                },
            )
            return (
                f"review rejected ({exc.status}); posted summary + {posted_inline} inline comment(s) as issue comments"
            )
        cleared = bindings.db.clear_staged_review_comments(bindings.issue_key)
        _audit(
            bindings,
            "submit_pr_review",
            args,
            result={
                "review_id": review.id,
                "comments": len(comments),
                "dropped": len(dropped),
                "cleared": cleared,
                "event": "COMMENT",
            },
        )
        if dropped:
            return f"submitted PR review id={review.id}; comments={len(comments)}; dropped={len(dropped)} not anchored to diff"
        return f"submitted PR review id={review.id}; comments={len(comments)}"

    return host_tool(
        name="submit_pr_review",
        description=persona.host_tool_description("submit_pr_review"),
        parameters={
            "type": "object",
            "properties": {
                "body": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("submit_pr_review", "body"),
                },
                "event": {
                    "type": "string",
                    "enum": ["COMMENT"],
                    "default": "COMMENT",
                    "description": persona.host_tool_parameter_description("submit_pr_review", "event"),
                },
            },
            "required": ["body"],
            "additionalProperties": False,
        },
        execute=execute,
    )


def _build_set_issue_labels(bindings: ToolBindings) -> HostTool[Any, Any]:
    """Append labels to the originating issue (or PR)."""

    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        if bindings.inbound_is_pr:
            _audit(bindings, "set_issue_labels", args, result={"skipped": "pr_thread"})
            return (
                "no-op: set_issue_labels is not applicable on PR threads — PR labels are "
                "not used for triage. Proceed with the requested change."
            )
        labels = args.get("labels")
        if not isinstance(labels, list) or not labels:
            _raise_command("set_issue_labels requires a non-empty 'labels' array.")
        cleaned = [str(lbl).strip() for lbl in labels if isinstance(lbl, str) and lbl.strip()]
        if not cleaned:
            _raise_command("set_issue_labels requires at least one non-empty label.")
        target_number = _require_issue(bindings).number
        if isinstance(args.get("number"), int):
            target_number = int(args["number"])
        try:
            applied = _run_coro(
                bindings.loop,
                bindings.github.add_issue_labels(bindings.repo.full_name, target_number, cleaned),
            )
        except GitHubError as exc:
            _audit(bindings, "set_issue_labels", args, error=str(exc))
            _raise_command(f"GitHub rejected labels: {exc.status} {exc.message}")
        _audit(bindings, "set_issue_labels", args, result={"labels": list(applied)})
        return f"labels now: {', '.join(applied)}"

    return host_tool(
        name="set_issue_labels",
        description=persona.host_tool_description("set_issue_labels"),
        parameters={
            "type": "object",
            "properties": {
                "labels": {"type": "array", "items": {"type": "string"}},
                "number": {
                    "type": "integer",
                    "description": persona.host_tool_parameter_description("set_issue_labels", "number"),
                },
            },
            "required": ["labels"],
            "additionalProperties": False,
        },
        execute=execute,
    )


def _build_classify_issue(bindings: ToolBindings) -> HostTool[Any, Any]:
    """Triage step. Pick a primary type, optional priority/functional/provider/platform,
    apply labels on GitHub, persist the primary type in sqlite, and signal which workflow
    branch the agent should follow."""

    def execute(args: dict[str, Any], _ctx: HostToolContext[Any]) -> str:
        existing = bindings.db.get_issue(bindings.issue_key)
        if bindings.inbound_is_pr:
            note = (
                f"no-op: classify_issue is not applicable on PR threads. "
                f"Issue #{_require_issue(bindings).number} is already classified"
            )
            if existing is not None and existing.classification:
                note += f" as {existing.classification!r}"
            note += ". Proceed with the requested change (amend the branch and push, or post a comment)."
            _audit(bindings, "classify_issue", args, result={"skipped": "pr_thread"})
            return note
        if existing is not None and existing.classification:
            _audit(bindings, "classify_issue", args, result={"skipped": "already_classified"})
            return (
                f"no-op: issue #{_require_issue(bindings).number} is already classified as "
                f"{existing.classification!r}. Continue with that workflow; do not re-classify."
            )
        primary = args.get("primary")
        if primary not in _PRIMARY_TYPES:
            msg = f"classify_issue 'primary' must be one of {_PRIMARY_TYPES}; got {primary!r}."
            _audit(bindings, "classify_issue", args, error=msg)
            _raise_command(msg)
        rationale = args.get("rationale")
        if not isinstance(rationale, str) or not rationale.strip():
            msg = "classify_issue requires a one-sentence 'rationale'."
            _audit(bindings, "classify_issue", args, error=msg)
            _raise_command(msg)
        priority = args.get("priority")
        if primary == "bug":
            if priority not in _PRIORITIES:
                msg = f"classify_issue requires 'priority' in {_PRIORITIES} when primary=='bug'."
                _audit(bindings, "classify_issue", args, error=msg)
                _raise_command(msg)
        else:
            # Non-bug primaries: silently drop any priority the model included
            # rather than rejecting the call. Some models (notably gpt-5.5 over
            # OpenAI Completions) treat every property as required and loop
            # forever when a non-empty optional value triggers a hard error.
            priority = None
        branch_slug = args.get("branch_slug")
        if isinstance(branch_slug, str) and branch_slug.strip():
            try:
                branch_slug = validate_branch_slug(branch_slug)
            except ValueError as exc:
                msg = f"classify_issue rejected branch_slug: {exc}"
                _audit(bindings, "classify_issue", args, error=msg)
                _raise_command(msg)
        else:
            branch_slug = None

        labels: list[str] = [primary]
        if primary == "bug" and isinstance(priority, str):
            labels.append(priority)
        for fn in args.get("functional") or ():
            # Unknown functional tags are dropped silently — they aren't worth
            # rejecting the whole classification over.
            if isinstance(fn, str) and fn in _FUNCTIONAL:
                labels.append(fn)
        provider = args.get("provider")
        if isinstance(provider, str) and provider.strip() and provider.startswith("provider:"):
            labels.append("providers")
            labels.append(provider)
        platform = args.get("platform")
        if isinstance(platform, str) and platform in _PLATFORMS:
            labels.append(platform)
        labels.append("triaged")

        renamed_to: str | None = None
        if branch_slug:
            try:
                renamed_to = rename_workspace_branch(
                    bindings.workspace,
                    branch_slug,
                    pr_number=existing.pr_number if existing is not None else None,
                    slot_uid=bindings.slot_uid,
                )
            except ValueError as exc:
                _audit(bindings, "classify_issue", args, error=str(exc))
                _raise_command(f"classify_issue rejected branch_slug: {exc}")
            except GitCommandError as exc:
                _audit(bindings, "classify_issue", args, error=str(exc))
                _raise_command(f"classify_issue could not rename branch: {exc}")
            if renamed_to != bindings.workspace.branch:
                # rename_workspace_branch already mutated workspace.branch on
                # success; this branch is purely defensive — kept so a future
                # refactor of that helper still surfaces the mismatch.
                _raise_command("classify_issue internal: branch rename inconsistent.")
            bindings.db.set_issue_branch(bindings.issue_key, renamed_to)

        try:
            applied = _run_coro(
                bindings.loop,
                bindings.github.add_issue_labels(
                    bindings.repo.full_name,
                    _require_issue(bindings).number,
                    labels,
                ),
            )
        except GitHubError as exc:
            _audit(bindings, "classify_issue", args, error=str(exc))
            _raise_command(f"GitHub rejected labels: {exc.status} {exc.message}")

        bindings.db.set_issue_classification(bindings.issue_key, primary)
        _audit(
            bindings,
            "classify_issue",
            args,
            result={
                "primary": primary,
                "labels": list(applied),
                "rationale": rationale,
                "branch": renamed_to,
            },
        )
        # Echo back the workflow the agent should now follow. The persona prompt
        # already describes each branch; the tool result reminds it.
        next_step = persona.classify_next_step(str(primary))
        suffix = f" Branch renamed to `{renamed_to}`." if renamed_to else ""
        return f"classified as {primary}; labels applied: {', '.join(applied)}.{suffix} Next: {next_step}."

    return host_tool(
        name="classify_issue",
        description=persona.host_tool_description("classify_issue"),
        parameters={
            "type": "object",
            "properties": {
                "primary": {
                    "type": "string",
                    "enum": list(_PRIMARY_TYPES),
                    "description": persona.host_tool_parameter_description("classify_issue", "primary"),
                },
                "priority": {
                    "type": "string",
                    "enum": list(_PRIORITIES),
                    "description": persona.host_tool_parameter_description("classify_issue", "priority"),
                },
                "functional": {
                    "type": "array",
                    "items": {"type": "string", "enum": list(_FUNCTIONAL)},
                    "description": persona.host_tool_parameter_description("classify_issue", "functional"),
                },
                "provider": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("classify_issue", "provider"),
                },
                "platform": {
                    "type": "string",
                    "enum": list(_PLATFORMS),
                    "description": persona.host_tool_parameter_description("classify_issue", "platform"),
                },
                "rationale": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("classify_issue", "rationale"),
                },
                "branch_slug": {
                    "type": "string",
                    "description": persona.host_tool_parameter_description("classify_issue", "branch_slug"),
                },
            },
            "required": ["primary", "rationale"],
            "additionalProperties": False,
        },
        execute=execute,
    )


def build(bindings: ToolBindings) -> tuple[HostTool[Any, Any], ...]:
    """Return the full set of host tools bound to one task's context.

    The toolset is intentionally identical across all task kinds so the LLM
    prompt cache stays warm across triage → follow-up → PR-conversation
    transitions. Triage tools (`classify_issue`, `set_issue_labels`) enforce
    their own scope at execution time — see the `inbound_is_pr` and
    already-classified guards inside `_build_classify_issue` /
    `_build_set_issue_labels`.
    """
    return (
        _build_classify_issue(bindings),
        _build_set_issue_labels(bindings),
        _build_fetch_pr(bindings),
        _build_classify_pr(bindings),
        _build_pr_review_comment(bindings),
        _build_submit_pr_review(bindings),
        _build_post_comment(bindings),
        _build_push_branch(bindings),
        _build_release_ci_status(bindings),
        _build_release_job_log(bindings),
        _build_release_retag(bindings),
        _build_open_pr(bindings),
        _build_request_review(bindings),
        _build_repro_record(bindings),
        _build_mark_unable(bindings),
        _build_abort_task(bindings),
        _build_fetch_thread(bindings),
        _build_search_issues(bindings),
        _build_search_commits(bindings),
    )


__all__ = ["AbortController", "ReleaseToolContext", "ToolBindings", "build"]
