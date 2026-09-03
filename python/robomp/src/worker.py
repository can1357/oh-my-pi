"""Per-task RpcClient driver.

The orchestrator calls `run_task(...)` from within an asyncio loop. The
function spins up `RpcClient` on a worker thread, drives the kickoff/follow-up
prompt, and returns when the agent emits `agent_end`.

Host tools call back into the orchestrator's GitHub client and DB. Because the
RpcClient runs in its own subprocess and the host-tool callbacks are dispatched
on the RpcClient's stdout-reader thread, the callbacks block until coroutines
scheduled onto the parent loop complete (`asyncio.run_coroutine_threadsafe`).
"""

from __future__ import annotations

import asyncio
import grp
import logging
import os
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from omp_rpc import (
    MessageUpdateEvent,
    RpcClient,
    RpcError,
    RpcProcessExitError,
    ToolExecutionEndEvent,
)

from robomp import host_tools, persona, pragmas
from robomp.cancellation import register_cancel_hook, unregister_cancel_hook
from robomp.config import Settings
from robomp.db import Database, issue_key
from robomp.git_ops import DirtyState, inspect_dirty_state
from robomp.github_backend import GitHubBackend
from robomp.github_client import CommentInfo, IssueInfo, PullRequestInfo, RepoInfo
from robomp.host_tools import AbortController, ReleaseToolContext, ToolBindings, _git_identity_env
from robomp.natives_cache import NativesCache
from robomp.natives_cache import compute_key as natives_compute_key
from robomp.sandbox import GitTransport, Workspace, _prepare_slot_runtime_env, _safe_directory_env

log = logging.getLogger(__name__)


@dataclass(slots=True, frozen=True)
class ReleaseTaskContext:
    """Release verdict and failure context supplied to an agent round."""

    tag: str
    version: str
    round: int
    max_rounds: int
    head_sha: str
    default_branch: str
    failures_text: str
    run_urls: tuple[str, ...]


@dataclass(slots=True)
class TaskInputs:
    """Common context shared by every task type."""

    settings: Settings
    db: Database
    github: GitHubBackend
    git_transport: GitTransport
    repo: RepoInfo
    workspace: Workspace
    delivery_id: str
    attempts: int = 0
    slot_uid: int | None = None
    natives_cache: NativesCache | None = None
    issue: IssueInfo | None = None
    release: ReleaseTaskContext | None = None


@dataclass(slots=True, frozen=True)
class ThreadMessage:
    """One entry in the conversation a directive carries to the agent."""

    kind: str  # issue_body | pr_body | comment | review_comment | review
    author: str
    body: str
    created_at: str
    path: str | None = None  # review_comment only
    line: int | None = None  # review_comment only
    state: str | None = None  # review only (APPROVED / CHANGES_REQUESTED / COMMENTED)


@dataclass(slots=True, frozen=True)
class DirectiveInfo:
    """A maintainer's `@bot` mention captured as an authoritative instruction.

    `thread` is the full conversation context (issue/PR body + every prior
    comment + every review) up to the moment the directive fired.
    """

    body: str
    author: str
    thread: tuple[ThreadMessage, ...] = ()
    pragmas: tuple[tuple[str, str], ...] = ()
    authorizes_impl: bool = False


def _resolve_pragma_overrides(
    directive: DirectiveInfo | None,
    settings: Settings,
) -> tuple[str | None, pragmas.ThinkingLevel | None]:
    """Return `(model_override, thinking_override)` for the current directive.

    `None` for either means "no override, use the settings default". Aliases
    that don't match anything in the pool / level set are dropped (caller logs
    the discard at the callsite that has access to issue_key).
    """
    if directive is None or not directive.pragmas:
        return None, None
    model_value = pragmas.pragma_value(directive.pragmas, "model")
    thinking_value = pragmas.pragma_value(directive.pragmas, "thinking")
    model_override = pragmas.resolve_model_alias(model_value, settings.model_pool) if model_value else None
    thinking_override = pragmas.resolve_thinking_level(thinking_value) if thinking_value else None
    return model_override, thinking_override


_SCRUBBED_ENV_KEYS: tuple[str, ...] = (
    # Secrets that MUST NOT reach the agent subprocess; an agent with the
    # `bash` tool could otherwise `printenv` them out of roboomp's env.
    "GITHUB_TOKEN",
    "GITHUB_WEBHOOK_SECRET",
    "ROBOMP_REPLAY_TOKEN",
    "ROBOMP_GH_PROXY_HMAC_KEY",
)

_AGENT_HOME = Path("/srv/agent-home")
_AGENT_HOME_STAGE = Path("/srv/agent-home-stage")


def _stage_agent_home() -> None:
    """Copy late-appearing staged agent config into the runtime HOME."""
    if not _AGENT_HOME_STAGE.exists():
        return

    for rel in (Path(".agent"), Path(".omp/agent")):
        src = _AGENT_HOME_STAGE / rel
        if not src.exists():
            continue

        dst = _AGENT_HOME / rel
        try:
            if os.path.lexists(dst):
                if dst.is_dir() and not dst.is_symlink():
                    shutil.rmtree(dst)
                else:
                    dst.unlink()
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(src, dst, dirs_exist_ok=True)
        except OSError as exc:
            log.warning("Failed to stage agent home path %s: %s", rel, exc)

    if not _AGENT_HOME.exists():
        return

    chown_to_root = os.geteuid() == 0
    for root, dirs, files in os.walk(_AGENT_HOME):
        root_path = Path(root)
        if root_path == _AGENT_HOME / ".omp":
            # ~/.omp/run is slot-writable daemon presence state, not template
            # config; keep it out of the read-only normalization below.
            dirs[:] = [d for d in dirs if d != "run"]
        try:
            root_path.chmod(0o755)
            if chown_to_root:
                os.chown(root_path, 0, 0)
        except OSError as exc:
            log.warning("Failed to normalize agent home directory %s: %s", root_path, exc)

        for name in dirs:
            path = root_path / name
            try:
                path.chmod(0o755)
                if chown_to_root:
                    os.chown(path, 0, 0)
            except OSError as exc:
                log.warning("Failed to normalize agent home directory %s: %s", path, exc)

        for name in files:
            path = root_path / name
            try:
                path.chmod(0o644)
                if chown_to_root:
                    os.chown(path, 0, 0)
            except OSError as exc:
                log.warning("Failed to normalize agent home file %s: %s", path, exc)


def _ensure_agent_run_dir() -> None:
    """Keep ``~/.omp/run`` writable by every sandbox slot.

    omp registers daemon project presence under ``~/.omp/run`` at startup,
    nesting per-project dirs (``daemons/<hash>/clients``) that any slot user
    must be able to create or enter regardless of which slot made them first.
    The tree stays group ``omp``, setgid, group-writable; slot subprocesses
    spawn with umask 0002 so their entries inherit group write.
    """
    if os.geteuid() != 0:
        return
    run_dir = _AGENT_HOME / ".omp" / "run"
    try:
        gid = grp.getgrnam("omp").gr_gid
    except KeyError:
        return
    try:
        run_dir.mkdir(parents=True, exist_ok=True)
        for root, _dirs, files in os.walk(run_dir):
            root_path = Path(root)
            os.chown(root_path, -1, gid)
            root_path.chmod(0o2770)
            for name in files:
                file_path = root_path / name
                os.chown(file_path, -1, gid)
                file_path.chmod(0o660)
    except OSError as exc:
        log.warning("Failed to prepare agent run dir %s: %s", run_dir, exc)


def _build_extra_env(settings: Settings) -> dict[str, str]:
    """Build the env overlay passed to the omp subprocess.

    `omp_rpc` merges this dict on top of `os.environ`, so overlaying empty
    strings for the sensitive keys is what actually masks them in the
    child — `del` on the parent's env would not help us here.
    """
    del settings  # kept for future hooks (model-specific env, etc.)
    _stage_agent_home()
    _ensure_agent_run_dir()
    env = dict.fromkeys(_SCRUBBED_ENV_KEYS, "")
    # Usage attribution: the pi-native gateway transport forwards this label
    # (x-omp-app) so broker-side per-client burn tracking shows `robomp`
    # instead of an anonymous gateway client.
    env["OMP_APP_NAME"] = "robomp"
    if _AGENT_HOME.is_dir():
        env["HOME"] = str(_AGENT_HOME)
    return env


_TERMINAL_TRIAGE_TOOLS: frozenset[str] = frozenset({"gh_open_pr", "mark_unable_to_reproduce", "abort_task"})
_TERMINAL_REVIEW_TOOLS: frozenset[str] = frozenset({"submit_pr_review", "abort_task"})
_TERMINAL_RELEASE_TOOLS: frozenset[str] = frozenset({"release_retag", "abort_task"})
_PR_REQUIRING_CLASSIFICATIONS: frozenset[str] = frozenset({"bug", "documentation"})


def _task_timeout(settings: Settings, task_kind: str) -> float:
    """Return the turn timeout for a task kind."""
    return settings.release_task_timeout_seconds if task_kind == "handle_release_ci" else settings.task_timeout_seconds


def _needs_completion_reminder(
    *,
    task_kind: str,
    inputs: TaskInputs,
    bindings: ToolBindings,
    tools_called: set[str],
) -> bool:
    """True iff a task turn ended before reaching its terminal tool."""
    if bindings.abort is not None and bindings.abort.triggered:
        return False
    if task_kind == "review_pr":
        return not (tools_called & _TERMINAL_REVIEW_TOOLS)
    if task_kind == "handle_release_ci":
        return not (tools_called & _TERMINAL_RELEASE_TOOLS)
    if task_kind != "triage_issue":
        return False
    row = inputs.db.get_issue(bindings.issue_key)
    if row is None or row.classification not in _PR_REQUIRING_CLASSIFICATIONS:
        return False
    return not (tools_called & _TERMINAL_TRIAGE_TOOLS)


def _probe_workspace_dirty(workspace: Workspace, slot_uid: int | None) -> DirtyState:
    """Return the workspace's dirty state, swallowing inspection errors.

    `inspect_dirty_state` already swallows individual git failures, but the
    function itself can still raise if e.g. the workspace was wiped between
    `_drive_turn` and the post-turn check. The reminder loop treats any
    exception as "clean enough" so a corrupted workspace doesn't pin the
    agent in a reminder loop.
    """
    try:
        return inspect_dirty_state(
            workspace.repo_dir,
            slot_uid=slot_uid,
            safe_directory=workspace.repo_dir,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort post-turn probe
        log.debug("workspace dirty probe failed", extra={"error": str(exc)})
        return DirtyState(uncommitted=0, unpushed=0, summary="")


def _drive_turn(
    client: RpcClient,
    initial_prompt: str,
    *,
    task_kind: str,
    inputs: TaskInputs,
    bindings: ToolBindings,
    tools_called: set[str],
) -> Any:
    """Run the initial prompt and, if the agent stopped early, send reminders.

    Returns the final `Turn` (last `prompt_and_wait` result), or `None` when
    the agent intentionally pulled the plug via `abort_task`.
    """
    settings = inputs.settings
    max_reminders = settings.task_completion_max_reminders

    def _run(prompt: str) -> Any:
        try:
            return client.prompt_and_wait(prompt, timeout=_task_timeout(settings, task_kind))
        except (RpcError, RpcProcessExitError):
            # Did the agent intentionally pull the plug via `abort_task`?
            # If so, swallow — the abort path is a clean exit, not a
            # failure that should surface in the dashboard or trigger
            # a comment to the reporter. Anything else propagates.
            if bindings.abort is not None and bindings.abort.triggered:
                log.info(
                    "rpc_aborted_by_tool",
                    extra={"issue": bindings.issue_key, "task": task_kind, "reason": bindings.abort.reason},
                )
                return None
            raise

    turn = _run(initial_prompt)
    if turn is None:
        return None

    reminders_used = 0
    while reminders_used < max_reminders:
        needs_completion = _needs_completion_reminder(
            task_kind=task_kind, inputs=inputs, bindings=bindings, tools_called=tools_called
        )
        if not needs_completion:
            if task_kind == "review_pr":
                break
            dirty = _probe_workspace_dirty(inputs.workspace, inputs.slot_uid)
            if not dirty.is_dirty:
                break
        reminders_used += 1
        if needs_completion:
            log.warning(
                "rpc_completion_reminder",
                extra={
                    "issue": bindings.issue_key,
                    "task": task_kind,
                    "attempt": reminders_used,
                    "max": max_reminders,
                },
            )
            if task_kind == "handle_release_ci":
                assert inputs.release is not None
                reminder = persona.followup_release(
                    repo=inputs.repo,
                    release=inputs.release,
                    workspace=inputs.workspace,
                )
            elif task_kind == "review_pr":
                assert inputs.issue is not None
                reminder = persona.review_completion_reminder(
                    repo=inputs.repo,
                    issue=inputs.issue,
                    workspace=inputs.workspace,
                )
            else:
                assert inputs.issue is not None
                reminder = persona.completion_reminder(
                    repo=inputs.repo,
                    issue=inputs.issue,
                    workspace=inputs.workspace,
                )
        else:
            assert dirty is not None
            log.warning(
                "rpc_dirty_state_reminder",
                extra={
                    "issue": bindings.issue_key,
                    "task": task_kind,
                    "attempt": reminders_used,
                    "max": max_reminders,
                    "uncommitted": dirty.uncommitted,
                    "unpushed": dirty.unpushed,
                },
            )
            if task_kind == "handle_release_ci":
                assert inputs.release is not None
                reminder = persona.followup_release(
                    repo=inputs.repo,
                    release=inputs.release,
                    workspace=inputs.workspace,
                )
            else:
                assert inputs.issue is not None
                reminder = persona.dirty_state_reminder(
                    repo=inputs.repo,
                    issue=inputs.issue,
                    workspace=inputs.workspace,
                    dirty=dirty,
                )
        next_turn = _run(reminder)
        if next_turn is None:
            return None
        turn = next_turn

    if reminders_used and _needs_completion_reminder(
        task_kind=task_kind, inputs=inputs, bindings=bindings, tools_called=tools_called
    ):
        log.warning(
            "rpc_completion_unfinished",
            extra={
                "issue": bindings.issue_key,
                "task": task_kind,
                "reminders": reminders_used,
                "tools_called": sorted(tools_called),
            },
        )
    if reminders_used and task_kind != "review_pr":
        final_dirty = _probe_workspace_dirty(inputs.workspace, inputs.slot_uid)
        if final_dirty.is_dirty:
            log.warning(
                "rpc_dirty_state_unfinished",
                extra={
                    "issue": bindings.issue_key,
                    "task": task_kind,
                    "reminders": reminders_used,
                    "uncommitted": final_dirty.uncommitted,
                    "unpushed": final_dirty.unpushed,
                },
            )
    return turn


def _has_prior_session(session_dir: Path) -> bool:
    """Return True iff `session_dir` already contains an omp JSONL transcript.

    pi's `coding-agent` writes one `*.jsonl` per session into `--session-dir`.
    The presence of any such file is the signal that `--continue` will pick
    up the most recent transcript (`SessionManager.continueRecent`) rather
    than starting fresh.
    """
    try:
        return any(session_dir.glob("*.jsonl"))
    except OSError:
        return False


def _build_prompt(
    task_kind: str,
    inputs: TaskInputs,
    *,
    comment: CommentInfo | None,
    pr_number: int | None,
    review_payload: dict[str, Any] | None,
    pr: PullRequestInfo | None = None,
    directive: DirectiveInfo | None = None,
    thread: tuple[ThreadMessage, ...] = (),
    resuming: bool = False,
) -> str:
    if task_kind == "handle_release_ci":
        assert inputs.release is not None
        renderer = persona.followup_release if resuming else persona.kickoff_release
        return renderer(repo=inputs.repo, release=inputs.release, workspace=inputs.workspace)
    if task_kind == "triage_issue":
        assert inputs.issue is not None
        if resuming:
            return persona.resume_triage(repo=inputs.repo, issue=inputs.issue, workspace=inputs.workspace)
        if directive is not None:
            return persona.kickoff_directive(
                repo=inputs.repo,
                issue=inputs.issue,
                workspace=inputs.workspace,
                directive=directive,
            )
        return persona.kickoff(repo=inputs.repo, issue=inputs.issue, workspace=inputs.workspace)
    if task_kind == "review_pr":
        assert inputs.issue is not None
        assert pr is not None
        return persona.kickoff_pr_review(repo=inputs.repo, pr=pr, workspace=inputs.workspace)
    if task_kind == "handle_comment":
        assert inputs.issue is not None
        assert comment is not None
        issue_row = inputs.db.get_issue(issue_key(inputs.repo.full_name, inputs.issue.number))
        if issue_row is None:
            pr_status = "no PR opened yet"
        elif issue_row.pr_number is None:
            pr_status = "no PR opened yet"
        elif issue_row.state == "merged":
            pr_status = f"PR #{issue_row.pr_number} was merged"
        elif issue_row.state in ("closed", "abandoned"):
            pr_status = f"PR #{issue_row.pr_number} was closed without merge"
        else:
            pr_status = f"PR #{issue_row.pr_number} is open"
        if directive is not None:
            return persona.directive(
                repo=inputs.repo,
                issue=inputs.issue,
                workspace=inputs.workspace,
                comment=comment,
                directive=directive,
                pr_status=pr_status,
                pr_number=pr_number,
            )
        return persona.followup_comment(
            repo=inputs.repo,
            issue=inputs.issue,
            workspace=inputs.workspace,
            comment=comment,
            pr_status=pr_status,
            pr_number=pr_number,
            thread=thread,
        )
    if task_kind == "handle_review":
        assert review_payload is not None
        path = str(review_payload.get("path") or "")
        start = review_payload.get("start_line") or review_payload.get("line")
        end = review_payload.get("line") or review_payload.get("original_line")
        if isinstance(start, int) and isinstance(end, int) and start != end:
            line_range = f":L{start}-L{end}"
        elif isinstance(end, int):
            line_range = f":L{end}"
        else:
            line_range = ""
        body = str(review_payload.get("body") or "")
        author = str(review_payload.get("author") or "")
        return persona.followup_review(
            repo=inputs.repo,
            workspace=inputs.workspace,
            pr_number=int(pr_number or 0),
            comment_author=author,
            comment_body=body,
            comment_path=path,
            comment_line_range=line_range,
        )
    raise ValueError(f"unknown task kind: {task_kind!r}")


def _run_rpc_blocking(
    inputs: TaskInputs,
    *,
    task_kind: str,
    prompt: str,
    loop: asyncio.AbstractEventLoop,
    bindings: ToolBindings,
    directive: DirectiveInfo | None = None,
) -> str | None:
    """Run a full RPC turn synchronously. Returns final assistant text (or None)."""
    settings = inputs.settings

    tools_called: set[str] = set()

    def _on_tool_end(event: ToolExecutionEndEvent) -> None:
        tool_name = event.tool_name
        # `tool_name` is transport-normalized by omp_rpc: an xd:// device
        # dispatch (`write xd://submit_pr_review`) reports the host tool that
        # ran, so terminal-action detection can match on host-tool names. A
        # failed execution (`is_error`) does not count as reaching the
        # terminal action — a rejected submit must still trigger the
        # completion reminder.
        ok = event.result is not None and not event.is_error
        if ok:
            tools_called.add(tool_name)
        log.info(
            "tool_end",
            extra={
                "issue": bindings.issue_key,
                "tool": tool_name,
                "ok": ok,
            },
        )

    def _on_msg(event: MessageUpdateEvent) -> None:
        ev = event.assistant_message_event
        if isinstance(ev, dict) and ev.get("type") == "text_delta":
            log.debug("delta", extra={"issue": bindings.issue_key, "delta": str(ev.get("delta", ""))[:200]})

    rpc_env = _build_extra_env(settings)
    rpc_env.update(_prepare_slot_runtime_env(inputs.workspace, inputs.slot_uid))
    rpc_env.update(_safe_directory_env(bindings.workspace.repo_dir))
    rpc_env.update(_git_identity_env(inputs.settings.resolved_author_name, inputs.settings.git_author_email))
    # Bare worktrees have no node_modules; install (idempotently) so the agent
    # can resolve workspace packages (@oh-my-pi/pi-*) and actually run tests.
    host_tools.ensure_workspace_dependencies(bindings)
    resuming = _has_prior_session(bindings.workspace.session_dir)
    extra_args: tuple[str, ...] = ("--continue",) if resuming else ()
    log.info(
        "rpc_resume",
        extra={
            "issue": bindings.issue_key,
            "task": task_kind,
            "resuming": resuming,
            "session_dir": str(bindings.workspace.session_dir),
            "attempts": inputs.attempts,
        },
    )
    model_override, thinking_override = _resolve_pragma_overrides(directive, settings)
    chosen_model = model_override or (
        settings.pick_release_model() if task_kind == "handle_release_ci" else settings.pick_model()
    )
    chosen_thinking = thinking_override or settings.thinking_level
    log.info(
        "rpc_model_pick",
        extra={
            "issue": bindings.issue_key,
            "model": chosen_model,
            "pool": list(settings.release_model_pool if task_kind == "handle_release_ci" else settings.model_pool),
            "thinking": chosen_thinking,
            "pragma_model": model_override,
            "pragma_thinking": thinking_override,
        },
    )
    inputs.db.set_event_model(inputs.delivery_id, chosen_model)
    if task_kind == "handle_release_ci":
        assert inputs.release is not None
        append_system_prompt = persona.system_append_release(
            repo=inputs.repo,
            release=inputs.release,
            workspace=inputs.workspace,
            release_commit_prefix=inputs.settings.release_commit_prefix,
        )
    elif task_kind == "review_pr":
        assert inputs.issue is not None
        append_system_prompt = persona.system_append_pr_review(
            repo=inputs.repo,
            issue=inputs.issue,
            workspace=inputs.workspace,
            bot_login=inputs.settings.bot_login,
        )
    else:
        assert inputs.issue is not None
        append_system_prompt = persona.system_append(
            repo=inputs.repo,
            issue=inputs.issue,
            workspace=inputs.workspace,
            bot_login=inputs.settings.bot_login,
        )

    with RpcClient(
        executable=settings.omp_command,
        cwd=bindings.workspace.repo_dir,
        session_dir=bindings.workspace.session_dir,
        env=rpc_env,
        no_session=False,
        no_title=True,
        model=chosen_model,
        provider=settings.provider,
        thinking=chosen_thinking if chosen_thinking != "off" else None,
        append_system_prompt=append_system_prompt,
        custom_tools=host_tools.build(bindings),
        request_timeout=settings.request_timeout_seconds,
        startup_timeout=60.0,
        max_event_history=50_000,
        extra_args=extra_args,
        user=inputs.slot_uid,
        group=inputs.slot_uid if inputs.slot_uid is not None else None,
        extra_groups=["omp"] if inputs.slot_uid is not None else None,
    ) as client:
        # Arm cancellation: from this point the API can kill the omp subprocess
        # out from under us, which makes `prompt_and_wait` raise an `RpcError`
        # we'll let propagate. The `with` exit calls `client.stop()` again, but
        # it's idempotent.
        #
        # NOTE: omp_rpc.RpcClient.stop() has a bug where it sets `_stopping=True`
        # before the stdout reader loop notices the closed pipe, so the reader's
        # `if not self._stopping` guard skips `_mark_closed()` entirely.
        # `_wait_for_agent_end` then blocks on `_event_condition` until the hard
        # timeout because `_closed_error` is never set. We work around it here
        # by calling `_mark_closed()` ourselves after stop returns — this is
        # idempotent (it no-ops when `_closed_error` is already set).
        def _cancel_hook() -> None:
            try:
                client.stop()
            finally:
                # Private API, but the only way to unblock `_wait_for_agent_end`
                # without waiting for the request timeout. Idempotent.
                client._mark_closed(  # noqa: SLF001
                    RpcProcessExitError("cancelled by operator")
                )

        if bindings.abort is not None:
            bindings.abort.stop = _cancel_hook
        register_cancel_hook(_cancel_hook)
        try:
            client.install_headless_ui()
            client.on_tool_execution_end(_on_tool_end)
            client.on_message_update(_on_msg)

            phases = persona.seed_phases(task_kind)
            if phases:
                try:
                    if task_kind in ("triage_issue", "review_pr") and not resuming:
                        # Fresh kickoff tasks seed the full plan.
                        client.set_todos(phases)
                    elif task_kind in ("triage_issue", "review_pr"):
                        # Resumed kickoff tasks keep prior todo state from the
                        # JSONL transcript; re-seeding would clobber progress.
                        log.info(
                            "set_todos skipped (resume)",
                            extra={"issue": bindings.issue_key, "task": task_kind},
                        )
                    else:
                        # Follow-up: keep prior phases (e.g. Reproduce / Fix / PR)
                        # so the agent still sees the context, but append the
                        # follow-up phase at the end.
                        existing = list(client.get_todos())
                        merged = [
                            {
                                "id": p.id,
                                "name": p.name,
                                "tasks": [
                                    {
                                        "id": t.id,
                                        "content": t.content,
                                        "status": t.status,
                                        "notes": t.notes,
                                        "details": t.details,
                                        "blocker": t.blocker,
                                    }
                                    for t in p.tasks
                                ],
                            }
                            for p in existing
                        ] + phases
                        client.set_todos(merged)
                except RpcError as exc:
                    log.warning("set_todos failed", extra={"err": str(exc)})

            log.info(
                "rpc_start",
                extra={"issue": bindings.issue_key, "task": task_kind, "branch": bindings.workspace.branch},
            )
            hard_timeout_seconds = _task_timeout(settings, task_kind) + settings.task_timeout_hard_grace_seconds
            hard_timeout_fired = threading.Event()

            def _hard_stop() -> None:
                hard_timeout_fired.set()
                log.warning(
                    "rpc_hard_timeout",
                    extra={"issue": bindings.issue_key, "task": task_kind, "timeout": hard_timeout_seconds},
                )
                try:
                    _cancel_hook()
                except Exception:
                    log.exception(
                        "rpc hard timeout stop failed", extra={"issue": bindings.issue_key, "task": task_kind}
                    )

            hard_timer = threading.Timer(hard_timeout_seconds, _hard_stop)
            hard_timer.daemon = True
            hard_timer.start()
            try:
                turn = _drive_turn(
                    client,
                    prompt,
                    task_kind=task_kind,
                    inputs=inputs,
                    bindings=bindings,
                    tools_called=tools_called,
                )
                if turn is None:
                    return None
            finally:
                hard_timer.cancel()
            if hard_timeout_fired.is_set():
                raise TimeoutError("omp task exceeded hard timeout")
            if turn is not None and turn.assistant_message is not None:
                stop_reason = turn.assistant_message.get("stopReason")
                if stop_reason == "error":
                    error_msg = turn.assistant_message.get("errorMessage") or "model returned error"
                    raise RuntimeError(f"omp agent error (stopReason=error): {error_msg}")
            log.info(
                "rpc_done",
                extra={
                    "issue": bindings.issue_key,
                    "task": task_kind,
                    "messages": len(turn.messages),
                    "events": len(turn.events),
                },
            )
            return turn.assistant_text
        finally:
            unregister_cancel_hook()


async def run_task(
    *,
    task_kind: str,
    inputs: TaskInputs,
    comment: CommentInfo | None = None,
    pr_number: int | None = None,
    review_payload: dict[str, Any] | None = None,
    pr: PullRequestInfo | None = None,
    directive: DirectiveInfo | None = None,
    thread: tuple[ThreadMessage, ...] = (),
) -> str | None:
    """Async wrapper that runs the synchronous RPC driver on a worker thread."""
    review_mode = task_kind == "review_pr" or inputs.workspace.branch.startswith("review/pr-")
    loop = asyncio.get_running_loop()
    release_binding: ReleaseToolContext | None = None
    if inputs.release is not None:
        release_key = f"{inputs.repo.full_name}#{inputs.release.tag}"
        release_row = inputs.db.get_release(release_key)
        if release_row is None:
            raise RuntimeError(f"release state missing for {release_key}")
        release_binding = ReleaseToolContext(
            repo=inputs.repo.full_name,
            tag=inputs.release.tag,
            version=inputs.release.version,
            key=release_key,
            expected_sha=release_row.current_sha,
            default_branch=inputs.release.default_branch,
        )
    bindings = ToolBindings(
        db=inputs.db,
        github=inputs.github,
        git_transport=inputs.git_transport,
        repo=inputs.repo,
        issue=inputs.issue,
        workspace=inputs.workspace,
        loop=loop,
        settings=inputs.settings,
        author_name=inputs.settings.resolved_author_name,
        author_email=inputs.settings.git_author_email,
        inbound_thread_number=pr_number,
        inbound_is_pr=pr_number is not None,
        review_mode=review_mode,
        impl_authorized=bool(directive is not None and directive.authorizes_impl),
        slot_uid=inputs.slot_uid,
        abort=AbortController(),
        release=release_binding,
    )
    resuming = _has_prior_session(inputs.workspace.session_dir)
    prompt = _build_prompt(
        task_kind,
        inputs,
        comment=comment,
        pr_number=pr_number,
        review_payload=review_payload,
        pr=pr,
        directive=directive,
        thread=thread,
        resuming=resuming,
    )
    try:
        result = await asyncio.to_thread(
            _run_rpc_blocking,
            inputs,
            task_kind=task_kind,
            prompt=prompt,
            loop=loop,
            bindings=bindings,
            directive=directive,
        )
    except BaseException:
        # Failed/aborted task: NEVER capture, the artifacts may be inconsistent
        # with the source state and would poison the cache.
        raise
    else:
        await asyncio.to_thread(_capture_natives_cache, inputs)
        return result


def _capture_natives_cache(inputs: TaskInputs) -> None:
    """Best-effort: store the workspace's fresh natives under its current key.
    Runs after a successful task on a worker thread. ANY failure is logged
    and swallowed — cache errors NEVER fail a task.
    """
    cache = inputs.natives_cache
    if cache is None:
        return
    workspace = inputs.workspace
    native_dir = workspace.repo_dir / "packages" / "natives" / "native"
    if not native_dir.exists():
        return
    try:
        key = natives_compute_key(workspace.repo_dir)
    except Exception as exc:
        log.debug(
            "natives_cache capture key compute failed",
            extra={"workspace": workspace.workspace_key, "err": str(exc)},
        )
        return
    try:
        stored = cache.capture(
            workspace.repo_full_name,
            key,
            native_dir,
            source_workspace=workspace.workspace_key,
        )
    except Exception as exc:
        log.warning(
            "natives_cache capture failed",
            extra={"workspace": workspace.workspace_key, "key": key, "err": str(exc)},
        )
        return
    log.info(
        "natives_cache",
        extra={
            "action": "stored" if stored is not None else "skip",
            "workspace": workspace.workspace_key,
            "repo": workspace.repo_full_name,
            "key": key,
            "cache_dir": str(stored) if stored else None,
        },
    )


__all__ = ["DirectiveInfo", "ReleaseTaskContext", "TaskInputs", "ThreadMessage", "run_task"]
